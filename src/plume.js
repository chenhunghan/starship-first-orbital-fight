import * as THREE from 'three';
import { NOISE, AERIAL } from './glsl.js';
import { shared } from './shared.js';
import { SOFT_DEPTH } from './particles.js';

// Raptor exhaust. Two layers:
//  * near field: one emissive jet per engine with Mach diamonds (sea level)
//  * far field : merged plume, ray-marched through an analytic emission volume.
// Plume geometry follows the ambient pressure: at sea level the jets are
// compact with shock diamonds; with altitude the underexpanded exhaust balloons
// into a huge faint plume.

const P0 = 101325;

function jetMaterial(reflection) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uLen: { value: 10 }, uExpand: { value: 0.03 }, uPr: { value: 1 }, uGain: { value: 1 },
      uDepth: { value: null }, uLogFar: { value: Math.log2(2e6 + 1) }, uPartRes: { value: new THREE.Vector2(1, 1) },
    },
    defines: reflection ? { REFLECTION: 1 } : {},
    transparent: true,
    depthWrite: false,
    depthTest: reflection,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aLevel; attribute float aExit; attribute float aSeed;
      uniform float uLen, uExpand;
      varying float vS, vLevel, vSeed, vFacing, vViewZ;
      varying vec3 vWorldP;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        float s = -position.y;                 // 0 at the nozzle exit .. 1 at the end
        float L = uLen * (0.85 + 0.3 * aSeed) * (aExit > 1.0 ? 1.6 : 1.0);
        float dist = s * L;
        float r = aExit * (1.0 + dist * uExpand / aExit) * (1.0 - 0.25 * smoothstep(0.1, 0.5, s) * (1.0 - uExpand * 8.0));
        vec3 p = vec3(position.x * r, -dist, position.z * r);
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vec3 nW = normalize(mat3(modelMatrix * instanceMatrix) * vec3(position.x, 0.0, position.z));
        vec3 V = normalize(cameraPosition - wp.xyz);
        vFacing = abs(dot(nW, V));
        vS = s; vLevel = aLevel; vSeed = aSeed;
        vWorldP = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uLen, uPr, uGain, uTime;
      varying float vS, vLevel, vSeed, vFacing, vViewZ;
      varying vec3 vWorldP;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${NOISE}
      ${AERIAL}
      ${SOFT_DEPTH}
      void main() {
        if (vLevel < 0.01) discard;
        #ifndef REFLECTION
          if (sceneDepth() < vViewZ) discard;
        #endif
        float L = uLen;
        float d = vS * L;
        // Mach diamonds (sea level): bright nodes spaced ~1.3 exit diameters
        float lam = 1.75;
        float dia = pow(0.5 + 0.5 * cos(6.2831 * (d - 1.1) / lam), 8.0) * exp(-d / 7.0) * uPr;
        float core = pow(vFacing, 1.6);
        float axial = exp(-vS * 3.0) * smoothstep(0.0, 0.03, vS);
        float flick = 0.85 + 0.3 * vnoise3(vec3(vWorldP.xz * 0.5, uTime * 30.0 + vSeed * 10.0));
        vec3 base = mix(vec3(1.0, 0.78, 0.68), vec3(0.8, 0.45, 1.0), smoothstep(0.05, 0.7, vS));
        vec3 col = base * axial * core * 16.0 + vec3(1.0, 0.93, 0.98) * dia * core * 70.0;
        col *= vLevel * flick * uGain * 0.55;
        col *= aerialT(vWorldP, cameraPosition);
        gl_FragColor = vec4(col, 0.0);
        #include <logdepthbuf_fragment>
      }`,
  });
}

function volumeMaterial(reflection) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uInv: { value: new THREE.Matrix4() },
      uR0: { value: 4 }, uL: { value: 70 }, uTan: { value: 0.035 }, uRb: { value: 10 },
      uPr: { value: 1 }, uLevel: { value: 0 }, uGain: { value: 1 }, uGroundY: { value: 0 }, uSteps: { value: 28 },
      uDepth: { value: null }, uLogFar: { value: Math.log2(2e6 + 1) }, uPartRes: { value: new THREE.Vector2(1, 1) },
      uCamFwd: { value: new THREE.Vector3() },
      uColHot: { value: new THREE.Vector3(1.0, 0.62, 0.5) },
      uColAlt: { value: new THREE.Vector3(0.95, 0.42, 0.72) },
    },
    defines: reflection ? { REFLECTION: 1 } : {},
    transparent: true,
    depthWrite: false,
    depthTest: reflection,
    side: THREE.BackSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    vertexShader: /* glsl */ `
      uniform float uRb, uL;
      varying vec3 vWorldP;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec3 p = vec3(position.x * uRb, position.y * uL - uL * 0.5 + 1.0, position.z * uRb);
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorldP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform mat4 uInv;
      uniform float uR0, uL, uTan, uRb, uPr, uLevel, uGain, uGroundY, uTime;
      uniform int uSteps;
      uniform vec3 uCamFwd, uColHot, uColAlt;
      varying vec3 vWorldP;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${NOISE}
      ${AERIAL}
      ${SOFT_DEPTH}
      vec2 cyl(vec3 ro, vec3 rd, float r) {
        float a = dot(rd.xz, rd.xz);
        float b = dot(ro.xz, rd.xz);
        float c = dot(ro.xz, ro.xz) - r * r;
        float h = b * b - a * c;
        if (h < 0.0 || a < 1e-8) return vec2(1e9, -1e9);
        h = sqrt(h);
        return vec2(-b - h, -b + h) / a;
      }
      void main() {
        if (uLevel < 0.005) discard;
        vec3 roW = cameraPosition;
        vec3 rdW = normalize(vWorldP - roW);
        vec3 ro = (uInv * vec4(roW, 1.0)).xyz;
        vec3 rd = normalize(mat3(uInv) * rdW);
        vec2 tc = cyl(ro, rd, uRb);
        // slab y in [-L, 1]
        float ty0 = (1.0 - ro.y) / rd.y, ty1 = (-uL - ro.y) / rd.y;
        vec2 ty = vec2(min(ty0, ty1), max(ty0, ty1));
        float t0 = max(max(tc.x, ty.x), 0.0);
        float t1 = min(tc.y, ty.y);
        #ifndef REFLECTION
          float sd = sceneDepth() / max(dot(rdW, uCamFwd), 1e-3);
          t1 = min(t1, sd);
        #endif
        if (t1 <= t0) discard;
        float n = float(uSteps);
        float dt = (t1 - t0) / n;
        float jit = hash12(gl_FragCoord.xy + fract(uTime * 7.0) * 100.0);
        vec3 acc = vec3(0.0);
        float ex = 1.0 - uPr;
        for (int i = 0; i < 48; i++) {
          if (i >= uSteps) break;
          float t = t0 + dt * (float(i) + jit);
          vec3 q = ro + rd * t;
          float s = -q.y;
          if (s < 0.0) continue;
          vec3 qw = roW + rdW * t;
          if (qw.y < uGroundY) continue;
          float Rs = uR0 + s * uTan;
          float rr = length(q.xz);
          float core = exp(-rr * rr / (Rs * Rs * 0.45));
          float fall = exp(-s / (uL * 0.32));
          float spread = (uR0 * uR0) / (Rs * Rs);
          // merged shock structure near sea level
          float dia = 1.0 + 2.2 * uPr * exp(-pow((s - 26.0) / 5.5, 2.0)) * exp(-rr * rr / (Rs * Rs * 0.12));
          float nz = fbm3(vec3(q.x * 0.12, s * 0.07 - uTime * 7.0, q.z * 0.12), 3);
          float turb = 0.5 + 1.0 * nz;
          float hot = exp(-s / (uL * 0.12));
          vec3 c = mix(mix(uColAlt, uColHot, uPr), vec3(1.0, 0.92, 0.85), hot * 0.8);
          float e = core * fall * spread * dia * turb * smoothstep(0.0, 6.0, s + 2.0);
          acc += c * e;
        }
        acc *= dt * uLevel * uGain * 3.6;
        acc *= aerialT(roW + rdW * (t0 + t1) * 0.5, roW);
        gl_FragColor = vec4(acc, 0.0);
        #include <logdepthbuf_fragment>
      }`,
  });
}

export class Plume {
  /**
   * @param layout [[x, z, ring, type, exitY], ...] in stage frame
   * @param opts { clusterR, gain }
   */
  constructor(layout, opts = {}) {
    this.layout = layout;
    this.clusterR = opts.clusterR ?? 4.2;
    this.gain = opts.gain ?? 1;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    const n = layout.length;
    const jetGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 40, true);
    jetGeo.translate(0, -0.5, 0);
    this.level = new Float32Array(n);
    const lvl = new THREE.InstancedBufferAttribute(this.level, 1);
    lvl.setUsage(THREE.DynamicDrawUsage);
    jetGeo.setAttribute('aLevel', lvl);
    jetGeo.setAttribute('aExit', new THREE.InstancedBufferAttribute(new Float32Array(layout.map((e) => (e[3] === 'vac' ? 1.15 : 0.62))), 1));
    jetGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(layout.map((_, i) => ((i * 0.618) % 1))), 1));
    this.jetMain = jetMaterial(false);
    this.jetRefl = jetMaterial(true);
    this.jets = new THREE.InstancedMesh(jetGeo, this.jetMain, n);
    layout.forEach((e, i) => this.jets.setMatrixAt(i, new THREE.Matrix4().makeTranslation(e[0], e[4] ?? 0, e[1])));
    this.jets.frustumCulled = false;
    this.jets.renderOrder = 20;
    this.volMain = volumeMaterial(false);
    this.volRefl = volumeMaterial(true);
    this.volume = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32, 1, false), this.volMain);
    this.volume.frustumCulled = false;
    this.volume.renderOrder = 21;
    this.group.add(this.volume, this.jets);
    this.axis = { origin: new THREE.Vector3(), dir: new THREE.Vector3(), length: 0, radius: 0, visible: false };
    this.exitY = Math.min(...layout.map((e) => e[4] ?? 0));
  }

  setReflectionMode(on) {
    this.jets.material = on ? this.jetRefl : this.jetMain;
    this.volume.material = on ? this.volRefl : this.volMain;
  }

  setDepth(tex, res, logFar) {
    for (const m of [this.jetMain, this.volMain]) {
      m.uniforms.uDepth.value = tex;
      m.uniforms.uPartRes.value.copy(res);
      m.uniforms.uLogFar.value = logFar;
    }
  }

  /** stageMatrix: world matrix of the stage group, levels: per-engine throttle 0..1 */
  update(stageMatrix, levels, pa, camera, quality = 1) {
    let sum = 0;
    for (let i = 0; i < this.level.length; i++) { this.level[i] = levels[i]; sum += levels[i]; }
    this.jets.geometry.getAttribute('aLevel').needsUpdate = true;
    const avg = sum / this.level.length;
    const pr = Math.min(1, Math.max(0, pa / P0));
    const ex = 1 - Math.pow(pr, 0.35);
    const L = (72 + 900 * ex * ex) * (0.6 + 0.4 * Math.sqrt(avg));
    const tanT = 0.035 + 0.62 * ex * ex;
    const Rb = (this.clusterR + L * tanT) * 1.25 + 2;
    this.group.matrix.copy(stageMatrix).multiply(new THREE.Matrix4().makeTranslation(0, this.exitY, 0));
    this.group.matrixWorld.copy(this.group.matrix);
    this.group.updateMatrixWorld(true);
    const inv = this.group.matrixWorld.clone().invert();
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    for (const m of [this.volMain, this.volRefl]) {
      const u = m.uniforms;
      u.uInv.value.copy(inv);
      u.uR0.value = this.clusterR;
      u.uL.value = L;
      u.uTan.value = tanT;
      u.uRb.value = Rb;
      u.uPr.value = pr;
      u.uLevel.value = avg;
      u.uGain.value = this.gain * (1 + ex * 0.5);
      u.uCamFwd.value.copy(fwd);
      u.uSteps.value = Math.round(20 + 16 * quality);
    }
    for (const m of [this.jetMain, this.jetRefl]) {
      m.uniforms.uLen.value = 9 + 40 * ex;
      m.uniforms.uExpand.value = 0.012 + 0.25 * ex;
      m.uniforms.uPr.value = pr;
      m.uniforms.uGain.value = this.gain;
    }
    // axis for particle sorting
    const e = this.group.matrixWorld.elements;
    this.axis.origin.set(e[12], e[13], e[14]);
    this.axis.dir.set(-e[4], -e[5], -e[6]).normalize();
    this.axis.length = L;
    this.axis.radius = this.clusterR + L * tanT * 0.5;
    this.axis.visible = avg > 0.01;
    this.group.visible = avg > 0.005;
    this.avg = avg;
    this.length = L;
  }
}
