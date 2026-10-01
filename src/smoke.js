import * as THREE from 'three';
import { NOISE, AERIAL } from './glsl.js';
import { shared } from './shared.js';
import { KIND } from './particles.js';
import { prof } from './prof.js';

// Particle-driven volumetric exhaust / steam.
//
// 1. splat : the CPU-simulated smoke particles are rasterised into a 3D volume
//            (R = steam density, G = incandescent heat, B = dust). The volume is a 2D
//            atlas of Y-slices, so all slices are splatted in one instanced draw.
// 2. light : for every (half-res) voxel, optical depth toward the sun and toward
//            the engine fire, plus a local occlusion term (one draw into a second atlas).
// 3. march : full-screen ray march through the volume with Perlin-Worley erosion
//            for the cauliflower detail, Beer + multiple-scattering octaves,
//            fire emission and scene-depth occlusion. The result is split into the
//            part in front of the engine plume and the part behind it (MRT) so the
//            plume composites between them.

export const VOL = { nx: 128, ny: 64, nz: 128, cell: 12.5, ox: -800, oy: -4, oz: -800 };
VOL.sx = VOL.nx * VOL.cell; VOL.sy = VOL.ny * VOL.cell; VOL.sz = VOL.nz * VOL.cell;

export function insideVolume(x, y, z, margin = 0) {
  return x > VOL.ox + margin && x < VOL.ox + VOL.sx - margin && y < VOL.oy + VOL.sy - margin && z > VOL.oz + margin && z < VOL.oz + VOL.sz - margin;
}

const _c = new THREE.Color();
const FS_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const SPLAT_K = 20; // max slices one puff can span (radius < (K - 1) * cell / 2)

// trilinear fetch from a slice atlas: n = voxels (x, y, z), tiles = slices per atlas row/column
const VOL_TEX = /* glsl */ `
vec4 volTex(sampler2D tex, vec3 u, vec3 n, vec2 tiles) {
  float fy = clamp(u.y * n.y - 0.5, 0.0, n.y - 1.0);
  float j0 = floor(fy), j1 = min(j0 + 1.0, n.y - 1.0);
  vec2 h = 0.5 / n.xz;
  vec2 xz = clamp(u.xz, h, 1.0 - h);
  vec4 a = texture(tex, (vec2(mod(j0, tiles.x), floor(j0 / tiles.x)) + xz) / tiles);
  vec4 b = texture(tex, (vec2(mod(j1, tiles.x), floor(j1 / tiles.x)) + xz) / tiles);
  return mix(a, b, fy - j0);
}
`;
function atlasRT(nx, ny, nz, tx) {
  const rt = new THREE.WebGLRenderTarget(nx * tx, nz * (ny / tx), { type: THREE.HalfFloatType, depthBuffer: false });
  rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.generateMipmaps = false;
  rt.tiles = new THREE.Vector2(tx, ny / tx);
  rt.grid = new THREE.Vector3(nx, ny, nz);
  return rt;
}

