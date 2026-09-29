import * as THREE from 'three';
import { NOISE, AERIAL } from './glsl.js';
import { shared } from './shared.js';
import { KIND } from './particles.js';

// Particle-driven volumetric exhaust / steam.
//
// 1. splat : the CPU-simulated smoke particles are rasterised into a 3D volume
//            (R = steam density, G = incandescent heat, B = dust) one Y-slice at a time.
// 2. light : for every (half-res) voxel, optical depth toward the sun and toward
//            the engine fire, plus a local occlusion term.
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

const FS_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

export class SmokeVolume {
  constructor(renderer, noiseTex, max = 20000) {
    this.renderer = renderer;
    this.max = max;
    const { nx, ny, nz } = VOL;
    this.dens = new THREE.WebGL3DRenderTarget(nx, nz, ny, { type: THREE.HalfFloatType, depthBuffer: false });
    this.dens.texture.minFilter = this.dens.texture.magFilter = THREE.LinearFilter;
    this.dens.texture.wrapS = this.dens.texture.wrapT = this.dens.texture.wrapR = THREE.ClampToEdgeWrapping;
    this.lnx = nx / 2; this.lny = ny / 2; this.lnz = nz / 2;
    this.light = new THREE.WebGL3DRenderTarget(this.lnx, this.lnz, this.lny, { type: THREE.HalfFloatType, depthBuffer: false });
    this.light.texture.minFilter = this.light.texture.magFilter = THREE.LinearFilter;
    this.light.texture.wrapS = this.light.texture.wrapT = this.light.texture.wrapR = THREE.ClampToEdgeWrapping;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // --------------------------------------------------------------- splat
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); // x y z r
    this.aD = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); // dens heat dust seed
    this.aP.setUsage(THREE.DynamicDrawUsage); this.aD.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('aP', this.aP); quad.setAttribute('aD', this.aD);
    quad.instanceCount = 0;
    this.splatGeo = quad;
    this.splatMat = new THREE.ShaderMaterial({
      uniforms: { uSliceY: { value: 0 }, uOrigin: { value: new THREE.Vector3(VOL.ox, VOL.oy, VOL.oz) }, uSize: { value: new THREE.Vector3(VOL.sx, VOL.sy, VOL.sz) } },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      vertexShader: /* glsl */ `
        attribute vec4 aP, aD;
        uniform float uSliceY; uniform vec3 uOrigin, uSize;
        varying vec2 vC; varying vec4 vD; varying float vR;
        void main() {
          float dy = uSliceY - aP.y;
          float r = aP.w;
          float rs2 = r * r - dy * dy;
          if (rs2 <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float rs = sqrt(rs2);
          vec2 c = position.xy;
          vec2 w = aP.xz + c * rs;
          vec2 ndc = (w - uOrigin.xz) / uSize.xz * 2.0 - 1.0;
          vC = c * rs / r;                     // normalised 3D radius in the slice plane
          vR = dy / r;
          vD = aD;
          gl_Position = vec4(ndc, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vC; varying vec4 vD; varying float vR;
        void main() {
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
        uDens: { value: this.dens.texture }, uSliceY: { value: 0 }, uSunDir: shared.uSunDir, uFlamePos: shared.uFlamePos,
        uOrigin: { value: new THREE.Vector3(VOL.ox, VOL.oy, VOL.oz) }, uSize: { value: new THREE.Vector3(VOL.sx, VOL.sy, VOL.sz) },
      },
      depthTest: false, depthWrite: false,
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        precision highp sampler3D;
        uniform sampler3D uDens;
        uniform float uSliceY;
        uniform vec3 uSunDir, uFlamePos, uOrigin, uSize;
        varying vec2 vUv;
        float D(vec3 p) {
          vec3 u = (p - uOrigin) / uSize;
          if (any(lessThan(u, vec3(0.0))) || any(greaterThan(u, vec3(1.0)))) return 0.0;
          return min(texture(uDens, u.xzy).r, 3.0);
        }
        void main() {
          vec3 p = vec3(uOrigin.x + vUv.x * uSize.x, uSliceY, uOrigin.z + vUv.y * uSize.z);
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
      uOrigin: { value: new THREE.Vector3(VOL.ox, VOL.oy, VOL.oz) }, uSize: { value: new THREE.Vector3(VOL.sx, VOL.sy, VOL.sz) },
      uDepth: { value: null }, uLogFar: { value: Math.log2(2e6 + 1) }, uRes: { value: new THREE.Vector2(1, 1) },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamFwd: { value: new THREE.Vector3() },
      uSteps: { value: 96 }, uSimTime: { value: 0 },
      uPlumeO: { value: new THREE.Vector3() }, uPlumeD: { value: new THREE.Vector3(0, -1, 0) }, uPlumeL: { value: 0 },
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
        uniform sampler3D uDens, uLight, uNoise;
        uniform sampler2D uDepth;
        uniform float uLogFar, uSimTime;
        uniform vec2 uRes;
        uniform vec3 uOrigin, uSize, uCamFwd, uWind;
        uniform mat4 uInvProj, uCamWorld;
        uniform int uSteps;
        uniform vec3 uSunColor, uSkyAmb, uGroundAmb, uFlamePos, uFlameColor;
        uniform vec3 uPlumeO, uPlumeD;
        uniform float uPlumeL;
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
        vec3 fireColor(float k) {
          // incandescent gas: deep orange -> yellow-white as it gets hotter
          return mix(vec3(1.0, 0.32, 0.06), vec3(1.0, 0.78, 0.45), clamp(k * 0.5, 0.0, 1.0));
        }
        void main() {
          vec4 vp = uInvProj * vec4(vNdc, 1.0, 1.0);
          vec3 rd = normalize(mat3(uCamWorld) * normalize(vp.xyz / vp.w));
          vec3 ro = cameraPosition;
          vec2 tb = box(ro, rd, uOrigin, uOrigin + uSize);
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
          float stepL = max(len / n, 2.5);
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
            vec4 v = texture(uDens, u.xzy);
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
                vec4 L = texture(uLight, u.xzy);
                float odS = L.r * SIGMA;
                float odF = L.g * SIGMA;
                float occ = L.b;
                // sun: single scattering + two softer multiple-scattering octaves
                float beer = exp(-odS) + 0.5 * exp(-odS * 0.25) + 0.25 * exp(-odS * 0.06);
                float powder = 1.0 - exp(-dens * 2.0);
                vec3 sunL = uSunColor * beer * phase * mix(0.6, 1.0, powder) * 3.14159 * 0.9;
                // sky & ground ambient; shaded areas take the blue sky colour
                float hN = clamp((p.y - uOrigin.y) / 450.0, 0.0, 1.0);
                vec3 amb = mix(uGroundAmb * 0.9 + uSkyAmb * 1.2, uSkyAmb * 2.6, 0.3 + 0.7 * hN) * (0.3 + 0.7 * exp(-occ * 0.45)) * (0.65 + 0.35 * curl);
                // engine fire lighting the steam from below/inside
                vec3 tf = uFlamePos - p;
                float df2 = dot(tf, tf);
                vec3 fl = uFlameColor * (exp(-odF) + 0.3 * exp(-odF * 0.2)) / (df2 + 1600.0) * 1.4;
                vec3 alb = mix(vec3(0.97, 0.97, 0.97), vec3(0.62, 0.54, 0.46), clamp(v.b / max(base, 1e-3), 0.0, 1.0));
                vec3 S = alb * (sunL + amb + fl);
                // incandescence of the hot exhaust core
                float heat = v.g / max(base, 0.05);
                S += fireColor(heat) * v.g * 55.0;
                // fire & plume impingement glowing inside the steam near the base
                float dfl = sqrt(df2);
                S += uFlameColor * 2.2e-4 * exp(-dfl / 26.0) * (0.5 + 0.5 * lobe);
                float a = 1.0 - exp(-dens * SIGMA * 1.4 * stepL);
                vec3 c = S * a;
                if (t < tSplit) { colF += T * c; TF *= 1.0 - a; }
                else colB += T * c;
                tw += t * T * a; ws += T * a;
                T *= 1.0 - a;
              }
            }
            t += stepL * (base > 0.004 ? 1.0 : 2.0);
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
    const minR = VOL.cell * 1.25;
    for (let i = 0; i < ps.count && n < this.max; i++) {
      if (ps.kind[i] !== KIND.SMOKE) continue;
      const x = ps.p[i * 3], y = ps.p[i * 3 + 1], z = ps.p[i * 3 + 2];
      if (!insideVolume(x, y, z, 20)) continue;
      const op = ps.op[i];
      if (op < 0.003) continue;
      let r = ps.size[i] * 1.15;
      let m = op * ps.dens[i] * 1.6;
      if (r < minR) { m *= (r / minR) ** 3; r = minR; } // conserve mass for sub-voxel puffs
      const hot = ps.hot[i] > 0 ? Math.max(0, (ps.hot[i] * Math.exp(-ps.age[i] / 0.55) - 500) / 1300) : 0;
      P[n * 4] = x; P[n * 4 + 1] = y; P[n * 4 + 2] = z; P[n * 4 + 3] = r;
      D[n * 4] = m; D[n * 4 + 1] = m * hot; D[n * 4 + 2] = m * ps.tint[i]; D[n * 4 + 3] = ps.seed[i];
      n++;
    }
    this.splatGeo.instanceCount = n;
    this.aP.clearUpdateRanges(); this.aP.addUpdateRange(0, Math.max(1, n) * 4); this.aP.needsUpdate = true;
    this.aD.clearUpdateRanges(); this.aD.addUpdateRange(0, Math.max(1, n) * 4); this.aD.needsUpdate = true;
    this.count = n;
    // bounding height of the smoke to skip empty slices
    let top = -1e9;
    for (let k = 0; k < n; k++) top = Math.max(top, P[k * 4 + 1] + P[k * 4 + 3]);
    this.top = top;
    this.active = n > 0;
    return n;
  }

  build() {
    const r = this.renderer;
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    const { ny, cell, oy } = VOL;
    const topSlice = Math.min(ny, Math.ceil((this.top - oy) / cell) + 1);
    for (let j = 0; j < ny; j++) {
      r.setRenderTarget(this.dens, j);
      r.clear();
      if (j > topSlice || !this.active) continue;
      this.splatMat.uniforms.uSliceY.value = oy + (j + 0.5) * cell;
      r.render(this.splatScene, this.cam);
    }
    const lTop = Math.min(this.lny, Math.ceil(topSlice / 2) + 2);
    for (let j = 0; j < this.lny; j++) {
      r.setRenderTarget(this.light, j);
      if (j > lTop || !this.active) { r.clear(); continue; }
      this.lightMat.uniforms.uSliceY.value = oy + (j + 0.5) * cell * 2;
      r.render(this.lightScene, this.cam);
    }
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
      u.uPlumeO.value.copy(plumeAxis.origin); u.uPlumeD.value.copy(plumeAxis.dir); u.uPlumeL.value = plumeAxis.length;
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
