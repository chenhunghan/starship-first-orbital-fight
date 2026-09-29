import * as THREE from 'three';
import { ATMOS, NOISE } from './glsl.js';

// ------------------------------------------------------------------ JS port
// Same model as the GLSL atmosphere, used on the CPU to derive light colours.
const PR = 6371000, AR = 6471000, SUN_I = 22;
const BR = [5.802e-6, 13.558e-6, 33.1e-6];
const BOZ = [0.65e-6, 1.881e-6, 0.085e-6];

export const atmosParams = { mieBeta: 1.4e-5, mieH: 1200 };

function raySphere(o, d, r) {
  const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
  const disc = b * b - c;
  if (disc < 0) return [1e20, -1e20];
  const s = Math.sqrt(disc);
  return [-b - s, -b + s];
}
function dens(h) {
  return [Math.exp(-h / 8000), Math.exp(-h / atmosParams.mieH), Math.max(0, 1 - Math.abs(h - 25000) / 15000)];
}
function ext(od) {
  const m = atmosParams.mieBeta * 1.11;
  return [BR[0] * od[0] + m * od[1] + BOZ[0] * od[2], BR[1] * od[0] + m * od[1] + BOZ[1] * od[2], BR[2] * od[0] + m * od[1] + BOZ[2] * od[2]];
}
export function sunTransmittanceJS(altitude, sunDir) {
  const p = [0, PR + altitude, 0];
  const d = [sunDir.x, sunDir.y, sunDir.z];
  const tp = raySphere(p, d, PR - 200);
  if (tp[0] > 0) return new THREE.Vector3(0, 0, 0);
  const ta = raySphere(p, d, AR);
  const n = 24, seg = ta[1] / n;
  const od = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    const t = seg * (j + 0.5);
    const q = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
    const h = Math.hypot(q[0], q[1], q[2]) - PR;
    const dd = dens(h);
    od[0] += dd[0] * seg; od[1] += dd[1] * seg; od[2] += dd[2] * seg;
  }
  const e = ext(od);
  return new THREE.Vector3(Math.exp(-e[0]), Math.exp(-e[1]), Math.exp(-e[2]));
}
function skyRadianceJS(altitude, rd, sunDir, steps = 10) {
  const ro = [0, PR + altitude, 0];
  const d = [rd.x, rd.y, rd.z];
  const ta = raySphere(ro, d, AR);
  const tp = raySphere(ro, d, PR);
  const t0 = Math.max(ta[0], 0);
  let t1 = ta[1];
  if (tp[0] > 0) t1 = Math.min(t1, tp[0]);
  const mu = rd.x * sunDir.x + rd.y * sunDir.y + rd.z * sunDir.z;
  const pr = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = 0.78, gg = g * g;
  const pm = ((3 / (8 * Math.PI)) * ((1 - gg) * (1 + mu * mu))) / ((2 + gg) * Math.pow(1 + gg - 2 * g * mu, 1.5));
  const sR = [0, 0, 0], sM = [0, 0, 0], od = [0, 0, 0], sMs = [0, 0, 0];
  const L = t1 - t0;
  for (let i = 0; i < steps; i++) {
    const ta = L * (i / steps) ** 2, tb = L * ((i + 1) / steps) ** 2;
    const seg = tb - ta;
    const t = t0 + 0.5 * (ta + tb);
    const p = [ro[0] + d[0] * t, ro[1] + d[1] * t, ro[2] + d[2] * t];
    const h = Math.hypot(p[0], p[1], p[2]) - PR;
    const dd = dens(h);
    od[0] += dd[0] * seg; od[1] += dd[1] * seg; od[2] += dd[2] * seg;
    const ts = sunTransmittanceJS(h, sunDir);
    const e = ext(od);
    const tsa = [ts.x, ts.y, ts.z];
    for (let k = 0; k < 3; k++) {
      const a = Math.exp(-e[k]) * tsa[k];
      sR[k] += a * dd[0] * seg;
      sM[k] += a * dd[1] * seg;
      sMs[k] += Math.exp(-e[k]) * (dd[0] * BR[k] + dd[1] * atmosParams.mieBeta * 0.5) * seg * (0.5 + 0.5 * tsa[k]);
    }
  }
  const out = new THREE.Vector3();
  const m = atmosParams.mieBeta;
  const msk = 0.06 * Math.min(1.2, Math.max(sunDir.y + 0.12, 0));
  out.x = SUN_I * (sR[0] * BR[0] * pr + sM[0] * m * pm + sMs[0] * msk);
  out.y = SUN_I * (sR[1] * BR[1] * pr + sM[1] * m * pm + sMs[1] * msk);
  out.z = SUN_I * (sR[2] * BR[2] * pr + sM[2] * m * pm + sMs[2] * msk);
  return out;
}

