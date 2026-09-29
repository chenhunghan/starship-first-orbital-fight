import * as THREE from 'three';
import { AERIAL, NOISE, CLOUD_WEATHER } from './glsl.js';

// Uniforms shared by every material in the scene (same objects => one update).
export const shared = {
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uAerialSun: { value: new THREE.Vector3(10, 10, 10) },
  uAerialAmb: { value: new THREE.Vector3(1, 1, 1) },
  uAerialMie: { value: 1.4e-5 },
  uHorizon: { value: Array.from({ length: 16 }, () => new THREE.Vector3(1, 1, 1)) },
  uAerialMieH: { value: 1200 },
  uAerialScale: { value: 1 },
  uTime: { value: 0 },
  uCoverage: { value: 0.68 },
  uCloudTime: { value: 0 },
  uSunColor: { value: new THREE.Vector3(10, 10, 10) },
  uSkyAmb: { value: new THREE.Vector3(1, 1, 1) },
  uGroundAmb: { value: new THREE.Vector3(0.2, 0.2, 0.2) },
  // flame light (engine plume near the pad), world position + radiant intensity
  uFlamePos: { value: new THREE.Vector3(0, 10, 0) },
  uFlameColor: { value: new THREE.Vector3(0, 0, 0) },
  uReflection: { value: null },
  uReflMatrix: { value: new THREE.Matrix4() },
  uResolution: { value: new THREE.Vector2(1, 1) },
};

/**
 * Patch a built-in material: adds aerial perspective and gives access to the
 * world position in the fragment shader (vWorld). `hooks` can inject code:
 *   vertexHead, vertexEnd, fragHead, fragMap (after map_fragment),
 *   fragRough (after roughnessmap_fragment), fragMetal, fragNormal (after normal_fragment_maps),
 *   fragEmissive (after emissivemap_fragment), fragOut (after opaque_fragment, before aerial)
 */
export function patchMaterial(material, hooks = {}, extraUniforms = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, extraUniforms);
    let vs = shader.vertexShader;
    let fs = shader.fragmentShader;
    vs = vs.replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\nvarying vec3 vObj;\nvarying vec3 vObjN;\n${hooks.vertexHead || ''}`);
    vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>\nvObj = position; vObjN = normal;\n${hooks.vertexBegin || ''}`);
    vs = vs.replace(
      '#include <project_vertex>',
      `#include <project_vertex>\nvWorld = transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz);\n${hooks.vertexEnd || ''}`
    );
    fs = fs.replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\nvarying vec3 vObj;\nvarying vec3 vObjN;\n${NOISE}\n${AERIAL}\n${CLOUD_WEATHER}\nuniform float uTime;\n${hooks.fragHead || ''}`);
    if (hooks.fragMap) fs = fs.replace('#include <map_fragment>', `#include <map_fragment>\n${hooks.fragMap}`);
    if (hooks.fragRough) fs = fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${hooks.fragRough}`);
    if (hooks.fragMetal) fs = fs.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${hooks.fragMetal}`);
    if (hooks.fragNormal) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${hooks.fragNormal}`);
    if (hooks.fragEmissive) fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${hooks.fragEmissive}`);
    fs = fs.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      { float cs = cloudShadow(vWorld); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }`);
    fs = fs.replace(
      '#include <opaque_fragment>',
      `#include <opaque_fragment>\n${hooks.fragOut || ''}\ngl_FragColor.rgb = applyAerial(gl_FragColor.rgb, vWorld, cameraPosition);`
    );
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => (hooks.key || '') + material.type;
  return material;
}

export const rng = (seed = 1) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
