import * as THREE from 'three';
import { patchMaterial, rng } from './shared.js';

// Orbital Launch Integration Tower (OLIT), Orbital Launch Mount (OLM),
// water-cooled flame deflector, tank farm and the distant build site.

export const TOWER_POS = new THREE.Vector3(0, 0, -27);
export const MOUNT_HEIGHT = 20;

const box = new THREE.BoxGeometry(1, 1, 1);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

class BeamBuilder {
  constructor() { this.list = []; }
  // beam between a and b with cross-section w x d; `roll` orients the section
  beam(a, b, w, d = w) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    dir.normalize();
    _q.setFromUnitVectors(_up, dir);
    const c = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    this.list.push(new THREE.Matrix4().compose(c, _q.clone(), new THREE.Vector3(w, len, d)));
  }
  block(c, sx, sy, sz, rotY = 0) {
    _q.setFromAxisAngle(_up, rotY);
    this.list.push(new THREE.Matrix4().compose(c.clone(), _q.clone(), new THREE.Vector3(sx, sy, sz)));
  }
  build(material, geo = box) {
    const mesh = new THREE.InstancedMesh(geo, material, this.list.length);
    this.list.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

function steelMaterial(base, rough, metal, key, rust = 0.4) {
  const m = new THREE.MeshStandardMaterial({ color: base, roughness: rough, metalness: metal });
  return patchMaterial(m, {
    key,
    fragMap: /* glsl */ `
      {
        float n = fbm3(vWorld * vec3(0.35, 0.08, 0.35), 4);
        float streak = fbm3(vWorld * vec3(1.6, 0.04, 1.6), 3);
        vec3 rustC = vec3(0.23, 0.11, 0.05);
        diffuseColor.rgb = mix(diffuseColor.rgb, rustC, smoothstep(0.45, 0.8, n) * ${rust.toFixed(2)});
        diffuseColor.rgb *= 0.75 + 0.5 * streak;
      }`,
  });
}

export function createPad() {
  const group = new THREE.Group();
  group.name = 'pad';
  const r = rng(7);

  const towerMat = steelMaterial(0x3a3836, 0.62, 0.55, 'tower', 0.45);
  const darkSteel = steelMaterial(0x262524, 0.5, 0.7, 'darksteel', 0.25);
  const concrete = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x8a8680, roughness: 0.92 }), {
    key: 'concrete',
    fragMap: `diffuseColor.rgb *= 0.8 + 0.35 * fbm3(vWorld * 0.4, 3); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05), smoothstep(8.0, 0.0, vWorld.y) * 0.5);`,
  });
  const whiteTank = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.45, metalness: 0.2 }), {
    key: 'tank',
    fragMap: `diffuseColor.rgb *= 0.85 + 0.2 * fbm3(vWorld * vec3(0.2, 1.5, 0.2), 3);`,
  });
  const cladding = steelMaterial(0x6c6a66, 0.5, 0.6, 'clad', 0.2);

  // ---------------------------------------------------------------- tower
  const T = new BeamBuilder();
  const half = 5.6;
  const secH = 15;
  const nSec = 9;
  const tx = TOWER_POS.x, tz = TOWER_POS.z;
  const corner = (i, y) => new THREE.Vector3(tx + (i & 1 ? half : -half), y, tz + (i & 2 ? half : -half));
  const corners = [0, 1, 3, 2];
  for (let s = 0; s < nSec; s++) {
    const y0 = s * secH, y1 = y0 + secH, ym = y0 + secH / 2;
    for (const c of corners) T.beam(corner(c, y0), corner(c, y1), 1.25);
    for (let f = 0; f < 4; f++) {
      const a = corners[f], b = corners[(f + 1) % 4];
      for (const y of [y0 + 0.4, ym]) T.beam(corner(a, y), corner(b, y), 0.7, 0.55);
      // X bracing in each half section
      for (const [ya, yb] of [[y0 + 0.4, ym], [ym, y1]]) {
        T.beam(corner(a, ya), corner(b, yb), 0.42);
        T.beam(corner(b, ya), corner(a, yb), 0.42);
      }
    }
    // internal deck + stair tower
    T.block(new THREE.Vector3(tx, y0 + 0.3, tz), half * 2 - 1, 0.35, half * 2 - 1);
    T.block(new THREE.Vector3(tx - 2.5, ym, tz + 2), 3, secH, 3);
  }
  const top = nSec * secH;
  T.block(new THREE.Vector3(tx, top + 1.2, tz), half * 2 + 1.5, 2.4, half * 2 + 1.5);
  T.beam(new THREE.Vector3(tx, top + 2, tz), new THREE.Vector3(tx, top + 11, tz), 0.6);
  // chopstick rails on the pad-facing face
  for (const sx of [-3.2, 3.2]) T.beam(new THREE.Vector3(tx + sx, 2, tz + half + 0.9), new THREE.Vector3(tx + sx, top, tz + half + 0.9), 0.9, 1.2);
  // base: concrete pedestal & lower cladding
  const tower = T.build(towerMat);
  tower.name = 'tower';
  group.add(tower);

  // lower enclosure panels (lower two sections are partially clad)
  const C = new BeamBuilder();
  C.block(new THREE.Vector3(tx, 7, tz - half - 0.1), half * 2, 14, 0.3);
  C.block(new THREE.Vector3(tx - half - 0.1, 7, tz), 0.3, 14, half * 2);
  C.block(new THREE.Vector3(tx + half + 0.1, 11, tz), 0.3, 6, half * 2);
  const clad = C.build(cladding);
  group.add(clad);

  // ------------------------------------------------ chopsticks & carriage
  const K = new BeamBuilder();
  const chopY = 104;
  const cz = tz + half + 2.6;
  K.block(new THREE.Vector3(tx, chopY, cz), 11, 9, 3.2);
  const armLen = 36;
  for (const side of [-1, 1]) {
    const open = side * 0.42; // arms opened for launch
    const base = new THREE.Vector3(tx + side * 5.8, chopY, cz + 1.2);
    const dir = new THREE.Vector3(Math.sin(open), 0, Math.cos(open));
    const tip = base.clone().addScaledVector(dir, armLen);
    const h = 3.6, w = 1.6;
    const off = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(w / 2);
    for (const oy of [-h / 2, h / 2]) for (const sgn of [-1, 1]) {
      const o = off.clone().multiplyScalar(sgn).add(new THREE.Vector3(0, oy, 0));
      K.beam(base.clone().add(o), tip.clone().add(o), 0.45);
    }
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const p = base.clone().addScaledVector(dir, (i / n) * armLen);
      K.beam(p.clone().add(new THREE.Vector3(0, -h / 2, 0)).add(off), p.clone().add(new THREE.Vector3(0, h / 2, 0)).add(off), 0.3);
      K.beam(p.clone().add(new THREE.Vector3(0, -h / 2, 0)).sub(off), p.clone().add(new THREE.Vector3(0, h / 2, 0)).sub(off), 0.3);
      if (i < n) {
        const p2 = base.clone().addScaledVector(dir, ((i + 1) / n) * armLen);
        K.beam(p.clone().add(new THREE.Vector3(0, -h / 2, 0)).add(off), p2.clone().add(new THREE.Vector3(0, h / 2, 0)).add(off), 0.22);
        K.beam(p.clone().add(new THREE.Vector3(0, -h / 2, 0)).sub(off), p2.clone().add(new THREE.Vector3(0, h / 2, 0)).sub(off), 0.22);
      }
    }
    // catch rail on top of each arm
    K.beam(base.clone().addScaledVector(dir, 6).add(new THREE.Vector3(0, h / 2 + 0.5, 0)), tip.clone().add(new THREE.Vector3(0, h / 2 + 0.5, 0)), 0.8, 1.0);
  }
  // Ship quick-disconnect arm, swung back along the tower face
  const qdY = 92;
  const qdBase = new THREE.Vector3(tx + half + 0.8, qdY, tz + half);
  const qdTip = qdBase.clone().add(new THREE.Vector3(-1, 0, 0.35).normalize().multiplyScalar(-20)).setY(qdY);
  K.beam(qdBase.clone().setY(qdY - 1.3), qdTip.clone().setY(qdY - 1.3), 0.5);
  K.beam(qdBase.clone().setY(qdY + 1.3), qdTip.clone().setY(qdY + 1.3), 0.5);
  for (let i = 0; i <= 8; i++) {
    const p = qdBase.clone().lerp(qdTip, i / 8);
    K.beam(p.clone().setY(qdY - 1.3), p.clone().setY(qdY + 1.3), 0.3);
  }
  K.block(qdTip.clone().add(new THREE.Vector3(0, 0, 0)), 3, 4, 3);
  // service platform lower on the tower
  K.block(new THREE.Vector3(tx - half - 4, 58, tz + 2), 8, 1.5, 6);
  const chop = K.build(darkSteel);
  chop.name = 'chopsticks';
  group.add(chop);

  // ------------------------------------------------------- launch mount
  const M = new BeamBuilder();
  const legR = 9.2;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const p0 = new THREE.Vector3(Math.cos(a) * (legR + 1.5), 0, Math.sin(a) * (legR + 1.5));
    const p1 = new THREE.Vector3(Math.cos(a) * legR, MOUNT_HEIGHT - 3, Math.sin(a) * legR);
    M.beam(p0, p1, 2.8, 2.4);
  }
  const mount = M.build(concrete);
  group.add(mount);

  // table ring
  const ringGeo = new THREE.RingGeometry(5.0, 11.2, 48, 1);
  const tableShape = new THREE.Shape();
  tableShape.absarc(0, 0, 11.4, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, 4.9, 0, Math.PI * 2, true);
  tableShape.holes.push(hole);
  const tableGeo = new THREE.ExtrudeGeometry(tableShape, { depth: 3.4, bevelEnabled: false, curveSegments: 48 });
  tableGeo.rotateX(-Math.PI / 2);
  tableGeo.translate(0, MOUNT_HEIGHT - 3.4, 0);
  const table = new THREE.Mesh(tableGeo, darkSteel);
  table.castShadow = table.receiveShadow = true;
  group.add(table);
  ringGeo.dispose();
  // 20 hold-down clamps + booster quick disconnect
  const H = new BeamBuilder();
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    H.block(new THREE.Vector3(Math.cos(a) * 5.4, MOUNT_HEIGHT + 0.6, Math.sin(a) * 5.4), 0.9, 1.4, 1.2, -a);
  }
  H.block(new THREE.Vector3(0, MOUNT_HEIGHT + 1.2, -7.5), 4, 2.6, 3);
  // deluge plate and its water manifold pipes
  H.block(new THREE.Vector3(0, 0.25, 0), 30, 0.5, 30);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    H.beam(new THREE.Vector3(Math.cos(a) * 16, 0.9, Math.sin(a) * 16), new THREE.Vector3(Math.cos(a) * 60, 0.9, Math.sin(a) * 60), 1.4);
  }
  const hard = H.build(darkSteel);
  group.add(hard);

  // --------------------------------------------------------- tank farm
  const tanks = new THREE.Group();
  const vt = new THREE.CylinderGeometry(1, 1, 1, 32);
  const dome = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const tf = new THREE.Vector3(-250, 0, 110);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 2; j++) {
      const rad = 4.5 + r() * 0.8, h = 22 + r() * 8;
      const c = new THREE.Mesh(vt, whiteTank);
      c.scale.set(rad, h, rad);
      c.position.set(tf.x - 45 + i * 22, h / 2, tf.z - 30 + j * 26);
      const d = new THREE.Mesh(dome, whiteTank);
      d.scale.set(rad, rad * 0.35, rad);
      d.position.set(c.position.x, h, c.position.z);
      tanks.add(c, d);
    }
  }
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Mesh(vt, whiteTank);
    c.scale.set(2.2, 30, 2.2);
    c.rotation.z = Math.PI / 2;
    c.position.set(tf.x + 10, 3, tf.z + 20 + i * 7);
    tanks.add(c);
  }
  tanks.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.add(tanks);

  // --------------------------------------- misc buildings & build site
  const B = new BeamBuilder();
  const bldg = steelMaterial(0x9a9892, 0.7, 0.2, 'bldg', 0.05);
  B.block(new THREE.Vector3(-180, 6, -120), 40, 12, 25);
  B.block(new THREE.Vector3(-120, 4, 200), 30, 8, 18);
  B.block(new THREE.Vector3(160, 5, -150), 22, 10, 22);
  // Starbase build site ~2.7 km west along Highway 4 (Mega Bays, High Bay)
  B.block(new THREE.Vector3(-2750, 45, 180), 60, 90, 45);
  B.block(new THREE.Vector3(-2830, 45, 180), 60, 90, 45);
  B.block(new THREE.Vector3(-2660, 40, 190), 30, 80, 30);
  B.block(new THREE.Vector3(-2950, 12, 210), 90, 24, 50);
  for (let i = 0; i < 18; i++) B.block(new THREE.Vector3(-2600 - r() * 700, 5, 280 + r() * 120), 15 + r() * 20, 6 + r() * 8, 10 + r() * 20);
  // Pad B tower (south of the main pad)
  const PB = new BeamBuilder();
  const pbx = 60, pbz = -420;
  for (let s = 0; s < 9; s++) {
    const y0 = s * secH, y1 = y0 + secH;
    const cc = (i, y) => new THREE.Vector3(pbx + (i & 1 ? half : -half), y, pbz + (i & 2 ? half : -half));
    for (const c of corners) PB.beam(cc(c, y0), cc(c, y1), 1.2);
    for (let f = 0; f < 4; f++) {
      const a = corners[f], b = corners[(f + 1) % 4];
      PB.beam(cc(a, y0 + 0.4), cc(b, y0 + 0.4), 0.7);
      PB.beam(cc(a, y0), cc(b, y1), 0.4);
      PB.beam(cc(b, y0), cc(a, y1), 0.4);
    }
  }
  group.add(PB.build(towerMat));
  // South Padre Island high-rises on the far side of the pass (north)
  for (let i = 0; i < 40; i++) {
    const z = -9400 - r() * 9000;
    const x = 660 - 150 - r() * 450 + Math.max(0, -z - 8600) * 0.06;
    const h = r() < 0.3 ? 25 + r() * 60 : 6 + r() * 12;
    B.block(new THREE.Vector3(x, h / 2, z), 15 + r() * 25, h, 15 + r() * 30);
  }
  const blds = B.build(bldg);
  blds.castShadow = false;
  group.add(blds);

  return group;
}