// Lighting summary for a given sun direction & altitude.
export function computeLighting(sunDir, altitude = 30) {
  const T = sunTransmittanceJS(altitude, sunDir);
  const sun = T.clone().multiplyScalar(SUN_I);
  // cosine-weighted average sky radiance (upper hemisphere) & horizon colour
  const sky = new THREE.Vector3(), ground = new THREE.Vector3(), horizon = new THREE.Vector3();
  let wsum = 0;
  const v = new THREE.Vector3();
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 8; j++) {
      const el = ((i + 0.5) / 6) * (Math.PI / 2);
      const az = (j / 8) * Math.PI * 2;
      v.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
      const L = skyRadianceJS(altitude, v, sunDir, 8);
      const w = Math.sin(el) * Math.cos(el);
      sky.addScaledVector(L, w);
      wsum += w;
      if (i === 0) horizon.addScaledVector(L, 1 / 8);
    }
  }
  sky.multiplyScalar(1 / wsum);
  // ground-bounce ambient: albedo ~0.12 lit by sun + sky
  const sunUp = Math.max(0, sunDir.y);
  ground.copy(sun).multiplyScalar((sunUp * 0.12) / Math.PI).addScaledVector(sky, 0.12);
  // sun colour at low altitude for aerial perspective inscatter
  const T200 = sunTransmittanceJS(200, sunDir).multiplyScalar(SUN_I);
  // horizon ring (matches the uHorizon indexing: a = atan(z, x))
  const ring = [];
  for (let k = 0; k < 16; k++) {
    const a = ((k + 0.5) / 16 - 0.5) * Math.PI * 2;
    const el = 0.02;
    v.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
    ring.push(skyRadianceJS(Math.max(altitude, 2), v, sunDir, 16));
  }
  return { sun, sunT: T, sky, ground, horizon, aerialSun: T200, ring };
}

// Bake the sun optical depth over (altitude, sun cosine) so the atmosphere march needs one
// fetch per sample instead of an 8-step integration (re-baked if the haze height changes).
function transmittanceLUT(renderer, uniforms) {
  const W = 128, H = 512;
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  rt.texture.generateMipmaps = false;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMieBeta: uniforms.uMieBeta, uMieH: uniforms.uMieH },
    defines: { TRANS_LUT_BAKE: 1 },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      ${ATMOS}
      void main() {
        vec2 c = (gl_FragCoord.xy - 0.5) / (TRANS_LUT - 1.0);
        float h = c.x * c.x * (ATMOS_R - PLANET_R);
        float mu = sign(c.y - 0.5) * (2.0 * c.y - 1.0) * (2.0 * c.y - 1.0);
        float r = PLANET_R + h;
        // below the horizon the sun is blocked (handled analytically): keep the grazing value
        float rb = (PLANET_R - 200.0) / r;
        mu = max(mu, -sqrt(max(0.0, 1.0 - rb * rb)) + 1e-4);
        gl_FragColor = vec4(sunOpticalDepth(vec3(0.0, r, 0.0), vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0)), 1.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let bakedH = null;
  return {
    texture: rt.texture,
    update() {
      if (bakedH === uniforms.uMieH.value) return;
      bakedH = uniforms.uMieH.value;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.setRenderTarget(prev);
    },
  };
}

