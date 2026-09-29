import * as THREE from 'three';
import { patchMaterial } from './shared.js';

// Starlink V3 deployment through the ship's payload ("PEZ") door. Flight 14
// released 26 satellites between T+34:07 and T+1:04:39. Each one slides out of
// the slot on the leeward side, separates at ~0.4 m/s and slowly tumbles away.
// Relative motion over the few minutes they stay in view is taken as linear.

export const DEPLOY_START = 34 * 60 + 7;
export const DEPLOY_END = 64 * 60 + 39;
const COUNT = 26;

function satelliteGeometry() {
  // flat bus with two folded solar-array stacks (V3: large, flat-packed)
  const bus = new THREE.BoxGeometry(2.8, 0.35, 6.2);
  const arr1 = new THREE.BoxGeometry(2.7, 0.12, 5.9);
  arr1.translate(0, 0.25, 0);
  const arr2 = arr1.clone();
  arr2.translate(0, -0.5, 0);
  return { bus, arr: [arr1, arr2] };
}

export class StarlinkDeploy {
  constructor() {
    this.group = new THREE.Group();
    const g = satelliteGeometry();
    const busMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xb8b8b4, metalness: 0.8, roughness: 0.35 }), {
      key: 'slbus',
      fragMap: 'diffuseColor.rgb *= 0.85 + 0.25 * vnoise2(vObj.xz * 3.0);',
    });
    const cellMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x0b1020, metalness: 0.3, roughness: 0.25 }), {
      key: 'slcell',
      fragMap: /* glsl */ `
        vec2 c = fract(vObj.xz * vec2(4.0, 4.0));
        float grid = step(0.94, max(c.x, c.y));
        diffuseColor.rgb = mix(vec3(0.02, 0.035, 0.07), vec3(0.35), grid * 0.6);`,
    });
    this.sats = [];
    for (let i = 0; i < COUNT; i++) {
      const s = new THREE.Group();
      s.add(new THREE.Mesh(g.bus, busMat), new THREE.Mesh(g.arr[0], cellMat), new THREE.Mesh(g.arr[1], cellMat));
      s.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      s.visible = false;
      this.group.add(s);
      const r = Math.sin(i * 12.9898) * 43758.5453;
      const f = r - Math.floor(r);
      this.sats.push({
        obj: s,
        t0: DEPLOY_START + (i / (COUNT - 1)) * (DEPLOY_END - DEPLOY_START - 60),
        v: 0.35 + f * 0.1,
        spin: new THREE.Vector3(f - 0.5, 0.3 + f * 0.4, 0.5 - f).multiplyScalar(0.05),
      });
    }
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  /** shipGroup: ship Object3D (payload door on its leeward -Z side around y = 38 m) */
  update(t, shipGroup, shipActive) {
    for (const s of this.sats) {
      const dt = t - s.t0;
      // visible from the moment it starts sliding out until it has drifted ~1.5 km away
      const show = shipActive && dt > -8 && dt < 3600 && t < DEPLOY_END + 3600;
      s.obj.visible = show;
      if (!show) continue;
      // slide out of the slot along -Z (ship frame), then drift away at the separation speed
      const slide = Math.min(1, Math.max(0, (dt + 8) / 8));
      const out = dt < 0 ? slide * 4.8 : 4.8 + s.v * dt;
      this._v.set(0, 38 + Math.max(0, dt) * 0.02, -(out));
      s.obj.position.copy(this._v.applyMatrix4(shipGroup.matrixWorld));
      s.obj.quaternion.copy(shipGroup.quaternion);
      if (dt > 0) {
        this._q.setFromEuler(new THREE.Euler(s.spin.x * dt, s.spin.y * dt, s.spin.z * dt));
        s.obj.quaternion.multiply(this._q);
      }
    }
  }
}
