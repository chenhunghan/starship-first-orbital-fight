// Flight dynamics for Super Heavy + Starship.
//
// The vehicle is integrated in a 2D Earth-centred inertial plane (the plane that
// contains the pad and the launch azimuth). Gravity is inverse-square, the
// atmosphere is the US Standard Atmosphere 1976 and co-rotates with the Earth,
// engine thrust depends on ambient pressure (F = Fvac - pa*Ae) and propellant is
// consumed at mdot = Fvac / (Isp_vac * g0). Drag uses a Mach dependent Cd.
//
// Rendering consumes positions in the pad's local tangent frame (metres):
//   s = along the launch azimuth, y = up (including Earth curvature drop).

export const G0 = 9.80665;
export const MU = 3.986004418e14;
export const RE = 6371000;
const P0 = 101325;
const LAT = 25.997 * Math.PI / 180;           // Starbase latitude
export const LAUNCH_AZIMUTH = 109 * Math.PI / 180; // south-east over the Gulf for a ~32 deg orbit (Flight 14)
// Effective rotation rate of the launch plane (surface speed along azimuth).
export const OMEGA = (7.2921159e-5 * RE * Math.cos(LAT) * Math.sin(LAUNCH_AZIMUTH)) / RE;

// ---------------------------------------------------------------- atmosphere
const LAYERS = [
  // base geopotential height (m), lapse (K/m), base T (K), base P (Pa)
  [0, -0.0065, 288.15, 101325],
  [11000, 0, 216.65, 22632.06],
  [20000, 0.001, 216.65, 5474.889],
  [32000, 0.0028, 228.65, 868.0187],
  [47000, 0, 270.65, 110.9063],
  [51000, -0.0028, 270.65, 66.93887],
  [71000, -0.002, 214.65, 3.956420],
  [84852, 0, 186.946, 0.3733836],
];
const RAIR = 287.053;
export function atmosphere(hGeometric) {
  const h = Math.max(-500, (RE * hGeometric) / (RE + hGeometric)); // geopotential
  let i = LAYERS.length - 1;
  while (i > 0 && h < LAYERS[i][0]) i--;
  const [hb, L, Tb, Pb] = LAYERS[i];
  let T, p;
  if (i === LAYERS.length - 1) {
    T = Tb;
    p = Pb * Math.exp(-(h - hb) / 6500); // thermosphere-ish tail
  } else if (L === 0) {
    T = Tb;
    p = Pb * Math.exp((-G0 * (h - hb)) / (RAIR * Tb));
  } else {
    T = Tb + L * (h - hb);
    p = Pb * Math.pow(T / Tb, -G0 / (RAIR * L));
  }
  const rho = p / (RAIR * T);
  return { T, p, rho, a: Math.sqrt(1.4 * RAIR * T) };
}

// Drag coefficient of a slender cylinder with an ogive nose vs Mach.
function cdMach(M) {
  const pts = [[0, 0.32], [0.6, 0.34], [0.85, 0.42], [1.0, 0.62], [1.2, 0.68], [1.6, 0.56], [2.5, 0.42], [4, 0.33], [8, 0.28], [30, 0.25]];
  if (M <= 0) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (M < pts[i][0]) {
      const [m0, c0] = pts[i - 1], [m1, c1] = pts[i];
      return c0 + ((c1 - c0) * (M - m0)) / (m1 - m0);
    }
  }
  return pts[pts.length - 1][1];
}

// ------------------------------------------------------------------ engines
export const RAPTOR_SL = { name: 'Raptor 3', Fsl: 2.75e6, Fvac: 2.94e6, IspVac: 350, minThrottle: 0.4, exitD: 1.3 };
export const RAPTOR_VAC = { name: 'Raptor 3 Vacuum', Fsl: 1.6e6, Fvac: 3.0e6, IspVac: 380, minThrottle: 0.4, exitD: 2.3 };
for (const e of [RAPTOR_SL, RAPTOR_VAC]) {
  e.Ae = (e.Fvac - e.Fsl) / P0; // effective exit area (pressure thrust loss)
  e.mdot = e.Fvac / (e.IspVac * G0);
}

