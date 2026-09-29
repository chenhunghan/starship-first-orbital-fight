import * as THREE from 'three';
import { BeamBuilder, GEO, V, taperedBox, latheFlat, mergeGeometries } from './padKit.js';

// Orbital Launch Mount (Pad A, "stool" design, flights 2-11): six tapered
// concrete-and-steel legs carrying a donut launch table with 20 hold-down
// clamps and the booster quick disconnect (BQD) facing the tower, over the
// water-cooled perforated steel deflector plate.
//
// Vertical budget (MOUNT_HEIGHT = 20): engine exit plane at y = 20, booster
// skirt from y = 20.6; the clamp deck is at y = 20.35 and the table opening is
// never narrower than r = 5 m, flaring to 6.4 m at its underside (y = 13.8).

export const DECK_Y = 20.35;
export const RIM_Y = 21.4;
const RING_BOT = 13.8;
const RING_OUT = 11.2;

const polar = (r, a, y = 0) => V(Math.cos(a) * r, y, Math.sin(a) * r);
const radRot = (a) => Math.PI / 2 - a; // rotY that maps local +z onto radial dir a

export function buildMount(M) {
  const g = new THREE.Group();
  g.name = 'launch-mount';
  const mesh = (geo, mat, cast = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast; m.receiveShadow = true;
    g.add(m);
    return m;
  };

  const steel = new BeamBuilder(); // table hardware (M.olm)
  const steelI = new BeamBuilder(); // I-beam stiffeners (M.olm)
  const galv = new BeamBuilder(); // rails, stairs, grating (M.galv)
  const pipes = new BeamBuilder(); // cylinders (M.galv)
  const pipesW = new BeamBuilder(); // big water pipes (M.white)
  const conc = new BeamBuilder(); // concrete blocks
  const elbows = [];

  // ------------------------------------------------------------- legs
  const legAng = [0, 1, 2, 3, 4, 5].map((i) => (i * Math.PI) / 3);
  const legGeos = [], armourGeos = [];
  // splayed "stool" legs: wide flared feet leaning in to the table
  const R0 = 15.4, R1 = 9.8, LEG_H = RING_BOT + 0.4;
  const BW = 6.2, BD = 4.8, TW = 3.8, TD = 3.2;
  const lean = R0 - R1;
  for (const a of legAng) {
    const lg = taperedBox(BW, BD, TW, TD, LEG_H, 0, -lean);
    lg.rotateY(radRot(a));
    const p = polar(R0, a);
    lg.translate(p.x, 0, p.z);
    legGeos.push(lg);
    // steel armour on the inner (plume-facing) face
    const zi = (y) => -BD / 2 - (BD / 2 - TD / 2 + lean) * (y / LEG_H) - 0.1;
    const ya = 0.5, yb = LEG_H - 1.0;
    const ar = taperedBox(BW + 0.3 - (BW - TW) * (ya / LEG_H), 0.2, BW + 0.3 - (BW - TW) * (yb / LEG_H), 0.2, yb - ya, 0, zi(yb) - zi(ya));
    ar.translate(0, ya, zi(ya));
    ar.rotateY(radRot(a));
    ar.translate(p.x, 0, p.z);
    armourGeos.push(ar);
    // capital where the leg meets the table
    conc.block(polar(R1 + 0.3, a, RING_BOT - 0.9), 4.8, 1.8, 4.4, radRot(a));
    // footing
    conc.block(polar(R0 + 0.4, a, 0.35), 8.0, 0.7, 6.6, radRot(a));
    // steel corner guards (follow the taper)
    const t0 = V(Math.cos(a + Math.PI / 2), 0, Math.sin(a + Math.PI / 2));
    const r0 = polar(1, a);
    for (const [st, sr] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const k = 0.6 / LEG_H, k1 = (LEG_H - 1.0) / LEG_H;
      const b = polar(R0 - lean * k, a, 0.6).addScaledVector(t0, st * (BW + (TW - BW) * k) / 2).addScaledVector(r0, sr * (BD + (TD - BD) * k) / 2);
      const t = polar(R0 - lean * k1, a, LEG_H - 1.0).addScaledVector(t0, st * (BW + (TW - BW) * k1) / 2).addScaledVector(r0, sr * (BD + (TD - BD) * k1) / 2);
      steel.beam(b, t, 0.35, 0.35, t0);
    }
    // horizontal steel straps
    for (let y = 2.5; y < LEG_H - 1; y += 3) {
      const k = y / LEG_H;
      const rc = R0 - lean * k;
      const w = BW + (TW - BW) * k, d = BD + (TD - BD) * k;
      steel.block(polar(rc, a, y), w + 0.12, 0.28, d + 0.12, radRot(a));
    }
  }
  mesh(mergeGeometries(legGeos), M.conc);
  mesh(mergeGeometries(armourGeos), M.olm);

  // ------------------------------------------------------- launch table
  const ring = latheFlat([
    [10.4, RING_BOT], [RING_OUT, RING_BOT + 1.0], [RING_OUT, RIM_Y - 0.4], [RING_OUT - 0.4, RIM_Y],
    [7.6, RIM_Y], [7.6, DECK_Y], [5.0, DECK_Y], [5.0, DECK_Y - 1.15], [6.4, RING_BOT], [10.4, RING_BOT],
  ], 72);
  const bands = latheFlat([[RING_OUT, RIM_Y - 0.75], [RING_OUT + 0.45, RIM_Y - 0.75], [RING_OUT + 0.45, RIM_Y - 0.2], [RING_OUT, RIM_Y - 0.2], [RING_OUT, RIM_Y - 0.75]], 72);
  const band2 = latheFlat([[RING_OUT, RING_BOT + 1.0], [RING_OUT + 0.4, RING_BOT + 1.0], [RING_OUT + 0.4, RING_BOT + 1.5], [RING_OUT, RING_BOT + 1.5], [RING_OUT, RING_BOT + 1.0]], 72);
  mesh(mergeGeometries([ring, bands, band2]), M.olm);

  // outer shielding panels and vertical ribs (access doors every few bays)
  const nP = 48;
  for (let i = 0; i < nP; i++) {
    const a = ((i + 0.5) / nP) * Math.PI * 2;
    const w = (2 * Math.PI * RING_OUT) / nP;
    const door = i % 8 === 3;
    steel.block(polar(RING_OUT + 0.12, a, (RING_BOT + 1.5 + RIM_Y - 0.75) / 2), w - 0.12, RIM_Y - 0.75 - RING_BOT - 1.5 - 0.1, 0.16, radRot(a));
    if (door) steel.block(polar(RING_OUT + 0.24, a, RING_BOT + 3.4), w * 0.7, 2.4, 0.1, radRot(a));
    const ar = ((i) / nP) * Math.PI * 2;
    steel.block(polar(RING_OUT + 0.3, ar, (RING_BOT + RIM_Y) / 2), 0.22, RIM_Y - RING_BOT - 0.4, 0.5, radRot(ar));
  }
  // radial stiffeners under the table
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    steelI.beam(polar(6.7, a, RING_BOT - 0.35), polar(10.4, a, RING_BOT - 0.35), 0.35, 0.7, V(Math.cos(a + Math.PI / 2), 0, Math.sin(a + Math.PI / 2)));
  }
  // rim railing
  const rimR = RING_OUT - 0.3;
  for (let i = 0; i < 52; i++) {
    const a = (i / 52) * Math.PI * 2;
    if (Math.abs(Math.sin(a) + 1) < 0.02) continue;
    galv.block(polar(rimR, a, RIM_Y + 0.55), 0.07, 1.1, 0.07);
  }
  const railGeo = new THREE.TorusGeometry(rimR, 0.04, 4, 96);
  railGeo.rotateX(Math.PI / 2);
  const rail2 = railGeo.clone();
  railGeo.translate(0, RIM_Y + 1.1, 0);
  rail2.translate(0, RIM_Y + 0.6, 0);
  mesh(mergeGeometries([railGeo, rail2]), M.galv, false);
  // rim equipment: junction boxes, hydraulic accumulators, valve housings
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + 0.15;
    if (Math.sin(a) < -0.8) continue;
    const big = i % 3 === 0;
    steel.block(polar(big ? 9.2 : 8.6, a, RIM_Y + (big ? 0.7 : 0.45)), big ? 1.8 : 0.9, big ? 1.4 : 0.9, big ? 1.2 : 0.7, radRot(a));
    if (i % 2 === 1) pipes.beam(polar(9.8, a + 0.05, RIM_Y), polar(9.8, a + 0.05, RIM_Y + 1.6), 0.6);
  }

  // ------------------------------------------------ 20 hold-down clamps
  for (let k = 0; k < 20; k++) {
    const b = ((k * 18 + 9) * Math.PI) / 180;
    const rr = radRot(b);
    const rd = polar(1, b), tg = V(-Math.sin(b), 0, Math.cos(b));
    steel.block(polar(6.35, b, DECK_Y + 0.55), 1.05, 1.1, 2.3, rr);
    steel.block(polar(5.35, b, DECK_Y + 1.6), 0.8, 2.0, 0.8, rr);
    steel.block(polar(4.8, b, DECK_Y + 2.15), 0.55, 0.45, 0.42, rr);
    steel.block(polar(6.9, b, DECK_Y + 1.35), 0.7, 0.6, 0.9, rr);
    // sloped blast cover
    steel.beam(polar(5.0, b, DECK_Y + 2.75), polar(7.6, b, RIM_Y + 0.15), 1.2, 0.12, tg);
    // hydraulic cylinder
    pipes.beam(polar(7.0, b, DECK_Y + 0.8).addScaledVector(tg, 0.3), polar(5.75, b, DECK_Y + 2.3).addScaledVector(tg, 0.3), 0.3);
    void rd;
  }

  // -------------------------------------- booster quick disconnect (BQD)
  const bz = -1; // faces the tower (-z)
  steel.block(V(0, RIM_Y + 0.8, bz * 9.4), 5.6, 1.6, 3.6);
  steel.block(V(0, DECK_Y + 3.0, bz * 6.55), 3.8, 4.4, 3.0);
  steel.block(V(0, DECK_Y + 2.7, bz * 4.95), 2.8, 3.0, 0.25);
  steel.beam(V(0, DECK_Y + 5.6, bz * 4.9), V(0, RIM_Y + 2.0, bz * 10.6), 4.4, 0.2, V(1, 0, 0));
  for (const sx of [-1.9, 1.9]) steel.beam(V(sx, DECK_Y + 5.4, bz * 5.2), V(sx, RIM_Y + 1.5, bz * 10.2), 0.25, 0.5, V(1, 0, 0));
  // retract actuators
  for (const sx of [-1.2, 1.2]) pipes.beam(V(sx, RIM_Y + 1.8, bz * 10.8), V(sx, DECK_Y + 3.4, bz * 8.0), 0.35);
  // propellant lines from the BQD down to the ground and on to the tower
  for (const [sx, dia] of [[-1.25, 1.0], [1.25, 1.0], [2.8, 0.55]]) {
    const y0 = RIM_Y + 0.9, zr = bz * 12.9;
    pipesW.beam(V(sx, y0, bz * 8.4), V(sx, y0, zr), dia);
    pipesW.beam(V(sx, y0, zr), V(sx, 1.1, zr), dia);
    pipesW.beam(V(sx, 1.1, zr), V(sx, 1.1, -23.0), dia);
    elbows.push([V(sx, y0, zr), dia], [V(sx, 1.1, zr), dia]);
    for (let z = zr; z > -22.5; z -= 3) conc.block(V(sx, 0.35, z - 1.5), dia + 0.5, 0.7, 0.6);
  }
  for (let y = 3; y < RIM_Y; y += 4) galv.block(V(0.8, y, bz * 13.5), 5.2, 0.3, 0.3);

  // ------------------------------------------------------ water deluge
  const dRing = new THREE.TorusGeometry(RING_OUT + 0.75, 0.38, 8, 96);
  dRing.rotateX(Math.PI / 2);
  dRing.translate(0, RIM_Y - 0.9, 0);
  const uRing = new THREE.TorusGeometry(8.5, 0.32, 8, 80);
  uRing.rotateX(Math.PI / 2);
  uRing.translate(0, RING_BOT - 1.1, 0);
  mesh(mergeGeometries([dRing, uRing]), M.white);
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    steel.block(polar(RING_OUT + 0.45, a, RIM_Y - 0.9), 0.25, 0.25, 0.9, radRot(a));
    pipes.beam(polar(8.5, a, RING_BOT - 1.1), polar(8.1, a, RING_BOT - 1.9), 0.18);
  }
  for (const a of [legAng[1], legAng[3], legAng[5]]) {
    const ao = a + Math.PI / 6;
    const bot = polar(12.6, ao, 0.9), top = polar(12.6, ao, RIM_Y - 0.9);
    pipesW.beam(bot, top, 0.7);
    pipesW.beam(top, polar(RING_OUT + 0.75, ao, RIM_Y - 0.9), 0.7);
    pipesW.beam(polar(12.6, ao, RING_BOT - 1.1), polar(8.5, ao, RING_BOT - 1.1), 0.5);
    elbows.push([top, 0.7], [bot, 0.7]);
    for (let y = 3; y < RIM_Y - 1; y += 4) galv.block(polar(12.25, ao, y), 0.3, 0.3, 0.8, radRot(ao));
  }

  // ------------------------------------ deflector plate & foundation
  const slab = new THREE.CylinderGeometry(24, 24.6, 0.3, 6, 1);
  slab.rotateY(Math.PI / 6);
  slab.translate(0, 0.12, 0);
  mesh(slab, M.conc, false);
  const plate = new THREE.CylinderGeometry(14.2, 14.9, 0.5, 6, 1);
  plate.translate(0, 0.3, 0);
  const hub = new THREE.CylinderGeometry(3.2, 3.6, 0.25, 6, 1);
  hub.translate(0, 0.6, 0);
  mesh(mergeGeometries([plate, hub]), M.plate);
  // plate edge manifold and radial feed headers between the legs
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    pipes.beam(polar(14.4, a - 0.45, 0.75), polar(14.4, a + 0.45, 0.75), 0.9);
  }
  const feedAng = [-Math.PI / 6, Math.PI / 6];
  for (const a of feedAng) {
    pipesW.beam(polar(14.6, a, 0.95), polar(40, a, 0.95), 1.5);
    elbows.push([polar(40, a, 0.95), 1.5]);
    for (let r = 17; r < 40; r += 5) conc.block(polar(r, a, 0.3), 1.2, 0.6, 2.2, radRot(a));
  }
  const e0 = polar(40, feedAng[0], 0.95), e1 = polar(40, feedAng[1], 0.95);
  pipesW.beam(e0, e1, 1.5);
  pipesW.beam(e0, V(70, 0.95, -52), 1.5);
  for (let t = 0.1; t < 1; t += 0.12) conc.block(e0.clone().lerp(V(70, 0.95, -52), t).setY(0.3), 2.2, 0.6, 2.2);

  // deluge water tanks (pressurised, north-east of the mount)
  const tankGeo = new THREE.CylinderGeometry(1, 1, 1, 32, 1);
  const domeGeo = new THREE.SphereGeometry(1, 32, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const tanks = [];
  for (const [x, z] of [[72, -60], [83, -60], [94, -60], [72, -71], [83, -71], [94, -71]]) {
    const t = tankGeo.clone().scale(4.5, 20, 4.5).translate(x, 10.6, z);
    const d = domeGeo.clone().scale(4.5, 1.8, 4.5).translate(x, 20.6, z);
    tanks.push(t, d);
    conc.block(V(x, 0.3, z), 10, 0.6, 10);
  }
  mesh(mergeGeometries(tanks), M.white);

  // -------------------------------------------- mount stair tower (SW)
  const sa = (150 * Math.PI) / 180;
  const sc = polar(17.2, sa);
  const sr = radRot(sa);
  const ex = V(Math.cos(sa + Math.PI / 2), 0, Math.sin(sa + Math.PI / 2)), er = polar(1, sa);
  const cornerS = (i, j, y) => sc.clone().addScaledVector(ex, i * 1.9).addScaledVector(er, j * 1.9).setY(y);
  for (const [i, j] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) galv.beam(cornerS(i, j, 0.3), cornerS(i, j, RIM_Y + 1.2), 0.22);
  for (let y = 0.3, n = 0; y <= RIM_Y + 0.1; y += (RIM_Y - 0.3) / 7, n++) {
    for (const [a, b] of [[[1, 1], [1, -1]], [[1, -1], [-1, -1]], [[-1, -1], [-1, 1]], [[-1, 1], [1, 1]]]) galv.beam(cornerS(...a, y), cornerS(...b, y), 0.16);
    const yb = y + (RIM_Y - 0.3) / 7;
    if (yb <= RIM_Y + 0.2) {
      galv.beam(cornerS(1, 1, y), cornerS(1, -1, yb), 0.1);
      galv.beam(cornerS(-1, 1, y), cornerS(1, 1, yb), 0.1);
      // stair flight inside
      const lane = n % 2 ? 0.55 : -0.55;
      const a0 = sc.clone().addScaledVector(ex, lane).addScaledVector(er, n % 2 ? 1.3 : -1.3).setY(y + 0.1);
      const a1 = sc.clone().addScaledVector(ex, lane).addScaledVector(er, n % 2 ? -1.3 : 1.3).setY(yb);
      galv.beam(a0, a1, 1.0, 0.18, ex);
      galv.block(sc.clone().addScaledVector(er, n % 2 ? -1.5 : 1.5).setY(yb), 2.4, 0.12, 0.9, sr);
    }
  }
  // bridge to the rim
  const bA = polar(RING_OUT - 0.2, sa, RIM_Y - 0.05), bB = polar(15.4, sa, RIM_Y - 0.05);
  galv.beam(bA, bB, 1.4, 0.15, ex);
  for (const s of [-0.7, 0.7]) galv.beam(bA.clone().addScaledVector(ex, s).setY(RIM_Y + 1.0), bB.clone().addScaledVector(ex, s).setY(RIM_Y + 1.0), 0.06);

  // ------------------------------------------------------------- output
  g.add(steel.build(M.olm));
  g.add(steelI.build(M.olm, GEO.ibeam));
  g.add(galv.build(M.galv));
  g.add(pipes.build(M.galv, GEO.cyl));
  g.add(pipesW.build(M.white, GEO.cyl));
  g.add(conc.build(M.conc));
  const sph = new THREE.SphereGeometry(0.5, 12, 8);
  const E = new BeamBuilder();
  for (const [p, d] of elbows) E.block(p, d * 1.02, d * 1.02, d * 1.02);
  g.add(E.build(M.white, sph));
  return g;
}
