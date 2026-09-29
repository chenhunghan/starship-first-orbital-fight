import * as THREE from 'three';
import { rng } from './shared.js';
import { BeamBuilder, GEO, V, createMaterials, mergeGeometries } from './padKit.js';
import { buildMount } from './padMount.js';
import { buildTower, buildFarTower } from './padTower.js';

// Starbase Pad A: Orbital Launch Integration Tower (OLIT), Orbital Launch Mount
// (OLM) over the water-cooled steel deflector, the orbital tank farm with its
// pipe racks, deluge tanks, and the distant build site / Pad B / South Padre.
// Everything is procedural: instanced members + shader-only weathering.

export const TOWER_POS = new THREE.Vector3(0, 0, -27);
export const MOUNT_HEIGHT = 20;

// ----------------------------------------------------------- tank farm
function buildTankFarm(M) {
  const g = new THREE.Group();
  g.name = 'tank-farm';
  const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 40, 1, true);
  const domeGeo = new THREE.SphereGeometry(1, 40, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const capGeo = new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const steelParts = [], whiteParts = [];
  const galv = new BeamBuilder(), pipes = new BeamBuilder(), pipesW = new BeamBuilder(), conc = new BeamBuilder(), frame = new BeamBuilder();

  // vertical GSE tanks (LOX / LCH4 / LN2), stainless shells
  const vt = [];
  for (let i = 0; i < 5; i++) vt.push([i * 11, 100, 4.6, 30 - (i % 2) * 2, i === 4]);
  for (let i = 0; i < 4; i++) vt.push([5.5 + i * 11, 114, 4.4, 26, i === 0]);
  for (const [x, z, r, h, white] of vt) {
    (white ? whiteParts : steelParts).push(
      cylGeo.clone().scale(r, h, r).translate(x, h / 2 + 0.6, z),
      domeGeo.clone().scale(r, r * 0.3, r).translate(x, h + 0.6, z),
    );
    conc.block(V(x, 0.3, z), r * 2 + 1.6, 0.6, r * 2 + 1.6);
    // skirt ring and top handrail
    steelParts.push(cylGeo.clone().scale(r + 0.08, 0.5, r + 0.08).translate(x, 1.0, z));
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      galv.block(V(x + Math.cos(a) * r * 0.8, h + 0.6 + r * 0.3 * 0.6 + 0.55, z + Math.sin(a) * r * 0.8), 0.06, 1.1, 0.06);
    }
    // caged ladder & vent stack
    galv.block(V(x - r - 0.35, h / 2 + 0.6, z), 0.7, h, 0.7);
    pipes.beam(V(x + 1.2, h + 0.6 + r * 0.25, z), V(x + 1.2, h + 4.2, z), 0.35);
    // bottom outlet to the row header
    pipesW.beam(V(x, 2.0, z + (z < 107 ? -r : r)), V(x, 2.0, z + (z < 107 ? -r - 2.2 : r + 2.2)), 0.6);
  }
  // row headers
  pipesW.beam(V(-4, 2.0, 93.4), V(48, 2.0, 93.4), 0.8);
  pipesW.beam(V(0, 2.0, 120.6), V(44, 2.0, 120.6), 0.7);
  pipesW.beam(V(-4, 2.0, 120.6), V(-4, 2.0, 93.4), 0.7);

  // long low GSE structure with horizontal tanks (subcoolers / LN2)
  const z0 = 126.5, z1 = 134.5, x0 = -6, x1 = 72, hgt = 6;
  for (let x = x0; x <= x1 + 0.1; x += 7.8) {
    for (const z of [z0, z1]) frame.beam(V(x, 0, z), V(x, hgt, z), 0.4);
    frame.beam(V(x, hgt, z0), V(x, hgt, z1), 0.35);
    if (x + 7.8 <= x1 + 0.1) {
      for (const z of [z0, z1]) {
        frame.beam(V(x, hgt, z), V(x + 7.8, hgt, z), 0.35);
        frame.beam(V(x, 0.3, z), V(x + 7.8, hgt, z), 0.18);
      }
    }
  }
  galv.block(V((x0 + x1) / 2, hgt + 0.1, (z0 + z1) / 2), x1 - x0, 0.12, z1 - z0);
  for (let i = 0; i < 6; i++) {
    const cx = x0 + 6.8 + i * 12.4;
    whiteParts.push(new THREE.CylinderGeometry(1.8, 1.8, 11, 32, 1, true).rotateZ(Math.PI / 2).translate(cx, 2.6, (z0 + z1) / 2));
    for (const s of [-1, 1]) whiteParts.push(capGeo.clone().scale(1.8, 0.8, 1.8).rotateZ(-s * Math.PI / 2).translate(cx + s * 5.5, 2.6, (z0 + z1) / 2));
    for (const s of [-3.5, 3.5]) conc.block(V(cx + s, 0.45, (z0 + z1) / 2), 0.8, 0.9, 3.2);
  }
  conc.block(V((x0 + x1) / 2, 0.15, (z0 + z1) / 2), x1 - x0 + 3, 0.3, z1 - z0 + 3);
  // small equipment buildings
  frame.block(V(64, 3, 110), 10, 6, 14);
  frame.block(V(-14, 2.5, 108), 6, 5, 18);

  // pipe rack from the farm to the tower base
  const path = [V(50, 0, 90.5), V(30, 0, 90.5), V(30, 0, -36), V(8, 0, -36)];
  const lines = [[-1.4, 0.9, true], [-0.4, 0.9, true], [0.5, 0.6, false], [1.2, 0.5, false], [1.8, 0.4, false]];
  for (let s = 0; s < path.length - 1; s++) {
    const a = path[s], b = path[s + 1];
    const dir = V().subVectors(b, a); const len = dir.length(); dir.normalize();
    const side = V(-dir.z, 0, dir.x);
    for (let t = 0; t <= len; t += 6) {
      const p = a.clone().addScaledVector(dir, t);
      for (const o of [-2.2, 2.2]) frame.beam(p.clone().addScaledVector(side, o), p.clone().addScaledVector(side, o).setY(3.3), 0.3);
      frame.beam(p.clone().addScaledVector(side, -2.4).setY(3.3), p.clone().addScaledVector(side, 2.4).setY(3.3), 0.3, 0.4, dir);
      conc.block(p.clone().setY(0.2), 5.2, 0.4, 0.9, Math.atan2(dir.x, dir.z));
    }
    for (const [o, d, w] of lines) {
      const y = 3.45 + d / 2;
      const sgn = s === 1 ? 1 : 1;
      const pa = a.clone().addScaledVector(side, o * sgn).setY(y), pb = b.clone().addScaledVector(side, o * sgn).setY(y);
      (w ? pipesW : pipes).beam(pa.addScaledVector(dir, s > 0 ? -1.5 : 0), pb.addScaledVector(dir, s < path.length - 2 ? 1.5 : 0), d);
    }
  }

  const mk = (parts, mat) => {
    const m = new THREE.Mesh(mergeGeometries(parts), mat);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  };
  mk(steelParts, M.tank);
  mk(whiteParts, M.white);
  g.add(galv.build(M.galv), pipes.build(M.galv, GEO.cyl), pipesW.build(M.white, GEO.cyl), conc.build(M.conc), frame.build(M.tower));
  return g;
}