class Engine {
  constructor(type, x, z, ring, index) {
    this.type = type;
    this.x = x; this.z = z; // position in the stage frame (m) — for rendering
    this.ring = ring;
    this.index = index;
    this.cmd = 0;         // commanded throttle (0 = off)
    this.level = 0;       // actual throttle, with spool-up dynamics
    this.startDelay = 0;  // seconds until the engine responds to a start command
    this.health = 1;
  }
  update(dt) {
    let target = this.cmd;
    if (target > 0 && this.startDelay > 0) { this.startDelay -= dt; target = 0; }
    // Raptor start transient ~1.2 s to full thrust, shutdown ~0.4 s
    const rate = target > this.level ? 0.9 : 2.8;
    this.level += Math.sign(target - this.level) * Math.min(Math.abs(target - this.level), rate * dt);
  }
  thrust(pa) { return this.level > 0.01 ? Math.max(0, this.type.Fvac * this.level - pa * this.type.Ae) : 0; }
  mdot() { return this.level > 0.01 ? this.type.mdot * this.level : 0; }
}

function boosterEngines() {
  const list = [];
  let i = 0;
  // 3 centre (gimballed), 10 inner ring, 20 outer ring (fixed)
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 + Math.PI / 2; list.push(new Engine(RAPTOR_SL, 0.78 * Math.cos(a), 0.78 * Math.sin(a), 0, i++)); }
  for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2 + 0.31; list.push(new Engine(RAPTOR_SL, 2.3 * Math.cos(a), 2.3 * Math.sin(a), 1, i++)); }
  for (let k = 0; k < 20; k++) { const a = (k / 20) * Math.PI * 2; list.push(new Engine(RAPTOR_SL, 3.78 * Math.cos(a), 3.78 * Math.sin(a), 2, i++)); }
  return list;
}
function shipEngines() {
  const list = [];
  let i = 0;
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 + Math.PI / 2; list.push(new Engine(RAPTOR_SL, 1.05 * Math.cos(a), 1.05 * Math.sin(a), 0, i++)); }
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 - Math.PI / 2; list.push(new Engine(RAPTOR_VAC, 3.0 * Math.cos(a), 3.0 * Math.sin(a), 1, i++)); }
  return list;
}

// --------------------------------------------------------------------- stage
class Stage {
  constructor(name, dry, prop, length, engines) {
    this.name = name;
    this.dry = dry;
    this.prop = prop;
    this.propMax = prop;
    this.length = length;
    this.engines = engines;
    this.area = Math.PI * 4.5 * 4.5;
    this.X = 0; this.Y = RE; this.VX = 0; this.VY = 0; // inertial
    this.alpha = 0;         // nose direction angle (from +Y towards +X)
    this.alphaCmd = 0;
    this.slewRate = 6 * Math.PI / 180;
    this.phase = 'pad';
    this.active = true;
    this.heat = 0;
    this.maxQ = 0;
    this.telemetry = { h: 0, v: 0, vInertial: 0, mach: 0, q: 0, accel: 0, pa: P0, downrange: 0, vVert: 0, vHoriz: 0 };
  }
  mass() { return this.dry + this.prop; }
  command(filter, throttle, stagger = 0) {
    let n = 0;
    for (const e of this.engines) if (filter(e)) { e.cmd = throttle; if (stagger) e.startDelay = stagger(e, n++); }
  }
  litCount() { let n = 0; for (const e of this.engines) if (e.level > 0.05) n++; return n; }
}

// -------------------------------------------------------------- simulation
export const EVENTS = [];

export class FlightSim {
  constructor() { this.reset(); }