export class SmokeVolume {
  constructor(renderer, noiseTex, max = 20000) {
    this.renderer = renderer;
    this.max = max;
    const { nx, ny, nz } = VOL;
    this.dens = atlasRT(nx, ny, nz, 8);           // 8 x 8 slices of 128 x 128
    this.lnx = nx / 2; this.lny = ny / 2; this.lnz = nz / 2;
    this.light = atlasRT(this.lnx, this.lny, this.lnz, 8); // 8 x 4 slices of 64 x 64
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.dirty = true;

    // --------------------------------------------------------------- splat
    // one instance per puff, SPLAT_K quads per instance: quad k lands in the k-th slice the
    // sphere overlaps (unused quads are culled in the vertex shader)
    const quad = new THREE.InstancedBufferGeometry();
    const pos = [], ks = [], idx = [];
    for (let k = 0; k < SPLAT_K; k++) {
      pos.push(-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0);
      ks.push(k, k, k, k);
      idx.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3);
    }
    quad.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    quad.setAttribute('aK', new THREE.Float32BufferAttribute(ks, 1));
    quad.setIndex(idx);
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); // x y z r
    this.aD = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); // dens heat dust seed
    this.aP.setUsage(THREE.DynamicDrawUsage); this.aD.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('aP', this.aP); quad.setAttribute('aD', this.aD);
    quad.instanceCount = 0;
    this.splatGeo = quad;
    this.splatMat = new THREE.ShaderMaterial({
      uniforms: {
        uOrigin: { value: new THREE.Vector3(VOL.ox, VOL.oy, VOL.oz) }, uSize: { value: new THREE.Vector3(VOL.sx, VOL.sy, VOL.sz) },
        uCell: { value: VOL.cell }, uTiles: { value: this.dens.tiles }, uGrid: { value: this.dens.grid },
      },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      vertexShader: /* glsl */ `
        attribute vec4 aP, aD;
        attribute float aK;
        uniform float uCell; uniform vec3 uOrigin, uSize, uGrid; uniform vec2 uTiles;
        varying vec2 vC, vT; varying vec4 vD; varying float vR;
        void main() {
          float r = aP.w;
          float j = floor((aP.y - r - uOrigin.y) / uCell - 0.5) + 1.0 + aK; // k-th slice above the sphere's bottom
          float dy = uOrigin.y + (j + 0.5) * uCell - aP.y;
          float rs2 = r * r - dy * dy;
          if (rs2 <= 0.0 || j < 0.0 || j >= uGrid.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float rs = sqrt(rs2);
          vec2 c = position.xy;
          vec2 w = aP.xz + c * rs;
          vT = (w - uOrigin.xz) / uSize.xz;    // position inside the slice tile
          vC = c * rs / r;                     // normalised 3D radius in the slice plane
          vR = dy / r;
          vD = aD;
          vec2 tile = vec2(mod(j, uTiles.x), floor(j / uTiles.x));
          gl_Position = vec4((tile + vT) / uTiles * 2.0 - 1.0, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vC, vT; varying vec4 vD; varying float vR;
        void main() {
          if (any(lessThan(vT, vec2(0.0))) || any(greaterThan(vT, vec2(1.0)))) discard; // stay inside the tile
          float q = 1.0 - (dot(vC, vC) + vR * vR);
          if (q <= 0.0) discard;
          float k = q * q;
          gl_FragColor = vec4(vD.x * k, vD.y * k, vD.z * k, 0.0);
        }`,
    });
    this.splatMesh = new THREE.Mesh(quad, this.splatMat);
    this.splatMesh.frustumCulled = false;
    this.splatScene = new THREE.Scene();
    this.splatScene.add(this.splatMesh);

    // --------------------------------------------------------------- light
    this.lightMat = new THREE.ShaderMaterial({
      uniforms: {
        uDens: { value: this.dens.texture }, uSunDir: shared.uSunDir, uFlamePos: shared.uFlamePos,
        uOrigin: { value: new THREE.Vector3(VOL.ox, VOL.oy, VOL.oz) }, uSize: { value: new THREE.Vector3(VOL.sx, VOL.sy, VOL.sz) },
        uDGrid: { value: this.dens.grid }, uDTiles: { value: this.dens.tiles },
        uLGrid: { value: this.light.grid }, uLTiles: { value: this.light.tiles }, uCell: { value: VOL.cell }, uRows: { value: 1 },
      },
      depthTest: false, depthWrite: false,
      // only the atlas rows holding slices up to the smoke top are drawn
      vertexShader: 'uniform float uRows; void main(){ gl_Position = vec4(position.x, (position.y + 1.0) * uRows - 1.0, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D uDens;
        uniform float uCell;
        uniform vec3 uSunDir, uFlamePos, uOrigin, uSize, uDGrid, uLGrid;
        uniform vec2 uDTiles, uLTiles;
        ${VOL_TEX}
        float D(vec3 p) {
          vec3 u = (p - uOrigin) / uSize;
          if (any(lessThan(u, vec3(0.0))) || any(greaterThan(u, vec3(1.0)))) return 0.0;
          return min(volTex(uDens, u, uDGrid, uDTiles).r, 3.0);
        }
        void main() {
          vec2 tile = floor(gl_FragCoord.xy / uLGrid.xz);
          vec2 uv = (gl_FragCoord.xy - tile * uLGrid.xz) / uLGrid.xz;
          float j = tile.y * uLTiles.x + tile.x;
          vec3 p = vec3(uOrigin.x + uv.x * uSize.x, uOrigin.y + (j + 0.5) * uCell * 2.0, uOrigin.z + uv.y * uSize.z);
          float od = 0.0;
          float st = 9.0;
          vec3 q = p;
          for (int i = 0; i < 24; i++) { q += uSunDir * st; od += D(q) * st; st *= 1.09; }
          // toward the engine fire
          vec3 tf = uFlamePos - p;
          float df = length(tf);
          float odf = 0.0;
          float n = clamp(df / 14.0, 1.0, 24.0);
          for (int i = 1; i < 24; i++) { if (float(i) >= n) break; odf += D(p + tf * (float(i) / n)) * (df / n); }
          // local occlusion (sky visibility), weighted upward
          float o = 0.0;
          o += D(p + vec3(0.0, 20.0, 0.0)) * 1.4 + D(p + vec3(0.0, 45.0, 0.0)) * 1.0;
          o += D(p + vec3(25.0, 5.0, 0.0)) + D(p + vec3(-25.0, 5.0, 0.0)) + D(p + vec3(0.0, 5.0, 25.0)) + D(p + vec3(0.0, 5.0, -25.0));
          gl_FragColor = vec4(od, odf, o, 1.0);
        }`,
    });
    this.lightQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.lightMat);
    this.lightQuad.frustumCulled = false;
    this.lightScene = new THREE.Scene();
    this.lightScene.add(this.lightQuad);

    // --------------------------------------------------------------- march
    this.uniforms = {
      ...shared,
      uDens: { value: this.dens.texture }, uLight: { value: this.light.texture }, uNoise: { value: noiseTex },
      uDGrid: { value: this.dens.grid }, uDTiles: { value: this.dens.tiles }, uLGrid: { value: this.light.grid }, uLTiles: { value: this.light.tiles },
      uOrigin: { value: new THREE.Vector3(VOL.ox, VOL.oy, VOL.oz) }, uSize: { value: new THREE.Vector3(VOL.sx, VOL.sy, VOL.sz) },
      uDepth: { value: null }, uLogFar: { value: Math.log2(2e6 + 1) }, uRes: { value: new THREE.Vector2(1, 1) },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamFwd: { value: new THREE.Vector3() },
      uSteps: { value: 96 }, uSimTime: { value: 0 }, uBoxMin: { value: new THREE.Vector3() }, uBoxMax: { value: new THREE.Vector3() },
      uPlumeO: { value: new THREE.Vector3() }, uPlumeD: { value: new THREE.Vector3(0, -1, 0) }, uPlumeL: { value: 0 }, uPlumeLevel: { value: 0 },
      uWind: { value: new THREE.Vector3(-3.2, 0, -2.4) },
    };
    this.marchMain = this.makeMarch(false);
    this.marchRefl = this.makeMarch(true);
    this.marchQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.marchMain);
    this.marchQuad.frustumCulled = false;
    this.marchScene = new THREE.Scene();
    this.marchScene.add(this.marchQuad);

    // composites into the transparent pass: back (behind plume) and front
    this.compBack = this.makeComposite(0, 15);
    this.compFront = this.makeComposite(1, 25);
    this.rt = null;
    this.active = false;
  }

  makeComposite(index, order) {
    const u = { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } };
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: u, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tSrc, vUv) * 0.36;
          c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.35)) * 0.16;
          c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -0.35)) * 0.16;
          c += texture2D(tSrc, vUv + uTexel * vec2(-0.35, 1.0)) * 0.16;
          c += texture2D(tSrc, vUv + uTexel * vec2(0.35, -1.0)) * 0.16;
          if (c.a < 0.001) discard;
          gl_FragColor = c;
        }`,
    }));
    m.frustumCulled = false;
    m.renderOrder = order;
    m.userData.u = u;
    m.userData.index = index;
    return m;
  }

  makeMarch(reflection) {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      defines: reflection ? { REFLECTION: 1 } : {},
      depthTest: reflection, depthWrite: false, transparent: true,
      depthFunc: THREE.LessEqualDepth,
      blending: reflection ? THREE.CustomBlending : THREE.NoBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      vertexShader: 'out vec2 vNdc; void main(){ vNdc = position.xy; gl_Position = vec4(position.xy, 1.0, 1.0); }',
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler3D;
        in vec2 vNdc;
        #ifdef REFLECTION
          layout(location = 0) out vec4 outColor;
        #else
          layout(location = 0) out vec4 outBack;
          layout(location = 1) out vec4 outFront;
        #endif
        uniform sampler3D uNoise;
        uniform sampler2D uDens, uLight, uDepth;
        uniform vec3 uDGrid, uLGrid;
        uniform vec2 uDTiles, uLTiles;
        ${VOL_TEX}
        uniform float uLogFar, uSimTime;
        uniform vec2 uRes;
        uniform vec3 uOrigin, uSize, uCamFwd, uWind, uBoxMin, uBoxMax;
        uniform mat4 uInvProj, uCamWorld;
        uniform int uSteps;
        uniform vec3 uSunColor, uSkyAmb, uGroundAmb, uFlamePos, uFlameColor;
        uniform vec3 uPlumeO, uPlumeD;
        uniform float uPlumeL, uPlumeLevel;
        ${NOISE}
        ${AERIAL}
        vec2 box(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
          vec3 inv = 1.0 / rd;
          vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
          vec3 tn = min(t0, t1), tf = max(t0, t1);
          return vec2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
        }
        float hg(float mu, float g) { float gg = g * g; return (1.0 - gg) / (12.566 * pow(1.0 + gg - 2.0 * g * mu, 1.5)); }
        float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
        vec3 bbColor(float T) {
          T = clamp(T, 800.0, 12000.0) / 100.0;
          vec3 c;
          c.r = T <= 66.0 ? 1.0 : clamp(1.292936 * pow(T - 60.0, -0.1332047), 0.0, 1.0);
          c.g = T <= 66.0 ? clamp(0.3900816 * log(T) - 0.6318414, 0.0, 1.0) : clamp(1.1298909 * pow(T - 60.0, -0.0755148), 0.0, 1.0);
          c.b = T >= 66.0 ? 1.0 : (T <= 19.0 ? 0.0 : clamp(0.5432068 * log(T - 10.0) - 1.1962541, 0.0, 1.0));
          return pow(c, vec3(2.2));
        }
        // incandescent gas: heat fraction -> temperature -> blackbody colour & ~T^4 radiance
        vec3 fireEmission(float heat) {
          float T = 850.0 + 1700.0 * clamp(heat, 0.0, 1.4);
          float k = T / 1800.0;
          return bbColor(T) * k * k * k * k;
        }
        void main() {
          vec4 vp = uInvProj * vec4(vNdc, 1.0, 1.0);
          vec3 rd = normalize(mat3(uCamWorld) * normalize(vp.xyz / vp.w));
          vec3 ro = cameraPosition;
          vec2 tb = box(ro, rd, uBoxMin, uBoxMax);
          tb.x = max(tb.x, 0.0);
          float tMax = tb.y;
          #ifndef REFLECTION
            float d = texture(uDepth, gl_FragCoord.xy / uRes).x;
            float sceneZ = exp2(d * uLogFar) - 1.0;
            tMax = min(tMax, sceneZ / max(dot(rd, uCamFwd), 1e-3));
          #endif
          if (tMax <= tb.x) {
            #ifdef REFLECTION
              discard;
            #else
              outBack = vec4(0.0); outFront = vec4(0.0); return;
            #endif
          }
          // closest approach of the ray to the plume axis (split point)
          float tSplit = 1e9;
          if (uPlumeL > 0.0) {
            vec3 w0 = ro - uPlumeO;
            float b = dot(rd, uPlumeD), dd = dot(rd, w0), e = dot(uPlumeD, w0);
            float den = 1.0 - b * b;
            if (den > 1e-5) {
              float s = clamp((b * dd - e) / den * -1.0, 0.0, uPlumeL);
              s = clamp((e - b * dd) / den, 0.0, uPlumeL);
              vec3 pa = uPlumeO + uPlumeD * s;
              tSplit = max(dot(pa - ro, rd), 0.0);
            }
          }
          float len = tMax - tb.x;
          float n = float(uSteps);
          float stepL = clamp(len / n, 1.8, 14.0);
          float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float t = tb.x + stepL * jit;
          float mu = dot(rd, uSunDir);
          float phase = mix(hg(mu, 0.62), hg(mu, -0.25), 0.3);
          const float SIGMA = 0.075;
          vec3 colF = vec3(0.0), colB = vec3(0.0);
          float T = 1.0, TF = 1.0;
          float tw = 0.0, ws = 0.0;
          vec3 adv = uWind * uSimTime * 0.8 + vec3(0.0, uSimTime * 2.0, 0.0);
          for (int i = 0; i < 200; i++) {
            if (i >= uSteps || t > tMax || T < 0.01) break;
            vec3 p = ro + rd * t;
            vec3 u = (p - uOrigin) / uSize;
            vec4 v = volTex(uDens, u, uDGrid, uDTiles);
            float base = v.r;
            if (base > 0.004) {
              // fractal erosion: big billows -> lobes -> small cauliflower curls
              vec3 q = (p - adv) / 110.0;
              vec4 nz = texture(uNoise, q);
              float billow = nz.r * 0.5 + (nz.g * 0.625 + nz.b * 0.25 + nz.a * 0.125) * 0.5;
              vec4 nz2 = texture(uNoise, q * 3.9 + vec3(0.31, 0.17, 0.73));
              float lobe = nz2.g * 0.6 + nz2.b * 0.4;
              vec4 nz3 = texture(uNoise, q * 14.0 + vec3(0.7, 0.11, 0.37));
              float curl = nz3.g * 0.6 + nz3.a * 0.4;
              float dn = clamp(base, 0.0, 2.5);
              float cov = 1.0 - exp(-dn * 1.5);                 // how "inside" we are
              float er = billow * 0.55 + lobe * 0.3 + curl * 0.15;
              float edge = cov - (1.0 - er) * 1.05;
              float dens = smoothstep(0.0, 0.06, edge) * (0.6 + dn * 0.8);
              if (dens > 0.001) {
                vec4 L = volTex(uLight, u, uLGrid, uLTiles);
                float odS = L.r * SIGMA;
                float odF = L.g * SIGMA;
                float occ = L.b;
                // sun: single scattering + two softer multiple-scattering octaves
                float beer = exp(-odS) + 0.42 * exp(-odS * 0.25) + 0.12 * exp(-odS * 0.06);
                float powder = 1.0 - exp(-dens * 2.0);
                // small-scale self shadowing: compare the erosion field one step toward the sun
                vec3 po = (p + uSunDir * 7.0 - adv) / 110.0;
                vec4 o2 = texture(uNoise, po * 3.9 + vec3(0.31, 0.17, 0.73));
                vec4 o3 = texture(uNoise, po * 14.0 + vec3(0.7, 0.11, 0.37));
                float erO = billow * 0.55 + (o2.g * 0.6 + o2.b * 0.4) * 0.3 + (o3.g * 0.6 + o3.a * 0.4) * 0.15;
                float selfSh = clamp(1.0 - (erO - er) * 6.0, 0.28, 1.25);
                vec3 sunL = uSunColor * beer * phase * mix(0.6, 1.0, powder) * 3.14159 * 0.9 * selfSh;
                // sky & ground ambient; shaded areas take the blue sky colour
                float hN = clamp((p.y - uOrigin.y) / 450.0, 0.0, 1.0);
                vec3 amb = mix(uGroundAmb * 0.9 + uSkyAmb * 1.2, uSkyAmb * 2.6, 0.3 + 0.7 * hN) * (0.3 + 0.7 * exp(-occ * 0.45)) * (0.65 + 0.35 * curl);
                // engine fire lighting the steam from below/inside
                vec3 tf = uFlamePos - p;
                float df2 = dot(tf, tf);
                // the luminous plume is a line source: fall-off from the nearest point of its
                // axis (the transmittance still comes from the light volume, toward uFlamePos)
                float dl2 = df2;
                if (uPlumeL > 0.0) {
                  vec3 wq = p - uPlumeO;
                  vec3 ql = wq - uPlumeD * clamp(dot(wq, uPlumeD), 0.0, uPlumeL);
                  dl2 = min(df2, dot(ql, ql) + 400.0);
                }
                vec3 fl = uFlameColor * (exp(-odF) + 0.3 * exp(-odF * 0.2)) / (dl2 + 1600.0) * 1.4;
                vec3 alb = mix(vec3(0.97, 0.97, 0.97), vec3(0.62, 0.54, 0.46), clamp(v.b / max(base, 1e-3), 0.0, 1.0));
                vec3 S = alb * (sunL + amb + fl);
                // incandescence of the hot exhaust core
                float heat = v.g / max(base, 0.05);
                // flame -> smoke gradient: hot exhaust glows by its temperature and fades into steam
                S += fireEmission(heat) * min(v.g, 1.5) * 90.0 * (0.5 + 1.0 * lobe);
                // fire & plume impingement glowing inside the steam near the base
                float dfl = sqrt(df2);
                S += uFlameColor * 2.2e-4 * exp(-dfl / 26.0) * (0.5 + 0.5 * lobe);
                // the impingement fireball: burning/ incandescent exhaust spreading under the mount
                float fb = exp(-dfl / 20.0) * smoothstep(60.0, 5.0, p.y);
                S += fireEmission(0.8 + 0.5 * lobe) * fb * length(uFlameColor) * 1.6e-4;
                if (uPlumeL > 0.0) {
                  vec3 w = p - uPlumeO;
                  float sp = clamp(dot(w, uPlumeD), 0.0, uPlumeL);
                  float dax = length(w - uPlumeD * sp);
                  float g = exp(-dax / 9.0) * exp(-sp / (uPlumeL * 0.8));
                  S += mix(vec3(1.0, 0.45, 0.16), vec3(1.0, 0.7, 0.55), exp(-sp / 25.0)) * g * uPlumeLevel * 22.0;
                }
                float a = 1.0 - exp(-dens * SIGMA * 1.4 * stepL);
                vec3 c = S * a;
                if (t < tSplit) { colF += T * c; TF *= 1.0 - a; }
                else colB += T * c;
                tw += t * T * a; ws += T * a;
                T *= 1.0 - a;
              }
            }
            t += stepL * (base > 0.004 ? 1.0 : 3.0);
          }
          float aTot = 1.0 - T;
          if (aTot < 0.002) {
            #ifdef REFLECTION
              discard;
            #else
              outBack = vec4(0.0); outFront = vec4(0.0); return;
            #endif
          }
          vec3 wp = ro + rd * (tw / max(ws, 1e-4));
          vec3 Ta = aerialT(wp, ro);
          vec3 ins = applyAerial(vec3(0.0), wp, ro);   // air-light only
          float aF = 1.0 - TF;
          float aB = aTot - aF;                         // coverage behind the split, seen through the front part
          #ifdef REFLECTION
            outColor = vec4((colF + colB) * Ta + ins * aTot, aTot);
            float w = dot(wp - ro, uCamFwd);
            gl_FragDepth = log2(1.0 + max(w, 0.1)) / uLogFar;
          #else
            outFront = vec4(colF * Ta + ins * aF, aF);
            // back part is composited first, under the plume; un-premultiply the front occlusion
            outBack = vec4((colB * Ta + ins * aB) / max(TF, 0.02), aB / max(TF, 0.02));
          #endif
        }`,
    });
  }

  setSize(w, h) {
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), { count: 2, type: THREE.HalfFloatType, depthBuffer: false });
    for (const tex of this.rt.textures) { tex.minFilter = tex.magFilter = THREE.LinearFilter; }
    this.compBack.userData.u.tSrc.value = this.rt.textures[0];
    this.compFront.userData.u.tSrc.value = this.rt.textures[1];
    for (const m of [this.compBack, this.compFront]) m.userData.u.uTexel.value.set(1 / this.rt.width, 1 / this.rt.height);
  }

  /** Upload the smoke particles that live inside the volume. */
  gather(ps) {
    const P = this.aP.array, D = this.aD.array;
    let n = 0;
    const minR = VOL.cell * 1.25, maxR = (SPLAT_K - 1) * VOL.cell * 0.5;
    let rMax = 0;
    for (let i = 0; i < ps.count && n < this.max; i++) {
      if (ps.kind[i] !== KIND.SMOKE) continue;
      const x = ps.p[i * 3], y = ps.p[i * 3 + 1], z = ps.p[i * 3 + 2];
      if (!insideVolume(x, y, z, 20)) continue;
      const op = ps.op[i];
      if (op < 0.003) continue;
      let r = ps.size[i] * 1.15;
      let m = op * ps.dens[i] * 0.9;
      if (r < minR) { m *= (r / minR) ** 3; r = minR; } // conserve mass for sub-voxel puffs
      if (r > maxR) r = maxR;
      if (r > rMax) rMax = r;
      // gas temperature above ambient; the glowing core cools by mixing within ~1-2 s
      const hot = ps.hot[i] > 0 ? Math.max(0, (ps.hot[i] * Math.exp(-ps.age[i] / (ps.heatT ? ps.heatT[i] : 1.2)) - 350) / 1400) : 0;
      P[n * 4] = x; P[n * 4 + 1] = y; P[n * 4 + 2] = z; P[n * 4 + 3] = r;
      D[n * 4] = m; D[n * 4 + 1] = m * hot; D[n * 4 + 2] = m * ps.tint[i]; D[n * 4 + 3] = ps.seed[i];
      n++;
    }
    this.splatGeo.instanceCount = n;
    // draw only as many slice quads per puff as the largest puff needs
    this.splatGeo.setDrawRange(0, Math.min(SPLAT_K, Math.floor((2 * rMax) / VOL.cell) + 2) * 6);
    this.aP.clearUpdateRanges(); this.aP.addUpdateRange(0, Math.max(1, n) * 4); this.aP.needsUpdate = true;
    this.aD.clearUpdateRanges(); this.aD.addUpdateRange(0, Math.max(1, n) * 4); this.aD.needsUpdate = true;
    this.count = n;
    // tight bounds of the smoke (skip empty slices, shorten rays)
    let top = -1e9;
    const bmin = [1e9, 1e9, 1e9], bmax = [-1e9, -1e9, -1e9];
    for (let k = 0; k < n; k++) {
      const r = P[k * 4 + 3] * 0.9;
      for (let a = 0; a < 3; a++) { bmin[a] = Math.min(bmin[a], P[k * 4 + a] - r); bmax[a] = Math.max(bmax[a], P[k * 4 + a] + r); }
    }
    top = bmax[1];
    this.top = top;
    this.uniforms.uBoxMin.value.set(Math.max(VOL.ox, bmin[0]), Math.max(VOL.oy, bmin[1]), Math.max(VOL.oz, bmin[2]));
    this.uniforms.uBoxMax.value.set(Math.min(VOL.ox + VOL.sx, bmax[0]), Math.min(VOL.oy + VOL.sy, bmax[1]), Math.min(VOL.oz + VOL.sz, bmax[2]));
    this.active = n > 0;
    return n;
  }

  build() {
    const r = this.renderer;
    if (!this.active && !this.dirty) return; // volumes already empty
    const prevClear = r.getClearColor(_c), prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    prof.begin('smoke.splat');
    r.setRenderTarget(this.dens);
    r.clear();
    if (this.active) r.render(this.splatScene, this.cam);
    prof.end();
    prof.begin('smoke.light');
    r.setRenderTarget(this.light);
    r.clear();
    if (this.active) {
      const topSlice = Math.min(VOL.ny, Math.ceil((this.top - VOL.oy) / VOL.cell) + 1);
      const lTop = Math.min(this.lny - 1, Math.ceil(topSlice / 2) + 2);
      this.lightMat.uniforms.uRows.value = Math.ceil((lTop + 1) / this.light.tiles.x) / this.light.tiles.y;
      r.render(this.lightScene, this.cam);
    }
    prof.end();
    this.dirty = this.active;
    r.setClearColor(prevClear, prevAlpha);
  }

  render(camera, depthTex, plumeAxis, simTime) {
    const u = this.uniforms;
    u.uDepth.value = depthTex;
    u.uRes.value.set(this.rt.width, this.rt.height);
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    camera.getWorldDirection(u.uCamFwd.value);
    u.uSimTime.value = simTime;
    if (plumeAxis && plumeAxis.visible) {
      u.uPlumeO.value.copy(plumeAxis.origin); u.uPlumeD.value.copy(plumeAxis.dir); u.uPlumeL.value = plumeAxis.length; u.uPlumeLevel.value = plumeAxis.level ?? 1;
    } else u.uPlumeL.value = 0;
    this.marchQuad.material = this.marchMain;
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    if (this.active) r.render(this.marchScene, camera);
  }

  renderReflection(camera) {
    if (!this.active) return;
    const u = this.uniforms;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    camera.getWorldDirection(u.uCamFwd.value);
    this.marchQuad.material = this.marchRefl;
    const r = this.renderer;
    const ac = r.autoClear;
    r.autoClear = false;
    const steps = u.uSteps.value;
    u.uSteps.value = Math.max(32, Math.round(steps * 0.45));
    r.render(this.marchScene, camera);
    u.uSteps.value = steps;
    r.autoClear = ac;
    this.marchQuad.material = this.marchMain;
  }
}
