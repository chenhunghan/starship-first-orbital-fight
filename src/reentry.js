import * as THREE from 'three';
import { NOISE, AERIAL } from './glsl.js';
import { shared } from './shared.js';
import { SOFT_DEPTH } from './particles.js';
import { Plume } from './plume.js';

// Re-entry plasma: a shock layer hugging the windward (tiled) belly and flap
// edges, plus the long ionised wake streaming behind the ship. Emission scales
// with the stagnation heating rate (~ sqrt(rho) v^3); colours follow the air
// plasma spectrum seen on Starship's flap cameras (orange near the tiles,
// pink/magenta N2+/O lines in the shock layer, violet at the edges).

function plasmaMaterial(kind, reflection) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uHeat: { value: 0 },
      uFlow: { value: new THREE.Vector3(0, -1, 0) }, // direction the air moves relative to the ship (world)
      uLen: { value: 1 },
      uDepth: { value: null }, uLogFar: { value: Math.log2(2e6 + 1) }, uPartRes: { value: new THREE.Vector2(1, 1) },
    },
    defines: { KIND: kind, ...(reflection ? { REFLECTION: 1 } : {}) },
    transparent: true, depthWrite: false, depthTest: reflection,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    vertexShader: /* glsl */ `
      varying vec3 vWorldP, vN, vObjP;
      varying float vViewZ;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vObjP = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldP = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * wp;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uHeat, uLen, uTime;
      uniform vec3 uFlow;
      varying vec3 vWorldP, vN, vObjP;
      varying float vViewZ;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${NOISE}
      ${AERIAL}
      ${SOFT_DEPTH}
      void main() {
        if (uHeat < 0.01) discard;
        #ifndef REFLECTION
          if (sceneDepth() < vViewZ - 2.0) discard;
        #endif
        vec3 V = normalize(cameraPosition - vWorldP);
        float edge = 1.0 - abs(dot(normalize(vN), V));
        vec3 col;
        #if KIND == 0
          // shock layer: strongest where the surface faces into the flow, streaming aft
          vec3 nn = normalize(vN);
          float wind = max(dot(nn, -uFlow), 0.0);
          float facing = abs(dot(nn, V));
          vec3 adv = vObjP * 0.3 + uFlow * uTime * 30.0;
          float n = fbm3(adv, 4);
          float streak = fbm3(vec3(vObjP.x * 0.9, vObjP.y * 0.08 + uTime * 9.0, vObjP.z * 0.9), 3);
          float k = pow(wind, 2.0) * (0.25 + 1.1 * n) * facing + pow(edge, 3.0) * wind * 0.5 * streak;
          vec3 hot = vec3(1.0, 0.5, 0.2), pink = vec3(1.0, 0.3, 0.6), violet = vec3(0.6, 0.3, 1.0);
          col = mix(pink, hot, pow(wind, 4.0)) * k + violet * pow(edge, 3.0) * 0.15 * wind;
          col *= 2.4;
        #else
          // ionised wake: s = 0 at the ship, 1 at the end of the trail; glow ~ path length
          float s = clamp(vObjP.y / uLen, 0.0, 1.0);
          float facing = abs(dot(normalize(vN), V));
          float n = fbm3(vec3(vObjP.x * 0.04, vObjP.y * 0.01 - uTime * 8.0, vObjP.z * 0.04), 4);
          float filaments = fbm3(vec3(vObjP.x * 0.15, vObjP.y * 0.004 - uTime * 3.0, vObjP.z * 0.15), 3);
          float k = exp(-s * 4.5) * pow(facing, 2.5) * max(0.0, 1.6 * n - 0.35) * (0.5 + filaments);
          col = mix(vec3(1.0, 0.4, 0.55), vec3(0.55, 0.28, 1.0), smoothstep(0.05, 0.6, s)) * k * 1.3;
        #endif
        col *= uHeat * uHeat;
        col *= aerialT(vWorldP, cameraPosition);
        gl_FragColor = vec4(col, 0.0);
        #include <logdepthbuf_fragment>
      }`,
  });
}

export class Plasma {
  constructor() {
    this.group = new THREE.Group();
    // shock layer shell around the ship (ship frame: origin at engine exit, +Y to the nose)
    const shellGeo = new THREE.CapsuleGeometry(6.2, 42, 12, 40);
    shellGeo.translate(0, 25, 0);
    shellGeo.scale(1.15, 1, 1.15);
    this.shellMat = plasmaMaterial(0, false);
    this.shell = new THREE.Mesh(shellGeo, this.shellMat);
    this.shell.frustumCulled = false;
    this.shell.renderOrder = 22;
    // ionised wake: ray-marched glowing volume streaming behind the ship
    this.wakePlume = new Plume([[0, 0, 0, 'sl', 0]], { clusterR: 8, gain: 0.22, plasma: true });
    this.wakePlume.jets.visible = false;
    this.wake = this.wakePlume.group;
    this.group.add(this.shell, this.wake);
    this.group.visible = false;
    this._q = new THREE.Quaternion();
  }

  setDepth(tex, res, logFar) {
    const m = this.shellMat;
    m.uniforms.uDepth.value = tex; m.uniforms.uPartRes.value.copy(res); m.uniforms.uLogFar.value = logFar;
    this.wakePlume.setDepth(tex, res, logFar);
  }

  update(shipGroup, velocity, heat, camera) {
    const h = Math.max(0, Math.min(1.5, heat));
    this.group.visible = h > 0.02 && shipGroup.visible;
    if (!this.group.visible) return;
    const v = velocity.lengthSq() > 1 ? velocity.clone().normalize() : new THREE.Vector3(0, -1, 0);
    const flow = v.clone().negate();
    this.shellMat.uniforms.uHeat.value = h;
    this.shellMat.uniforms.uFlow.value.copy(flow);
    this.shell.position.copy(shipGroup.position);
    this.shell.quaternion.copy(shipGroup.quaternion);
    // wake starts at the windward belly and streams downstream (local -Y = flow)
    const centre = new THREE.Vector3(0, 25, 0).applyQuaternion(shipGroup.quaternion).add(shipGroup.position);
    this._q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), flow);
    const M = new THREE.Matrix4().compose(centre, this._q, new THREE.Vector3(1, 1, 1));
    this.wakePlume.fixedL = 260 + 260 * h;
    this.wakePlume.fixedTan = 0.09;
    this.wakePlume.update(M, [Math.min(1, h * h)], 0, camera, 0.8);
  }
}