  reset() {
    this.t = -20;                 // mission elapsed time (T-20 s)
    this.booster = new Stage('Super Heavy', 230000, 4000000, 71, boosterEngines());
    this.ship = new Stage('Starship', 200000, 1600000, 52, shipEngines()); // dry + 26 Starlink V3
    this.stacked = true;
    this.released = false;
    this.events = [];
    this.flags = {};
    this.deluge = 0;              // water deluge flow 0..1
    this.padFire = 0;
    this.shake = 0;
    for (const s of [this.booster, this.ship]) {
      s.X = 0; s.Y = RE; s.alpha = 0; s.alphaCmd = 0;
      s.VX = OMEGA * RE; s.VY = 0;
    }
    this.ship.Y = RE + 71; // ship sits on top of the booster
    this.boosterTarget = 7500;
    this.kickDeg ??= 8;
    this.deorbitT = 2 * 3600 + 12 * 60 + 18; // Flight 14: T+2:12:18
    this.deorbitPerigee = 70000; // splashdown point, metres downrange (offshore)
    this.updateTelemetry(this.booster);
    this.updateTelemetry(this.ship);
  }

  event(name) {
    if (this.flags[name]) return;
    this.flags[name] = true;
    this.events.push({ t: this.t, name });
  }

  padAngle() { return OMEGA * this.t; }

  // Local tangent frame (pad) conversion.
  toLocal(X, Y) {
    const r = Math.hypot(X, Y);
    const d = Math.atan2(X, Y) - this.padAngle();
    return { s: r * Math.sin(d), y: r * Math.cos(d) - RE, h: r - RE, range: RE * d };
  }

  step(dt) {
    const t = this.t;
    const B = this.booster, S = this.ship;

    // ------------------------------------------------ countdown sequence
    if (t >= -18) { this.deluge = Math.min(1, this.deluge + dt * 0.8); this.event('Water deluge on'); }
    if (t >= -3.2 && !this.flags['Raptor ignition']) {
      this.event('Raptor ignition');
      // Staggered start: centre, inner ring, outer ring (ms-scale jitter per engine)
      B.command(() => true, 1.0, (e) => {
        const base = e.ring === 0 ? 0 : e.ring === 1 ? 0.45 : 1.0;
        return base + ((e.index * 7919) % 97) / 97 * 0.55;
      });
    }
    if (t >= 0 && !this.released) {
      const thrust = B.engines.reduce((a, e) => a + e.thrust(P0), 0);
      if (thrust > (B.mass() + S.mass()) * G0 * 1.05) { this.released = true; this.event('Liftoff'); B.phase = S.phase = 'ascent'; }
    }

    // ------------------------------------------------ engine dynamics
    for (const e of B.engines) e.update(dt);
    for (const e of S.engines) e.update(dt);

    if (this.stacked) {
      this.guideStack(dt);
      this.integrate(B, dt, S);
      S.X = B.X + Math.sin(B.alpha) * B.length; S.Y = B.Y + Math.cos(B.alpha) * B.length;
      S.VX = B.VX; S.VY = B.VY; S.alpha = B.alpha;
      S.telemetry = { ...B.telemetry };
      this.updateTelemetry(S);
    } else {
      this.guideBooster(dt);
      this.guideShip(dt);
      if (B.active) this.integrate(B, dt, null);
      if (S.active) this.integrate(S, dt, null);
    }

    // pad environment
    const hB = B.telemetry.h;
    const thrustFrac = B.engines.reduce((a, e) => a + e.level, 0) / 33;
    this.padFire = this.stacked || hB < 3000 ? thrustFrac * Math.exp(-Math.max(0, hB) / 140) : 0;
    if (t > 25) this.deluge = Math.max(0, this.deluge - dt * 0.05);
    this.t += dt;
  }