// secondary tank farm on the western GSE pad (as seen from afar)
function buildWestFarm(M, r) {
  const parts = [], white = [];
  const vt = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true);
  const dome = new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const tf = V(-250, 0, 110);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 2; j++) {
      const rad = 4.5 + r() * 0.8, h = 22 + r() * 8;
      const x = tf.x - 45 + i * 22, z = tf.z - 30 + j * 26;
      (j ? white : parts).push(vt.clone().scale(rad, h, rad).translate(x, h / 2, z), dome.clone().scale(rad, rad * 0.35, rad).translate(x, h, z));
    }
  }
  for (let i = 0; i < 5; i++) white.push(new THREE.CylinderGeometry(2.2, 2.2, 30, 24).rotateZ(Math.PI / 2).translate(tf.x + 10, 3, tf.z + 20 + i * 7));
  const g = new THREE.Group();
  for (const [p, m] of [[parts, M.tank], [white, M.white]]) {
    const mesh = new THREE.Mesh(mergeGeometries(p), m);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

export function createPad() {
  const group = new THREE.Group();
  group.name = 'pad';
  const r = rng(7);
  const M = createMaterials();

  group.add(buildTower(M, TOWER_POS));
  group.add(buildMount(M));
  group.add(buildTankFarm(M));
  group.add(buildWestFarm(M, r));

  // --------------------------------------- misc buildings & build site
  const B = new BeamBuilder();
  B.block(V(-180, 6, -120), 40, 12, 25);
  B.block(V(-120, 4, 200), 30, 8, 18);
  B.block(V(160, 5, -150), 22, 10, 22);
  // Starbase build site ~2.7 km west along Highway 4 (Mega Bays, High Bay)
  B.block(V(-2750, 45, 180), 60, 90, 45);
  B.block(V(-2830, 45, 180), 60, 90, 45);
  B.block(V(-2660, 40, 190), 30, 80, 30);
  B.block(V(-2950, 12, 210), 90, 24, 50);
  for (let i = 0; i < 18; i++) B.block(V(-2600 - r() * 700, 5, 280 + r() * 120), 15 + r() * 20, 6 + r() * 8, 10 + r() * 20);
  // Pad B tower (south of the main pad)
  group.add(buildFarTower(M, V(60, 0, -420)));
  // South Padre Island high-rises on the far side of the pass (north)
  for (let i = 0; i < 40; i++) {
    const z = -9400 - r() * 9000;
    const x = 660 - 150 - r() * 450 + Math.max(0, -z - 8600) * 0.06;
    const h = r() < 0.3 ? 25 + r() * 60 : 6 + r() * 12;
    B.block(V(x, h / 2, z), 15 + r() * 25, h, 15 + r() * 30);
  }
  const blds = B.build(M.bldg);
  blds.castShadow = false;
  group.add(blds);

  return group;
}
