import * as THREE from 'three';
import { NOISE, AERIAL, CLOUD_WEATHER } from './glsl.js';
import { shared } from './shared.js';
import { SOFT_DEPTH } from './particles.js';


// Ray-marched volumetric cumulus (Nubis-style): a 2D coverage map drives cloud
// placement and height, a tileable 3D Perlin-Worley texture carves the shape and
// Worley fbm erodes the edges. Lighting: Beer-Lambert + powder toward the sun,
// dual-lobe Henyey-Greenstein phase, height-graded sky ambient.

function buildNoise3D(N = 64) {
  const data = new Uint8Array(N * N * N * 4);
  const rnd = (i) => { let x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const worley = (x, y, z, cells, seed) => {
    const fx = x * cells, fy = y * cells, fz = z * cells;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    let md = 9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy, cz = iz + dz;
      const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells, wz = ((cz % cells) + cells) % cells;
      const h = seed + wx * 73 + wy * 9277 + wz * 26699;
      const px = cx + rnd(h), py = cy + rnd(h + 1.7), pz = cz + rnd(h + 3.1);
      const d = (px - fx) ** 2 + (py - fy) ** 2 + (pz - fz) ** 2;
      if (d < md) md = d;
    }
    return 1 - Math.min(1, Math.sqrt(md));
  };
  // tileable value noise (periodic lattice)
  const vnoise = (x, y, z, P, seed) => {
    const fx = x * P, fy = y * P, fz = z * P;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const s = (t) => t * t * (3 - 2 * t);
    const ux = s(tx), uy = s(ty), uz = s(tz);
    const L = (a, b, c) => rnd(seed + (((a % P) + P) % P) * 57 + (((b % P) + P) % P) * 113 + (((c % P) + P) % P) * 419);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(L(ix, iy, iz), L(ix + 1, iy, iz), ux), l(L(ix, iy + 1, iz), L(ix + 1, iy + 1, iz), ux), uy),
      l(l(L(ix, iy, iz + 1), L(ix + 1, iy, iz + 1), ux), l(L(ix, iy + 1, iz + 1), L(ix + 1, iy + 1, iz + 1), ux), uy),
      uz
    );
  };
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, w = z / N;
    const perlin = vnoise(u, v, w, 4, 1) * 0.5 + vnoise(u, v, w, 8, 2) * 0.3 + vnoise(u, v, w, 16, 3) * 0.2;
    const w1 = worley(u, v, w, 4, 10), w2 = worley(u, v, w, 8, 20), w3 = worley(u, v, w, 16, 30);
    const wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
    // Perlin-Worley: perlin remapped by worley fbm (billowy)
    const pw = Math.min(1, Math.max(0, (perlin - (1 - wf)) / (1 - (1 - wf) + 1e-3) * 0.6 + perlin * 0.4));
    const i = (x + N * (y + N * z)) * 4;
    data[i] = pw * 255;
    data[i + 1] = wf * 255;
    data[i + 2] = (w2 * 0.625 + w3 * 0.375) * 255;
    data[i + 3] = w3 * 255;
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function createClouds() {
  const noise = buildNoise3D(64);
  const uniforms = {
    ...shared,
    uNoise: { value: noise },
    uDepth: { value: null }, uLogFar: { value: Math.log2(2e6 + 1) }, uPartRes: { value: new THREE.Vector2(1, 1) },
    uCamFwd: { value: new THREE.Vector3() },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uSteps: { value: 56 },
    uCloudSun: { value: new THREE.Vector3(10, 10, 10) },
  };
  const make = (reflection) => new THREE.ShaderMaterial({
    uniforms,
    defines: reflection ? { REFLECTION: 1 } : {},
    transparent: true,
    depthWrite: false,
    depthTest: reflection,
    depthFunc: THREE.LessEqualDepth,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      varying vec2 vNdc;
      void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      precision highp sampler3D;
      uniform sampler3D uNoise;
      uniform mat4 uInvProj, uCamWorld;
      uniform vec3 uCamFwd, uSunColor, uSkyAmb, uGroundAmb, uCloudSun;
      
      uniform int uSteps;
      varying vec2 vNdc;
      ${NOISE}
      ${AERIAL}
      ${SOFT_DEPTH}
      ${CLOUD_WEATHER}
      float uDetailLod = 1.0;
      float density(vec3 p, bool detail) {
        vec2 w = weather(p.xz);
        if (w.x < 0.01) return 0.0;
        float h = (p.y - CB) / ((CT - CB) * w.y);
        if (h < 0.0 || h > 1.0) return 0.0;
        // cumulus profile: flat base, rounded dome-like top
        float grad = smoothstep(0.0, 0.06, h) * (1.0 - h * h * 0.85);
        vec3 q = (p - vec3(windOff().x, 0.0, windOff().y)) / 3200.0;
        vec4 n = texture(uNoise, q);
        float fbmW = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
        float shape = n.r * 0.55 + fbmW * 0.45;
        float base = clamp(remap(shape * grad * w.x, 0.1, 0.55, 0.0, 1.0), 0.0, 1.0);
        if (detail && base > 0.0 && uDetailLod > 0.0) {
          vec4 dn = texture(uNoise, q * 6.1 + vec3(0.0, uCloudTime * 0.0015, 0.0));
          float df = dn.g * 0.5 + dn.b * 0.3 + dn.a * 0.2;
          // wispy at the base, billowy at the top
          float m = mix(1.0 - df, df, clamp(h * 3.0, 0.0, 1.0));
          base = clamp(remap(base, m * 0.42 * uDetailLod, 1.0, 0.0, 1.0), 0.0, 1.0);
        }
        return base;
      }
      float hg(float mu, float g) { float gg = g * g; return (1.0 - gg) / (12.566 * pow(1.0 + gg - 2.0 * g * mu, 1.5)); }
      vec2 slab(vec3 ro, vec3 rd) {
        float t0 = (CB - ro.y) / rd.y, t1 = (CT - ro.y) / rd.y;
        if (abs(rd.y) < 1e-4) return ro.y > CB && ro.y < CT ? vec2(0.0, 1e6) : vec2(1.0, -1.0);
        vec2 t = vec2(min(t0, t1), max(t0, t1));
        t.x = max(t.x, 0.0);
        return t;
      }
      void main() {
        vec4 vp = uInvProj * vec4(vNdc, 1.0, 1.0);
        vec3 rdV = normalize(vp.xyz / vp.w);
        vec3 rd = normalize(mat3(uCamWorld) * rdV);
        vec3 ro = cameraPosition;
        vec2 ts = slab(ro, rd);
        float tMax = min(ts.y, 70000.0);
        #ifndef REFLECTION
          float sd = sceneDepth() / max(dot(rd, uCamFwd), 1e-3);
          tMax = min(tMax, sd);
        #endif
        if (tMax <= ts.x) discard;
        float jit = hash12(gl_FragCoord.xy);
        float stepL = 60.0 + ts.x * 0.012;
        float t = ts.x + stepL * jit;
        float T = 1.0;
        vec3 col = vec3(0.0);
        float mu = dot(rd, uSunDir);
        float phase = mix(hg(mu, 0.72), hg(mu, -0.2), 0.35) * 0.6 + 0.4 * hg(mu, 0.25);
        float sigma = 0.035;
        float tWeighted = 0.0, wsum = 0.0;
        for (int i = 0; i < 128; i++) {
          if (i >= uSteps || t > tMax || T < 0.02) break;
          vec3 p = ro + rd * t;
          uDetailLod = smoothstep(30000.0, 9000.0, t);
          float d = density(p, true);
          if (d > 0.002) {
            // light march toward the sun
            float od = 0.0;
            float ls = 90.0;
            vec3 lp = p;
            for (int j = 0; j < 6; j++) {
              lp += uSunDir * ls;
              od += density(lp, false) * ls;
              ls *= 1.7;
            }
            float beer = exp(-od * sigma);
            float beer2 = exp(-od * sigma * 0.22) * 0.5; // multiple-scattering octave
            float powder = 1.0 - exp(-d * sigma * 180.0);
            vec3 sunL = uCloudSun * max(beer, beer2) * mix(0.55, 1.0, powder) * phase;
            float h = clamp((p.y - CB) / (CT - CB), 0.0, 1.0);
            vec3 amb = mix(uGroundAmb * 2.2, uSkyAmb * 2.4, 0.3 + 0.7 * h);
            vec3 S = sunL * 3.14159 + amb;
            float dT = exp(-d * sigma * stepL);
            col += T * S * (1.0 - dT);
            tWeighted += t * T * (1.0 - dT); wsum += T * (1.0 - dT);
            T *= dT;
          }
          stepL = 60.0 + t * 0.012;
          t += stepL * (d > 0.002 ? 1.0 : 1.8);
        }
        float a = 1.0 - T;
        if (a < 0.003) discard;
        float tm = tWeighted / max(wsum, 1e-4);
        vec3 wp = ro + rd * tm;
        vec3 c = col / max(a, 1e-4);
        c = applyAerial(c, wp, ro);
        gl_FragColor = vec4(c * a, a);
        #ifdef REFLECTION
          gl_FragDepth = 1.0;
        #endif
      }`,
  });
  const main = make(false), refl = make(true);
  const march = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), main);
  march.frustumCulled = false;
  const marchScene = new THREE.Scene();
  marchScene.add(march);
  // upsample + light blur of the low-res cloud buffer into the transparent pass
  const compUniforms = { tClouds: { value: null }, uTexel: { value: new THREE.Vector2() } };
  const composite = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: compUniforms,
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform sampler2D tClouds; uniform vec2 uTexel; varying vec2 vUv;
      void main() {
        vec4 c = texture2D(tClouds, vUv) * 0.4;
        c += texture2D(tClouds, vUv + uTexel * vec2(1.2, 0.4)) * 0.15;
        c += texture2D(tClouds, vUv + uTexel * vec2(-1.2, -0.4)) * 0.15;
        c += texture2D(tClouds, vUv + uTexel * vec2(-0.4, 1.2)) * 0.15;
        c += texture2D(tClouds, vUv + uTexel * vec2(0.4, -1.2)) * 0.15;
        if (c.a < 0.002) discard;
        gl_FragColor = c;
      }`,
  }));
  composite.frustumCulled = false;
  composite.renderOrder = 1;
  let rt = null;
  return {
    mesh: composite, uniforms,
    setSize(w, h) {
      rt?.dispose();
      rt = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), { type: THREE.HalfFloatType, depthBuffer: false });
      compUniforms.tClouds.value = rt.texture;
      compUniforms.uTexel.value.set(1 / rt.width, 1 / rt.height);
    },
    render(renderer, camera, depthTex) {
      march.material = main;
      uniforms.uDepth.value = depthTex;
      uniforms.uPartRes.value.set(rt.width, rt.height);
      uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
      uniforms.uCamWorld.value.copy(camera.matrixWorld);
      camera.getWorldDirection(uniforms.uCamFwd.value);
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(marchScene, camera);
    },
    // draw into the currently bound (reflection) target, behind existing geometry
    renderReflection(renderer, camera) {
      march.material = refl;
      uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
      uniforms.uCamWorld.value.copy(camera.matrixWorld);
      const ac = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(marchScene, camera);
      renderer.autoClear = ac;
      march.material = main;
    },
  };
}