  // ------------------------------------------------------------ guidance
  guideStack(dt) {
    const B = this.booster;
    const t = this.t;
    const h = B.telemetry.h;
    // Max-Q throttle bucket
    let thr = 1.0;
    if (t > 44 && t < 90) thr = 0.68 + 0.32 * (Math.abs(t - 67) / 23) ** 3;
    // limit axial acceleration late in the burn (~3.3 g)
    const mTot = B.mass() + this.ship.mass();
    if (t > 88) thr = Math.min(1, Math.max(0.55, (3.0 * G0 * mTot) / (33 * RAPTOR_SL.Fvac)));
    if (t > 40 && !this.flags['Throttle down for max-Q']) this.event('Throttle down for max-Q');
    if (this.released) for (const e of B.engines) if (e.cmd > 0) e.cmd = thr;

    const phi = Math.atan2(B.X, B.Y);
    if (!this.released) { B.alphaCmd = phi; }
    else if (h < 350) { B.alphaCmd = phi; }                 // clear the tower
    else if (t < 26) {                                        // pitch kick
      const k = Math.min(1, (t - (this.kickStart ?? (this.kickStart = t))) / 8);
      B.alphaCmd = phi + k * this.kickDeg * Math.PI / 180;
      this.event('Pitch program');
    } else {                                                  // gravity turn
      const vr = this.airVel(B);
      B.alphaCmd = Math.atan2(vr.x, vr.y);
      this.event('Gravity turn');
    }
    if (B.telemetry.mach >= 1 && !this.flags['Supersonic']) this.event('Supersonic');
    if (t > 60 && B.telemetry.q < B.maxQ * 0.98 && !this.flags['Max-Q']) this.event('Max-Q');

    // MECO when the booster reaches its landing propellant reserve
    if (B.prop <= 400000) this.hotStage();
  }

  hotStage() {
    const B = this.booster, S = this.ship;
    this.event('MECO');
    this.event('Hot staging');
    B.command((e) => e.ring > 0, 0);
    B.command((e) => e.ring === 0, 0.45);
    S.command(() => true, 1.0, (e) => (e.ring === 0 ? 0.25 : 0.55));
    this.stacked = false;
    this.stageTime = this.t;
    B.phase = 'hotstage';
    S.phase = 'ascent';
    // separation impulse: the ship's own thrust does the work, give a small push
    S.VX += Math.sin(B.alpha) * 0.6; S.VY += Math.cos(B.alpha) * 0.6;
  }

