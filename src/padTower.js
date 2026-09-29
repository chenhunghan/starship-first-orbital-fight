import * as THREE from 'three';
import { BeamBuilder, GEO, V } from './padKit.js';

// Orbital Launch Integration Tower 1 (Pad A): nine 15 m lattice modules of
// concrete-filled box columns with wide-flange girders and X bracing, internal
// stair & elevator cores, propellant risers, the chopstick carriage riding on
// rails on the pad-facing columns, the 36 m chopsticks (opened for launch),
// the ship quick-disconnect arm (swung back), crown with sheaves, lightning
// mast and aviation lights. Total height ~146 m.

export const TOWER_HALF = 5.6;
export const SEC_H = 15;
export const N_SEC = 9;
export const CHOP_Y = 124;
export const SQD_Y = 96;
// ship QD arm swing-away window (mission time, s)
export const SQD_RETRACT = [-9, -3];

export function buildTower(M, TP, opts = {}) {
  const g = new THREE.Group();
  g.name = 'tower';
  const tx = TP.x, tz = TP.z, half = TOWER_HALF;
  const top = N_SEC * SEC_H;

  const col = new BeamBuilder(); // box columns & heavy plates (tower paint)
  const ib = new BeamBuilder(); // I-beams (tower paint)
  const galv = new BeamBuilder(); // grating, stairs, rails, cable trays
  const pipe = new BeamBuilder(); // risers (cyl, white insulated)
  const pipeG = new BeamBuilder(); // small cylinders (galv)
  const clad = new BeamBuilder(); // corrugated shielding
  const conc = new BeamBuilder();
  const lights = [];

  const cornerXZ = [[-1, -1], [1, -1], [1, 1], [-1, 1]]; // around the tower
  const C = (i, y, inset = 0) => {
    const [sx, sz] = cornerXZ[i & 3];
    return V(tx + sx * (half - inset), y, tz + sz * (half - inset));
  };
  // faces: between corner f and f+1 ; outward normals
  const faceN = [V(0, 0, -1), V(1, 0, 0), V(0, 0, 1), V(-1, 0, 0)];
  const alongFace = (f) => V().subVectors(C(f + 1, 0), C(f, 0)).normalize();

  // ---------------------------------------------------------- lattice
  const CW = 1.3; // column width
  for (let i = 0; i < 4; i++) col.beam(C(i, 0), C(i, top + 0.4), CW, CW);
  for (let s = 0; s < N_SEC; s++) {
    const y0 = s * SEC_H, ym = y0 + SEC_H / 2, y1 = y0 + SEC_H;
    // splice plates at module joints
    for (let i = 0; i < 4; i++) col.block(C(i, y0 + 0.2), CW + 0.35, 0.5, CW + 0.35);
    for (let f = 0; f < 4; f++) {
      const n = faceN[f], t = alongFace(f);
      const pa = (y) => C(f, y).addScaledVector(t, CW / 2);
      const pb = (y) => C(f + 1, y).addScaledVector(t, -CW / 2);
      ib.beam(pa(y0 + 0.9), pb(y0 + 0.9), 0.6, 1.1, n);
      ib.beam(pa(ym), pb(ym), 0.5, 0.8, n);
      for (const [ya, yb] of [[y0 + 1.4, ym - 0.4], [ym + 0.4, y1 + 0.4]]) {
        ib.beam(pa(ya), pb(yb), 0.45, 0.6, n);
        ib.beam(pb(ya), pa(yb), 0.45, 0.6, n);
        // gusset at the X crossing and at the column ends
        const xc = pa((ya + yb) / 2).lerp(pb((ya + yb) / 2), 0.5);
        col.obox(xc, 1.2, 1.2, 0.08, new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), n));
        for (const [p, sgn] of [[pa(ya), 1], [pb(ya), -1], [pa(yb), 1], [pb(yb), -1]]) {
          col.obox(p.clone().addScaledVector(t, sgn * 0.5), 1.1, 1.3, 0.07, new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), n));
        }
      }
    }
    // plan bracing & floor grating at each module
    ib.beam(C(0, y0 + 0.9, CW / 2), C(2, y0 + 0.9, CW / 2), 0.35, 0.5, V(0, 1, 0));
    galv.block(V(tx, y0 + 1.55, tz), 2 * half - 1.4, 0.12, 2 * half - 1.4);
    if (s % 2 === 1) galv.block(V(tx, ym + 0.45, tz - 2.4), 2 * half - 1.4, 0.1, 4.4);
  }

  // stair core (west side, inside the lattice)
  const sx0 = tx - 4.4, sx1 = tx - 1.8, szA = tz - 3.9, szB = tz - 2.7;
  for (const [x, z] of [[sx0 - 0.3, szA - 0.7], [sx1 + 0.3, szA - 0.7], [sx0 - 0.3, szB + 0.7], [sx1 + 0.3, szB + 0.7]]) galv.beam(V(x, 0, z), V(x, top, z), 0.18);
  const rise = 2.5;
  for (let y = 0.3, n = 0; y + rise <= top + 0.3; y += rise, n++) {
    const z = n % 2 ? szB : szA;
    const [xa, xb] = n % 2 ? [sx1, sx0] : [sx0, sx1];
    galv.beam(V(xa, y, z), V(xb, y + rise, z), 1.1, 0.28, V(0, 0, 1));
    galv.beam(V(xa, y + 1.0, z + (n % 2 ? 0.55 : -0.55)), V(xb, y + rise + 1.0, z + (n % 2 ? 0.55 : -0.55)), 0.06);
    galv.block(V(xb + (n % 2 ? -0.6 : 0.6), y + rise, (szA + szB) / 2), 1.2, 0.12, 2.5);
  }
  // elevator shaft (east-rear) with a car parked at the SQD level
  const ex = tx + 3.1, ez = tz - 3.1;
  for (const [dx, dz] of [[-1.4, -1.4], [1.4, -1.4], [1.4, 1.4], [-1.4, 1.4]]) galv.beam(V(ex + dx, 0, ez + dz), V(ex + dx, top, ez + dz), 0.22);
  for (let y = 3; y < top; y += 3) {
    for (const [a, b] of [[[-1.4, -1.4], [1.4, -1.4]], [[1.4, -1.4], [1.4, 1.4]], [[1.4, 1.4], [-1.4, 1.4]], [[-1.4, 1.4], [-1.4, -1.4]]]) {
      galv.beam(V(ex + a[0], y, ez + a[1]), V(ex + b[0], y, ez + b[1]), 0.12);
    }
  }
  clad.block(V(ex, SQD_Y + 1.6, ez), 2.5, 3.2, 2.5);
  clad.block(V(ex, 30, ez + 1.0), 2.4, 60, 0.12);

  // propellant / GN2 / water risers on the east face up to the SQD
  const rx = tx - half - 1.25;
  const risers = [[tz - 2.6, 0.95], [tz - 1.2, 0.95], [tz + 0.2, 0.6], [tz + 1.3, 0.45]];
  for (const [z, d] of risers) pipe.beam(V(rx, 0.9, z), V(rx, SQD_Y - 1.2, z), d);
  for (let y = 5; y < SQD_Y - 2; y += SEC_H / 2) galv.block(V(rx + 0.3, y + 0.9, tz - 0.6), 1.6, 0.3, 4.8);
  // horizontal run to the SQD pivot
  for (const [z, d] of risers) {
    const yy = SQD_Y - 1.2 - (z - tz) * 0.0;
    pipe.beam(V(rx, yy, z), V(rx, yy, tz + half + 1.0), d);
    pipe.beam(V(rx, yy, tz + half + 1.0), V(rx - 0.6, yy, tz + half + 1.9), d);
  }
  // cable trays: west and north faces
  for (const [x, z, w, dp] of [[tx + half + 0.55, tz + 1.5, 0.12, 0.9], [tx + half + 0.55, tz - 0.2, 0.12, 0.9], [tx + 1.0, tz - half - 0.55, 0.9, 0.12]]) {
    galv.beam(V(x, 1, z), V(x, top - 1, z), w, dp, V(1, 0, 0));
  }

  // lower shielding (corrugated) on the rear and west faces
  clad.block(V(tx, 14, tz - half - 0.75), 2 * half + 1.4, 28, 0.18);
  clad.block(V(tx - half - 0.75, 10, tz - 1.2), 0.18, 20, 2 * half - 1.2);
  clad.block(V(tx + half + 0.5, 9.5, tz - 3.8), 0.18, 7, 3.2);

  // --------------------------------------------------------- foundation
  conc.block(V(tx, 0.6, tz), 2 * half + 4, 1.2, 2 * half + 4);
  for (let i = 0; i < 4; i++) conc.block(C(i, 1.5), 2.6, 1.8, 2.6);
  // drawworks house west of the tower + winch cable tunnel
  clad.block(V(tx - half - 9, 4, tz - 1), 10, 8, 13);
  galv.block(V(tx - half - 3.5, 7.5, tz - 1), 3.2, 1.2, 1.6);

  // ------------------------------------------------ carriage rails
  const railZ = tz + half + CW / 2 + 0.5;
  for (const s of [-1, 1]) col.beam(V(tx + s * half, 1.5, railZ), V(tx + s * half, top - 0.5, railZ), 0.75, 1.0);
  // rear guide on the NW column (third pillar)
  col.beam(V(tx - half - CW / 2 - 0.45, 1.5, tz - half), V(tx - half - CW / 2 - 0.45, top - 0.5, tz - half), 0.9, 0.7);

  // ------------------------------------------------------- carriage
  const cy0 = CHOP_Y - 5.5, cy1 = CHOP_Y + 5.5;
  const fz = railZ + 1.3; // front frame plane
  const cxw = half + 1.8;
  const frame = (a, b, w = 0.8) => col.beam(a, b, w, w);
  for (const y of [cy0, cy1, CHOP_Y]) frame(V(tx - cxw, y, fz), V(tx + cxw, y, fz), y === CHOP_Y ? 0.5 : 0.9);
  const xs = [-cxw, -3.6, 0, 3.6, cxw];
  for (const x of xs) frame(V(tx + x, cy0, fz), V(tx + x, cy1, fz), 0.7);
  for (let i = 0; i < xs.length - 1; i++) {
    ib.beam(V(tx + xs[i], cy0, fz), V(tx + xs[i + 1], CHOP_Y, fz), 0.4, 0.5, V(0, 0, 1));
    ib.beam(V(tx + xs[i], cy1, fz), V(tx + xs[i + 1], CHOP_Y, fz), 0.4, 0.5, V(0, 0, 1));
  }
  // side frames wrapping the tower
  const rz = tz - half + 1.5;
  for (const s of [-1, 1]) {
    const x = tx + s * cxw;
    for (const y of [cy0, cy1]) frame(V(x, y, fz), V(x, y, rz), 0.8);
    for (let k = 0; k <= 3; k++) {
      const z = fz + (rz - fz) * (k / 3);
      frame(V(x, cy0, z), V(x, cy1, z), 0.6);
      if (k < 3) {
        const z2 = fz + (rz - fz) * ((k + 1) / 3);
        ib.beam(V(x, cy0, z), V(x, cy1, z2), 0.35, 0.5, V(1, 0, 0));
      }
    }
    // skates on the rails
    for (const y of [cy0 + 1, cy1 - 1]) col.block(V(tx + s * half, y, railZ + 0.2), 1.7, 2.2, 1.6);
    frame(V(tx + s * half, cy0 + 1, fz), V(tx + s * half, cy1 - 1, fz), 1.0);
  }
  // rear skate on the third pillar + back beam
  col.block(V(tx - half - CW / 2 - 0.45, CHOP_Y, tz - half), 1.4, 3, 1.6);
  frame(V(tx - cxw, cy0, rz), V(tx - half - 1.2, CHOP_Y, tz - half), 0.6);

  // --------------------------------------------------- chopsticks
  const armL = 36, W = 2.4;
  const open = opts.chopOpen ?? 0.62;
  const topY = CHOP_Y + 1.8;
  for (const s of [-1, 1]) {
    const pivot = V(tx + s * (cxw - 0.4), CHOP_Y, fz + 1.2);
    // hinge column with bearing housings
    pipeG.beam(pivot.clone().setY(cy0 - 0.6), pivot.clone().setY(cy1 + 0.6), 1.9);
    for (const y of [cy0 + 0.4, cy1 - 0.4]) col.block(pivot.clone().setY(y), 2.6, 1.2, 2.6);
    col.beam(pivot.clone().setY(cy0 + 0.4), V(tx + s * (cxw - 0.4), cy0 + 0.4, fz), 1.2, 1.0);
    col.beam(pivot.clone().setY(cy1 - 0.4), V(tx + s * (cxw - 0.4), cy1 - 0.4, fz), 1.2, 1.0);

    const d = V(s * Math.sin(open), 0, Math.cos(open));
    const vin = V(-s * Math.cos(open), 0, Math.sin(open)); // toward the other arm
    const hAt = (u) => 5.4 - 2.6 * (u / armL);
    const P = (u, lat, up) => pivot.clone().addScaledVector(d, u).addScaledVector(vin, lat).setY(up === 1 ? topY : topY - hAt(u));
    const u0 = 1.6;
    // chords
    for (const lat of [W / 2, -W / 2]) {
      ib.beam(P(u0, lat, 1), P(armL, lat, 1), 0.6, lat > 0 ? 0.8 : 0.55, V(0, 1, 0).cross(d));
      ib.beam(P(u0, lat, 0), P(armL, lat, 0), 0.5, 0.5, V(0, 1, 0).cross(d));
    }
    const nP = 12;
    for (let i = 0; i <= nP; i++) {
      const u = u0 + ((armL - u0) * i) / nP;
      for (const lat of [W / 2, -W / 2]) col.beam(P(u, lat, 0), P(u, lat, 1), 0.3, 0.3, d);
      col.beam(P(u, W / 2, 1), P(u, -W / 2, 1), 0.28, 0.28, d);
      col.beam(P(u, W / 2, 0), P(u, -W / 2, 0), 0.28, 0.28, d);
      if (i < nP) {
        const u2 = u0 + ((armL - u0) * (i + 1)) / nP;
        const sg = i % 2 ? 1 : 0;
        for (const lat of [W / 2, -W / 2]) col.beam(P(sg ? u : u2, lat, 0), P(sg ? u2 : u, lat, 1), 0.24, 0.24, vin);
        col.beam(P(u, W / 2, 1), P(u2, -W / 2, 1), 0.2, 0.2, V(0, 1, 0));
        col.beam(P(u, -W / 2, 0), P(u2, W / 2, 0), 0.2, 0.2, V(0, 1, 0));
      }
    }
    // plated hinge knuckle and tip cap
    const kc = pivot.clone().addScaledVector(d, 1.4).setY(topY - hAt(0) / 2);
    col.obox(kc, W + 0.5, hAt(0) + 0.2, 3.2, new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), d));
    const tc = pivot.clone().addScaledVector(d, armL + 0.15).setY(topY - hAt(armL) / 2);
    col.obox(tc, W + 0.3, hAt(armL) + 0.2, 0.35, new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), d));
    // catch rail (landing rail) along the inner top edge + shock-absorber sled
    const rl = (u) => P(u, W / 2 - 0.35, 1).add(V(0, 0.75, 0));
    galv.beam(rl(6), rl(armL - 0.6), 1.2, 0.9, V(0, 1, 0).cross(d));
    const sled = rl(19).add(V(0, 0.65, 0));
    galv.obox(sled, 1.6, 1.0, 3.2, new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), d));
    // hydraulic actuator from the carriage to the arm
    pipeG.beam(V(tx + s * 2.2, CHOP_Y - 1.2, fz + 0.3), P(7, W / 2, 0).add(V(0, 0.8, 0)), 0.7);
    pipeG.beam(V(tx + s * 2.2, CHOP_Y + 1.2, fz + 0.3), P(7, W / 2, 1).add(V(0, -0.8, 0)), 0.5);
    // cable/hose tray on the outer side
    galv.beam(P(u0, -W / 2 - 0.25, 1).add(V(0, -0.6, 0)), P(armL - 1, -W / 2 - 0.25, 1).add(V(0, -0.6, 0)), 0.1, 0.6, d);
  }
  // hoist cables to the crown sheaves
  for (const x of [-2.6, -1.4, 1.4, 2.6]) pipeG.beam(V(tx + x, cy1 + 0.4, fz - 0.2), V(tx + x, top + 2.2, fz - 0.2), 0.09);

  // ------------------------------------------ ship quick-disconnect arm
  // Built around its pivot in local space (arm along +x) so it can swing: it is
  // mated to the ship's aft section until shortly before liftoff, then swings
  // back beside the tower.
  {
    const pv = V(tx - half - 1.9, SQD_Y, tz + half + 1.9);
    pipeG.beam(pv.clone().setY(SQD_Y - 4.5), pv.clone().setY(SQD_Y + 3.5), 1.5);
    col.block(V(tx - half - 1.4, SQD_Y - 4.2, tz + half + 0.6), 3.4, 0.6, 3.6);
    ib.beam(V(tx - half, SQD_Y - 10, tz + half), V(tx - half - 2.8, SQD_Y - 4.4, tz + half + 1.8), 0.4, 0.6);
    const aCol = new BeamBuilder(), aGalv = new BeamBuilder(), aPipe = new BeamBuilder();
    const reach = Math.hypot(pv.x, pv.z); // pivot to vehicle axis
    const shR = 4.75, span = 0.8;
    const L = reach - shR - 1.2 - 1.3 - 0.15, H = 3.2, AW = 2.6;
    const d = V(1, 0, 0), lat = V(0, 0, 1);
    const Q = (u, l, h) => V(u, h, l);
    for (const l of [-AW / 2, AW / 2]) for (const h of [-H / 2, H / 2]) aCol.beam(Q(1, l, h), Q(L, l, h), 0.4, 0.4, lat);
    const nS = 7;
    for (let i = 0; i <= nS; i++) {
      const u = 1 + ((L - 1) * i) / nS;
      for (const l of [-AW / 2, AW / 2]) aCol.beam(Q(u, l, -H / 2), Q(u, l, H / 2), 0.26, 0.26, d);
      aCol.beam(Q(u, -AW / 2, H / 2), Q(u, AW / 2, H / 2), 0.24, 0.24, d);
      if (i < nS) {
        const u2 = 1 + ((L - 1) * (i + 1)) / nS;
        for (const l of [-AW / 2, AW / 2]) aCol.beam(Q(u, l, -H / 2), Q(u2, l, H / 2), 0.2, 0.2, lat);
      }
    }
    aCol.block(V(0.6, 0, 0), 2.4, H + 1.2, 2.4);
    aGalv.beam(Q(1, 0, -H / 2 + 0.1), Q(L, 0, -H / 2 + 0.1), AW, 0.12, lat);
    for (const l of [-AW / 2 + 0.1, AW / 2 - 0.1]) aGalv.beam(Q(1, l, -H / 2 + 1.2), Q(L, l, -H / 2 + 1.2), 0.06);
    aPipe.beam(Q(0, AW / 2 + 0.4, 0.4), Q(L - 0.3, AW / 2 + 0.4, 0.4), 0.55);
    aPipe.beam(Q(0, AW / 2 + 0.4, -0.6), Q(L - 0.3, AW / 2 + 0.4, -0.6), 0.55);
    aPipe.beam(Q(0, -AW / 2 - 0.35, 0.0), Q(L - 0.3, -AW / 2 - 0.35, 0.0), 0.4);
    // QD head: hood box, top cover and the curved interface plate
    aCol.block(Q(L + 1.2, 0, 0), 2.6, 4.4, 3.6);
    aCol.block(Q(L + 0.9, 0, 2.6), 3.8, 0.35, 4.2);
    aCol.block(Q(L + 2.4, 0, -1.0), 0.6, 1.6, 2.6);
    const shell = new THREE.CylinderGeometry(shR, shR, 4.2, 12, 1, true, 0, span);
    shell.rotateY(-Math.PI / 2 - span / 2);
    shell.translate(L + 1.2 + 1.3 + shR, 0, 0);
    const arm = new THREE.Group();
    arm.name = 'ship-qd-arm';
    arm.position.copy(pv);
    const shM = new THREE.Mesh(shell, M.olm2);
    shM.castShadow = true; shM.receiveShadow = true;
    const armCol = aCol.build(M.tower);
    arm.add(shM, armCol, aGalv.build(M.galv), aPipe.build(M.white, GEO.cyl));
    const mated = Math.atan2(pv.z, -pv.x); // local +x toward the vehicle axis
    const stowed = -Math.PI - 0.12; // beside the tower's west face
    const angleAt = (t) => {
      const k = THREE.MathUtils.clamp((t - SQD_RETRACT[0]) / (SQD_RETRACT[1] - SQD_RETRACT[0]), 0, 1);
      return mated + (stowed - mated) * (k * k * (3 - 2 * k));
    };
    arm.rotation.y = angleAt(-1e9);
    armCol.onBeforeRender = () => {
      const t = typeof window !== 'undefined' ? window.__app?.sim?.t : undefined;
      if (t === undefined) return;
      const r = angleAt(t);
      if (r !== arm.rotation.y) { arm.rotation.y = r; arm.updateMatrixWorld(true); }
    };
    g.add(arm);
  }

  // ------------------------------------------------------ platforms
  const platform = (cx, y, cz, w, dz) => {
    galv.block(V(cx, y, cz), w, 0.15, dz);
    for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [-1, 1, 1, 1], [-1, -1, -1, 1]]) {
      galv.beam(V(cx + (ax * w) / 2, y + 1.1, cz + (az * dz) / 2), V(cx + (bx * w) / 2, y + 1.1, cz + (bz * dz) / 2), 0.06);
    }
    for (let i = 0; i <= 4; i++) for (const zz of [-1, 1]) galv.beam(V(cx - w / 2 + (w * i) / 4, y, cz + (zz * dz) / 2), V(cx - w / 2 + (w * i) / 4, y + 1.1, cz + (zz * dz) / 2), 0.05);
  };
  platform(tx + half + 3.2, 58, tz + 1.5, 5.2, 6);
  ib.beam(V(tx + half, 52, tz + 1.5), V(tx + half + 5.4, 57.9, tz + 1.5), 0.35, 0.5);
  platform(tx + half + 2.6, 30, tz - 3.5, 4, 4);
  platform(tx - half - 2.2, 114, tz - 3, 3, 4);
  platform(tx, top + 0.8, tz, 2 * half + 2, 2 * half + 2);

  // ------------------------------------------------------------ crown
  col.block(V(tx, top + 0.5, tz), 2 * half + 1.8, 0.7, 2 * half + 1.8);
  col.block(V(tx, top + 2.4, tz + half - 1.6), 8.4, 3.2, 3.6);
  for (const x of [-3.2, -1.2, 1.2, 3.2]) pipeG.beam(V(tx + x - 0.2, top + 2.6, tz + half + 0.3), V(tx + x + 0.2, top + 2.6, tz + half + 0.3), 2.6);
  col.block(V(tx - 3, top + 1.6, tz - 3), 3, 2.2, 3);
  // lightning mast (tapered, stayed tripod base)
  const mastGeo = new THREE.CylinderGeometry(0.07, 0.32, 9.2, 8);
  mastGeo.translate(tx + 1.5, top + 1 + 4.6 + 1.0, tz - 2);
  const mast = new THREE.Mesh(mastGeo, M.galv);
  mast.castShadow = true;
  g.add(mast);
  for (const [dx, dz] of [[-1.6, -1.2], [1.6, -1.2], [0, 1.8]]) galv.beam(V(tx + 1.5 + dx, top + 0.9, tz - 2 + dz), V(tx + 1.5, top + 3.4, tz - 2), 0.14);
  galv.beam(V(tx + 1.5, top + 4.5, tz - 2), V(tx + 3.2, top + 4.5, tz - 2), 0.08);
  galv.block(V(tx + 3.3, top + 4.6, tz - 2), 0.3, 0.4, 0.3);
  lights.push(V(tx + 1.5, top + 11.3, tz - 2));

  // aviation obstruction lights on the corners
  for (const y of [top + 1.3, 104 - 30, 45]) for (let i = 0; i < 4; i++) lights.push(C(i, y).add(faceN[i].clone().multiplyScalar(0.8)));

  // --------------------------------------------------------- output
  g.add(col.build(M.tower));
  g.add(ib.build(M.tower, GEO.ibeam));
  g.add(galv.build(M.galv));
  g.add(pipe.build(M.white, GEO.cyl));
  g.add(pipeG.build(M.galv, GEO.cyl));
  g.add(clad.build(M.clad));
  g.add(conc.build(M.conc));
  const L = new BeamBuilder();
  for (const p of lights) L.block(p, 0.45, 0.45, 0.45);
  g.add(L.build(M.light, new THREE.SphereGeometry(0.5, 8, 6), false));
  return g;
}