// ---------------------------------------------------------------- sky mesh
export function createSky(renderer) {
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMieBeta: { value: atmosParams.mieBeta },
    uMieH: { value: atmosParams.mieH },
    uCamAlt: { value: 0 },
    uTime: { value: 0 },
    uCirrus: { value: 0.8 },
    uGroundAlbedo: { value: new THREE.Color(0.06, 0.075, 0.08) },
    uSunDisc: { value: 1.0 },
    uSteps: { value: 16 },
    uPlanetOffset: { value: new THREE.Vector3() },
    uTransLUT: { value: null },
  };
  const lut = transmittanceLUT(renderer, uniforms);
  uniforms.uTransLUT.value = lut.texture;
  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    // drawn after the opaque scene at the far plane (no frag-depth write), so the
    // early depth test skips the expensive atmosphere wherever geometry covers the sky
    depthFunc: THREE.LessEqualDepth,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform float uCamAlt, uTime, uCirrus, uSunDisc;
      uniform vec3 uGroundAlbedo;
      uniform vec3 uPlanetOffset;
      uniform int uSteps;
      varying vec3 vDir;
      ${NOISE}
      ${ATMOS}

      float cirrus(vec2 p) {
        // long wind-stretched wisps + a couple of old contrails
        vec2 q = vec2(p.x * 0.8 + p.y * 0.6, -p.x * 0.6 + p.y * 0.8);
        vec2 s = vec2(q.x * 0.00006, q.y * 0.00042);
        float w = fbm2(s + vec2(fbm2(s * 1.7 + 3.1, 3) * 1.6, 0.0), 5);
        float streak = smoothstep(0.52, 0.85, w) * (0.35 + 0.65 * fbm2(s * vec2(3.0, 9.0), 3));
        float c1 = abs(dot(p - vec2(-6000.0, -9000.0), normalize(vec2(-0.45, 0.89))));
        float c2 = abs(dot(p - vec2(9000.0, -4000.0), normalize(vec2(0.2, 0.98))));
        float con = exp(-c1 / 90.0) * (0.5 + 0.5 * fbm2(p * 0.0012, 3)) * 0.7 + exp(-c2 / 140.0) * 0.45 * fbm2(p * 0.0009 + 4.0, 3);
        return clamp(streak + con * smoothstep(0.3, 0.7, fbm2(p * 0.00013, 2)), 0.0, 1.0);
      }

      void main() {
        vec3 rd = normalize(vDir);
        vec3 ro = vec3(0.0, PLANET_R + max(uCamAlt, 1.0), 0.0);
        vec3 T;
        vec3 col = atmosphere(ro, rd, uSunDir, 1e12, T, uSteps);

        vec2 tp = raySphere(ro, rd, PLANET_R);
        if (tp.x > 0.0) {
          // Earth seen from altitude (beyond the terrain mesh / from orbit):
          // ocean with sun glint, sparse land, cloud fields, day/night terminator
          vec3 hp = ro + rd * tp.x;
          vec3 n = normalize(hp);
          vec3 ts = sunTransmittance(hp + n * 10.0, uSunDir);
          float ndl = dot(n, uSunDir);
          vec3 q = n * 1400.0 + uPlanetOffset;
          float land = smoothstep(0.62, 0.7, fbm3(q * 0.9, 5));
          vec3 alb = mix(vec3(0.012, 0.03, 0.055), mix(vec3(0.09, 0.085, 0.06), vec3(0.05, 0.07, 0.035), fbm3(q * 7.0, 3)), land);
          // clouds: large weather systems + cumulus fields
          float cw = fbm3(q * 0.55 + vec3(uTime * 0.0004), 5);
          float cf = fbm3(q * 4.5 + 7.0, 5);
          float cloud = smoothstep(0.48, 0.66, cw * 0.65 + cf * 0.5 - 0.08) * (0.55 + 0.45 * smoothstep(0.35, 0.7, cf));
          vec3 cAlb = vec3(0.78) * (0.75 + 0.25 * cf);
          vec3 surf = mix(alb, cAlb, cloud);
          vec3 lit = surf * ts * SUN_I * max(ndl, 0.0) / 3.14159;
          // specular sun glint on open water
          vec3 rv = reflect(rd, n);
          float gl = pow(max(dot(rv, uSunDir), 0.0), 900.0) * (1.0 - land) * (1.0 - cloud);
          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(-rd, n), 0.0), 5.0);
          lit += ts * SUN_I * gl * fres * 40.0 * step(0.0, ndl);
          // faint airglow/city lights on the night side
          lit += vec3(0.9, 0.7, 0.4) * 0.002 * land * step(0.8, fbm3(q * 30.0, 2)) * smoothstep(0.02, -0.1, ndl);
          col += T * lit;
        } else {
          // sun disc with limb darkening
          float mu = dot(rd, uSunDir);
          float sd = smoothstep(0.99996, 0.999985, mu);
          if (sd > 0.0) {
            float limb = 0.6 + 0.4 * sqrt(max(0.0, 1.0 - (1.0 - mu) / (1.0 - 0.99996)));
            col += T * SUN_I * 900.0 * sd * limb * uSunDisc;
          }
          // cirrus layer at ~9 km
          float hC = 9000.0 - uCamAlt;
          if (rd.y > 0.0 && hC > 0.0) {
            float t = hC / rd.y;
            vec3 p = vec3(0.0, uCamAlt, 0.0) + rd * t;
            float c = cirrus(p.xz + vec2(uTime * 6.0, uTime * 1.5)) * uCirrus;
            c *= smoothstep(0.0, 0.08, rd.y) * exp(-t / 90000.0);
            vec3 tsun = sunTransmittance(vec3(0.0, PLANET_R + 9000.0, 0.0), uSunDir);
            float ph = phaseMie(mu, 0.6) * 4.0 + 0.35;
            vec3 cc = SUN_I * tsun * ph * 0.16 + col * 0.5;
            vec3 Tv;
            atmosphere(ro, rd, uSunDir, t, Tv, 6);
            col = mix(col, cc * Tv + col * (1.0 - Tv.g) * 0.2, c * 0.55);
          }
        }
        // stars, only visible where the sky is dark (high altitude)
        float lum = dot(col, vec3(0.3, 0.6, 0.1));
        vec3 sp = rd * 700.0;
        float st = step(0.9975, hash13(floor(sp))) * hash13(floor(sp) + 3.0);
        col += vec3(st) * 0.012 * smoothstep(0.02, 0.0, lum);
        gl_FragColor = vec4(min(col, vec3(20000.0)), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material);
  mesh.scale.setScalar(9e5);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000; // last opaque
  mesh.name = 'sky';
  return { mesh, uniforms, updateLUT: lut.update };
}