  guideBooster(dt) {
    const B = this.booster;
    if (!B.active) return;
    const ts = this.t - this.stageTime;
    const phi = Math.atan2(B.X, B.Y);
    const h = B.telemetry.h;
    const vr = this.airVel(B);
    if (B.phase === 'hotstage' && ts > 3.0) { B.phase = 'flip'; this.event('Booster flip'); B.slewRate = 16 * Math.PI / 180; }
    if (B.phase === 'flip') {
      B.alphaCmd = phi - 90 * Math.PI / 180; // nose pointing back towards the launch site
      if (Math.abs(B.alpha - B.alphaCmd) < 0.12) {
        B.phase = 'boostback'; this.event('Boostback burn');
        // Raptor 3 boosters relight nearly every engine for boostback (31 of 33 on Flight 14)
        B.command((e) => e.index !== 17 && e.index !== 29, 1.0, (e) => (e.ring === 0 ? 0 : e.ring === 1 ? 0.3 : 0.6) + (e.index % 5) * 0.06);
      }
    }
    if (B.phase === 'boostback') {
      B.alphaCmd = phi - 90 * Math.PI / 180;
      const impact = this.predictImpact(B);
      if (impact < this.boosterTarget + 6000) for (const e of B.engines) if (e.ring === 2) e.cmd = 0;
      if (impact <= this.boosterTarget || B.prop < 60000) {
        B.command(() => true, 0); B.phase = 'coast'; this.event('Boostback shutdown');
      }
    }
    if (B.phase === 'coast') {
      // engines-first descent: nose opposite the air-relative velocity
      if (B.VY * B.Y + B.VX * B.X < 0) B.alphaCmd = Math.atan2(-vr.x, -vr.y);
      else B.alphaCmd = phi;
      B.slewRate = 4 * Math.PI / 180;
      // landing burn ignition: stopping distance with 13 engines at ~70%
      const vy = B.telemetry.vVert;
      const a13 = (11 * RAPTOR_SL.Fsl * 0.7) / B.mass() - G0 + (0.5 * B.telemetry.rho * vy * vy * 1.2 * B.area) / B.mass();
      if (h < 4000 && vy < 0 && (vy * vy) / (2 * a13 * 0.6) > h - 400) {
        B.phase = 'landing'; this.event('Landing burn');
        // 11 of the 13 steerable engines relight, then 5, then the centre 3
        B.command((e) => e.ring <= 1 && e.index !== 5 && e.index !== 9, 0.7, (e) => (e.ring === 0 ? 0 : 0.15 + (e.index % 4) * 0.05));
        this.landingT = this.t;
      }
    }
    if (B.phase === 'landing') {
      const vy = B.telemetry.vVert;
      const vh = B.telemetry.vHoriz;
      // tilt against the remaining horizontal velocity, upright near the water
      const lean = Math.max(-0.25, Math.min(0.25, (-vh / Math.max(20, -vy)) * 0.8));
      B.alphaCmd = phi + (h > 40 ? lean : 0);
      B.slewRate = 8 * Math.PI / 180;
      const a3 = (3 * RAPTOR_SL.Fsl) / B.mass() - G0;
      const vt = -Math.sqrt(2 * 0.5 * a3 * Math.max(h - 1, 0)) - 1.5; // 3-engine descent profile
      if (vy > vt * 0.8) for (const e of B.engines) if (e.ring === 1 && e.index % 5 !== 0) e.cmd = 0;
      if (vy > vt * 0.97) for (const e of B.engines) if (e.ring === 1) e.cmd = 0;
      const lit = B.engines.filter((e) => e.cmd > 0);
      const n = lit.length || 1;
      const need = G0 + 0.5 * a3 + (vt - vy) * 2.5;
      const thr = Math.min(1, Math.max(0.4, (need * B.mass()) / (n * RAPTOR_SL.Fsl * Math.cos(B.alpha - phi))));
      for (const e of lit) e.cmd = thr;
      if (h < 1.0) {
        B.active = false; this.event('Booster splashdown');
        for (const e of B.engines) { e.level = 0; e.cmd = 0; }
        this.boosterLanded = { v: Math.hypot(vy, vh) };
      }
    }
    if (h < 0 && B.active) { B.active = false; this.event('Booster splashdown'); for (const e of B.engines) { e.level = 0; e.cmd = 0; } }
  }