// Lightweight lattice for the second tower (Pad B), seen only from afar.
export function buildFarTower(M, pos) {
  const B = new BeamBuilder();
  const half = TOWER_HALF;
  const C = (i, y) => V(pos.x + (i === 1 || i === 2 ? half : -half), y, pos.z + (i >= 2 ? half : -half));
  for (let i = 0; i < 4; i++) B.beam(C(i, 0), C(i, N_SEC * SEC_H), 1.25);
  for (let s = 0; s < N_SEC; s++) {
    const y0 = s * SEC_H, ym = y0 + SEC_H / 2, y1 = y0 + SEC_H;
    for (let f = 0; f < 4; f++) {
      const a = f, b = (f + 1) % 4;
      B.beam(C(a, y0 + 0.5), C(b, y0 + 0.5), 0.8);
      B.beam(C(a, y0 + 0.5), C(b, ym), 0.45);
      B.beam(C(b, y0 + 0.5), C(a, ym), 0.45);
      B.beam(C(a, ym), C(b, y1), 0.45);
      B.beam(C(b, ym), C(a, y1), 0.45);
    }
  }
  B.block(V(pos.x, N_SEC * SEC_H + 1, pos.z), 2 * half + 1.5, 2, 2 * half + 1.5);
  B.beam(V(pos.x, N_SEC * SEC_H + 2, pos.z), V(pos.x, N_SEC * SEC_H + 10, pos.z), 0.4);
  return B.build(M.tower);
}
