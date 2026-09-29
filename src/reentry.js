import * as THREE from 'three';
import { NOISE, AERIAL } from './glsl.js';
import { shared } from './shared.js';
import { SOFT_DEPTH } from './particles.js';

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
          // shock layer: strongest where the surface faces into the flow
          float wind = max(dot(normalize(vN), -uFlow), 0.0);
          float n = fbm3(vObjP * 0.35 + uFlow * uTime * 25.0, 4);
          float k = pow(wind, 1.6) * (0.35 + 1.3 * n) + edge * edge * 0.6 * wind;
          vec3 hot = vec3(1.0, 0.55, 0.22), pink = vec3(1.0, 0.32, 0.62), violet = vec3(0.62, 0.32, 1.0);
          col = mix(pink, hot, pow(wind, 3.0)) * k + violet * edge * edge * 0.25 * wind;
          col *= 7.0;
        #else
          // ionised wake: s = 0 at the ship, 1 at the end of the trail
          float s = clamp(vObjP.y / uLen, 0.0, 1.0);
          float n = fbm3(vec3(vObjP.x * 0.05, vObjP.y * 0.012 + uTime * 6.0, vObjP.z * 0.05), 4);
          float k = exp(-s * 3.2) * pow(edge, 1.3) * (0.3 + 1.4 * n);
          col = mix(vec3(1.0, 0.36, 0.6), vec3(0.55, 0.3, 1.0), smoothstep(0.1, 0.8, s)) * k * 4.0;
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
    // wake cone: local +Y points back along the flow
    this.wakeLen = 520;
    const wakeGeo = new THREE.CylinderGeometry(70, 12, this.wakeLen, 40, 24, true);
    wakeGeo.translate(0, this.wakeLen / 2, 0);
    this.wakeMat = plasmaMaterial(1, false);
    this.wakeMat.uniforms.uLen.value = this.wakeLen;
    this.wake = new THREE.Mesh(wakeGeo, this.wakeMat);
    this.wake.frustumCulled = false;
    this.wake.renderOrder = 22;
    this.group.add(this.shell, this.wake);
    this.group.visible = false;
    this._q = new THREE.Quaternion();
  }

  setDepth(tex, res, logFar) {
    for (const m of [this.shellMat, this.wakeMat]) {
      m.uniforms.uDepth.value = tex; m.uniforms.uPartRes.value.copy(res); m.uniforms.uLogFar.value = logFar;
    }
  }

  update(shipGroup, velocity, heat) {
    const h = Math.max(0, Math.min(1.5, heat));
    this.group.visible = h > 0.02 && shipGroup.visible;
    if (!this.group.visible) return;
    const v = velocity.lengthSq() > 1 ? velocity.clone().normalize() : new THREE.Vector3(0, -1, 0);
    const flow = v.clone().negate();
    for (const m of [this.shellMat, this.wakeMat]) { m.uniforms.uHeat.value = h; m.uniforms.uFlow.value.copy(flow); }
    this.shell.position.copy(shipGroup.position);
    this.shell.quaternion.copy(shipGroup.quaternion);
    // wake starts at the ship's centre and trails downstream
    const centre = new THREE.Vector3(0, 25, 0).applyQuaternion(shipGroup.quaternion).add(shipGroup.position);
    this.wake.position.copy(centre);
    this.wake.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), flow);
  }
}