  guideShip(dt) {
    const S = this.ship;
    if (!S.active) return;
    const phi = Math.atan2(S.X, S.Y);
    const r = Math.hypot(S.X, S.Y);
    const h = r - RE;
    const vRad = (S.VX * S.X + S.VY * S.Y) / r;
    const vTan = (S.VX * S.Y - S.VY * S.X) / r;
    const vr = this.airVel(S);
    const vAir = Math.hypot(vr.x, vr.y);
    const gv = Math.atan2(vr.x, vr.y); // direction of the air-relative velocity

    if (S.phase === 'ascent') {
      const thrust = S.engines.reduce((a, e) => a + e.thrust(S.telemetry.pa), 0);
      const aT = thrust / S.mass();
      if (aT > 1) {
        // Fly towards a 150 km trajectory with a shaped vertical-velocity profile
        const hT = this.shipTargetAlt ?? 250000;
        const vyT = Math.max(-150, Math.min(this.shipVyMax ?? 300, (hT - h) / (this.shipTau ?? 500)));
        const g = MU / (r * r) - (vTan * vTan) / r;
        const aR = (vyT - vRad) / 25 + g;
        const sn = Math.max(-0.4, Math.min(0.95, aR / aT));
        S.alphaCmd = phi + (Math.PI / 2 - Math.asin(sn));
        if (this.t - this.stageTime < 6) S.alphaCmd = S.alpha; // hold attitude while clearing the booster
      }
      // SECO on a "passively safe" suborbital trajectory (perigee inside the atmosphere,
      // apogee ~275 km), then an orbit-insertion burn at apogee (Flight 14 profile)
      if ((this.perigee(S) - RE > -50000 || S.prop < 60000) && this.t - this.stageTime > 20) {
        S.command(() => true, 0); S.phase = 'coast'; this.event('SECO');
        this.secoT = this.t;
      }
      return;
    }
    if (S.phase === 'coast' && !this.flags['Orbit insertion'] && vRad < 0 && this.t - this.secoT > 60) {
      // at apogee: relight one sea-level Raptor prograde to raise perigee
      S.phase = 'insertion'; this.event('Orbit insertion burn');
      S.command((e) => e.index === 0, 1.0);
      this.flags['Orbit insertion'] = true;
    }
    if (S.phase === 'insertion') {
      S.slewRate = 4 * Math.PI / 180;
      S.alphaCmd = Math.atan2(S.VX, S.VY); // prograde (inertial)
      if (this.perigee(S) - RE > 258000) { S.command(() => true, 0); S.phase = 'orbit'; this.event('Orbit achieved'); this.orbitT = this.t; }
      return;
    }
    if (S.phase === 'orbit') {
      // payload bay: Starlink V3 deployment, then the first-ever Starship deorbit burn
      if (this.t > 34 * 60 + 7 && !this.flags['Starlink deploy']) this.event('Starlink deploy');
      if (this.t > this.deorbitT) {
        S.phase = 'deorbit'; this.event('Deorbit burn');
        S.command((e) => e.index === 0, 1.0);
      }
      // hold prograde, then swing to retrograde a few minutes ahead of the deorbit burn
      S.slewRate = 1 * Math.PI / 180;
      S.alphaCmd = this.t > this.deorbitT - 300 ? Math.atan2(-S.VX, -S.VY) : Math.atan2(S.VX, S.VY);
      return;
    }
    if (S.phase === 'deorbit') {
      S.slewRate = 4 * Math.PI / 180;
      S.alphaCmd = Math.atan2(-S.VX, -S.VY); // retrograde
      if (this.perigee(S) - RE < this.deorbitPerigee) { S.command(() => true, 0); S.phase = 'coast'; this.event('Deorbit complete'); }
      return;
    }
    if (S.phase === 'coast') {
      // before orbit insertion hold prograde; after the deorbit burn reorient belly-first
      // for entry, nose ~55° above the velocity vector
      S.slewRate = 1.5 * Math.PI / 180;
      S.alphaCmd = this.flags['Deorbit complete'] ? gv - 55 * Math.PI / 180 : Math.atan2(S.VX, S.VY);
      if (h < 122000 && vRad < 0 && this.flags['Deorbit complete']) { S.phase = 'entry'; this.event('Atmospheric entry'); }
      return;
    }
    if (S.phase === 'entry') {
      S.slewRate = 3 * Math.PI / 180;
      const M = S.telemetry.mach;
      // high angle of attack, increasing as the ship slows (belly-flop at subsonic speed)
      const aoa = M > 4 ? 55 : 55 + (4 - M) / 4 * 30;
      S.alphaCmd = gv - aoa * Math.PI / 180;
      if (S.heat > 0.95 && !this.flags['Peak heating']) this.event('Peak heating');
      if (M < 0.9) { S.phase = 'bellyflop'; this.event('Subsonic belly-flop'); }
      return;
    }
    if (S.phase === 'bellyflop') {
      S.slewRate = 5 * Math.PI / 180;
      S.alphaCmd = gv - 88 * Math.PI / 180;
      if (h < 1700) {
        // relight the three sea-level Raptors and swing vertical (the "flip")
        S.phase = 'flip'; this.event('Flip & landing burn');
        S.command((e) => e.ring === 0, 0.4, (e) => 0.1 * e.index);
        S.slewRate = 40 * Math.PI / 180;
        this.shipFlipT = this.t;
      }
      return;
    }
    if (S.phase === 'flip' || S.phase === 'landing') {
      const vy = S.telemetry.vVert, vh = S.telemetry.vHoriz;
      const lean = Math.max(-0.3, Math.min(0.3, (-vh / Math.max(15, -vy)) * 0.9));
      S.alphaCmd = phi + (h > 25 ? lean : 0);
      if (S.phase === 'flip') {
        // engines at minimum throttle until the thrust vector is roughly vertical
        for (const e of S.engines) if (e.ring === 0) e.cmd = Math.abs(S.alpha - S.alphaCmd) < 0.9 ? 0.6 : 0.4;
        if (Math.abs(S.alpha - S.alphaCmd) < 0.15) S.phase = 'landing';
      }
      if (S.phase === 'landing') {
        S.slewRate = 10 * Math.PI / 180;
        const a3 = (3 * RAPTOR_SL.Fsl) / S.mass() - G0;
        const vt = -Math.sqrt(2 * 0.45 * a3 * Math.max(h - 1, 0)) - 1.2;
        const need = G0 + 0.45 * a3 + (vt - vy) * 2.5;
        const thr = Math.min(1, Math.max(0.4, (need * S.mass()) / (3 * RAPTOR_SL.Fsl * Math.max(0.5, Math.cos(S.alpha - phi)))));
        for (const e of S.engines) if (e.ring === 0) e.cmd = thr;
      }
      if (h < 1.0) {
        S.active = false; S.phase = 'splashdown'; this.event('Ship splashdown');
        for (const e of S.engines) { e.level = 0; e.cmd = 0; }
        this.shipLanded = { t: this.t, v: Math.hypot(vy, vh) };
      }
    }
  }

  apogee(s) {
    const r = Math.hypot(s.X, s.Y), v2 = s.VX * s.VX + s.VY * s.VY;
    const E = v2 / 2 - MU / r;
    if (E >= 0) return Infinity;
    const a = -MU / (2 * E);
    const hA = s.X * s.VY - s.Y * s.VX;
    const e = Math.sqrt(Math.max(0, 1 + (2 * E * hA * hA) / (MU * MU)));
    return a * (1 + e);
  }

  perigee(s) {
    const r = Math.hypot(s.X, s.Y), v2 = s.VX * s.VX + s.VY * s.VY;
    const E = v2 / 2 - MU / r;
    if (E >= 0) return Infinity;
    const a = -MU / (2 * E);
    const hA = s.X * s.VY - s.Y * s.VX;
    const e = Math.sqrt(Math.max(0, 1 + (2 * E * hA * hA) / (MU * MU)));
    return a * (1 - e);
  }

  airVel(s) { return { x: s.VX - OMEGA * s.Y, y: s.VY + OMEGA * s.X }; }

  predictImpact(s) {
    // Drag-free ballistic propagation, returns downrange (m) at impact.
    let X = s.X, Y = s.Y, VX = s.VX, VY = s.VY, t = this.t;
    const dt = 1.0;
    for (let i = 0; i < 2000; i++) {
      const r = Math.hypot(X, Y);
      if (r < RE) break;
      const g = MU / (r * r * r);
      VX -= g * X * dt; VY -= g * Y * dt;
      X += VX * dt; Y += VY * dt; t += dt;
    }
    return RE * (Math.atan2(X, Y) - OMEGA * t);
  }

  integrate(s, dt, carried) {
    const mass = s.mass() + (carried ? carried.mass() : 0);
    const r = Math.hypot(s.X, s.Y);
    const h = r - RE;
    const atm = atmosphere(h);
    let F = 0, mdot = 0;
    for (const e of s.engines) { F += e.thrust(atm.p); mdot += e.mdot(); }

    // attitude slew
    const da = s.alphaCmd - s.alpha;
    s.alpha += Math.sign(da) * Math.min(Math.abs(da), s.slewRate * dt);

    if (!this.released) {
      // held on the pad, co-rotating with the Earth
      const pa = this.padAngle();
      s.X = Math.sin(pa) * RE; s.Y = Math.cos(pa) * RE;
      s.VX = OMEGA * s.Y; s.VY = -OMEGA * s.X;
      s.alpha = s.alphaCmd = pa;
      s.prop = Math.max(0, s.prop - mdot * dt);
      this.updateTelemetry(s, atm, F / mass);
      return;
    }

    const vr = this.airVel(s);
    const vrm = Math.hypot(vr.x, vr.y);
    const mach = vrm / atm.a;
    const q = 0.5 * atm.rho * vrm * vrm;
    // angle of attack increases drag (booster falling sideways/engines-first)
    let aoa = 0;
    if (vrm > 1) aoa = Math.acos(Math.max(-1, Math.min(1, (Math.sin(s.alpha) * vr.x + Math.cos(s.alpha) * vr.y) / vrm)));
    const g = MU / (r * r * r);
    let ax = (F * Math.sin(s.alpha)) / mass - g * s.X;
    let ay = (F * Math.cos(s.alpha)) / mass - g * s.Y;
    const lifting = s === this.ship && ['coast', 'insertion', 'orbit', 'deorbit', 'entry', 'bellyflop'].includes(s.phase);
    if (lifting && vrm > 0.01) {
      // Newtonian lifting-body model on the ship's 50 m x 9 m planform (belly-first entry)
      const Ap = 430;
      const sa = Math.sin(aoa), ca = Math.cos(aoa);
      const CN = 1.3 * sa * sa;
      const Dm = q * (Ap * CN * sa + s.area * 0.12 * ca * ca);
      const Lm = q * Ap * CN * ca * 0.6;
      const ux = vr.x / vrm, uy = vr.y / vrm;
      // lift acts toward the side the nose points to, perpendicular to the flow
      let nx = Math.sin(s.alpha) - (Math.sin(s.alpha) * ux + Math.cos(s.alpha) * uy) * ux;
      let ny = Math.cos(s.alpha) - (Math.sin(s.alpha) * ux + Math.cos(s.alpha) * uy) * uy;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      ax += (-Dm * ux + Lm * nx) / mass;
      ay += (-Dm * uy + Lm * ny) / mass;
      // stagnation heating ~ sqrt(rho) v^3 (Sutton-Graves), normalised to ~1 at peak
      s.heat = Math.min(1.6, 118 * Math.sqrt(atm.rho / 1.225) * Math.pow(vrm / 7500, 3));
    } else {
      const cd = cdMach(mach) * (1 + 2.5 * Math.sin(aoa) ** 2) + (s === this.booster && !this.stacked ? 0.9 : 0);
      const D = q * cd * s.area;
      if (vrm > 0.01) { ax -= (D * vr.x) / (vrm * mass); ay -= (D * vr.y) / (vrm * mass); }
      if (s === this.ship) s.heat = Math.min(1.6, 118 * Math.sqrt(atm.rho / 1.225) * Math.pow(vrm / 7500, 3)) * (s.phase === 'ascent' ? 0 : 1);
    }
    s.VX += ax * dt; s.VY += ay * dt;
    s.X += s.VX * dt; s.Y += s.VY * dt;
    s.prop = Math.max(0, s.prop - mdot * dt);
    if (s.prop <= 0) for (const e of s.engines) e.cmd = 0;
    const aProper = Math.hypot(ax + g * s.X, ay + g * s.Y);
    s.maxQ = Math.max(s.maxQ, q);
    this.updateTelemetry(s, atm, aProper, mach, q);
  }

  updateTelemetry(s, atm = atmosphere(Math.hypot(s.X, s.Y) - RE), accel = 0, mach, q) {
    const r = Math.hypot(s.X, s.Y);
    const vr = this.airVel(s);
    const v = Math.hypot(vr.x, vr.y);
    const loc = this.toLocal(s.X, s.Y);
    s.telemetry = {
      h: r - RE,
      v,
      vInertial: Math.hypot(s.VX, s.VY),
      vVert: (vr.x * s.X + vr.y * s.Y) / r,
      vHoriz: (vr.x * s.Y - vr.y * s.X) / r,
      mach: mach ?? v / atm.a,
      q: q ?? 0.5 * atm.rho * v * v,
      accel,
      pa: atm.p,
      rho: atm.rho,
      downrange: loc.range,
      s: loc.s,
      y: loc.y,
      tilt: s.alpha - this.padAngle(), // nose angle from pad vertical, towards downrange
    };
  }
}
