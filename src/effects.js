import * as THREE from 'three';
import { KIND } from './particles.js';
import { MOUNT_HEIGHT } from './pad.js';
import { insideVolume } from './smoke.js';

// Converts the flight state into particle emission: exhaust + deluge steam at the
// pad, the deluge water spray, cryogenic venting and frost vapour on the booster,
// transonic condensation, the faint exhaust trail, hot staging and the booster's
// landing burn over the Gulf.

const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class Effects {
  constructor(ps) {
    this.ps = ps;
    this.acc = {};
    this.stagingBurst = false;
  }

  rate(name, perSecond, dt) {
    if (!(perSecond > 0) || !(dt > 0)) return 0;
    const a = Math.min((this.acc[name] || 0) + perSecond * dt, 1500); // never flood the pool
    const n = Math.floor(a);
    this.acc[name] = a - n;
    return n;
  }

  update(dt, s) {
    if (dt <= 0) return;
    const ps = this.ps;
    const r = ps.rand;
    const sim = s.sim;
    const B = sim.booster;
    const t = sim.t;

    // ------------------------------------------------ booster exhaust at the pad
    const thrust = B.engines.reduce((a, e) => a + e.level, 0) / 33;
    const baseY = s.boosterPos.y;
    const hAbove = Math.max(0, baseY - MOUNT_HEIGHT);
    const nearPad = Math.abs(s.boosterPos.x) < 800 && Math.abs(s.boosterPos.z) < 800 && B.active;
    const ground = nearPad ? Math.exp(-hAbove / 120) : 0;
    // exhaust mass represented by one particle: ~22 t/s of Raptor exhaust (plus deluge
    // water) over the emission rate. It drives the air in the fluid solver, so the
    // momentum stays the same at every quality level.
    const q = s.quality ?? 1;
    const MASS_PAD = 7e3 / q, MASS_COL = 6e3 / q;
    let n = this.rate('pad', 420 * thrust * ground * q, dt);
    // a turbulent jet sheds large coherent eddies: the output and temperature of each gap
    // between the mount legs wax and wane over a few seconds, and the hot bursts grow into
    // separate towers instead of an even wall
    const burst = (g) => 1 + 0.75 * Math.sin(t * 0.83 + g * 2.4) * Math.sin(t * 0.29 + g * 4.1 + 0.4);
    for (let i = 0; i < n; i++) {
      // the exhaust leaves the plate through the six gaps between the mount legs (legs at
      // k * 60 deg); the gap facing the tower (north, -z) is partly blocked by its base
      let ang, gi = 0;
      if (r() < 0.65) {
        for (let k = 0; k < 4; k++) { gi = Math.floor(r() * 6); if (r() * 1.75 < burst(gi)) break; }
        ang = Math.PI / 6 + (gi * Math.PI) / 3 + (r() + r() - 1) * 0.5;
      } else {
        ang = r() * Math.PI * 2;
        gi = ((Math.round((ang - Math.PI / 6) / (Math.PI / 3)) % 6) + 6) % 6;
      }
      const gapK = gi === 4 ? 0.55 : 1, bk = burst(gi);
      const hot = r() < 0.55;
      const up = r() < 0.12;
      // deluge mist: air loaded with water droplets is denser than the ambient air, so it
      // runs along the ground as a gravity current (and keeps the cloud rooted). As the
      // droplets evaporate it loses that weight. The exhaust-rich gas is hot and builds the
      // rising towers.
      const mist = !hot && r() < 0.6;
      const sp = (60 + r() * 150) * gapK * Math.sqrt(thrust) * (0.35 + 0.65 * ground);
      const rad = 5 + r() * 9;
      const cx = s.boosterPos.x, cz = s.boosterPos.z;
      ps.emit(cx + Math.cos(ang) * rad, 2 + r() * 7, cz + Math.sin(ang) * rad,
        Math.cos(ang) * sp * (up ? 0.5 : 1), up ? 10 + r() * 18 : 1 + r() * 6, Math.sin(ang) * sp * (up ? 0.5 : 1), {
          life: 55 + r() * 110,
          r0: 4 + r() * 4,
          r1: 20 + r() * 32 + (up ? 10 : 0),
          growT: 5 + r() * 7,
          hot: hot ? 1300 + r() * 500 : 350,
          heatT: 0.9 + r() * 1.2,
          warm: mist ? -6 - r() * 14 : Math.min(330, (70 + 230 * r() * r()) * bk), // hot steam: also lighter than air (H2O 18 vs 29 g/mol)
          dens: 0.8 + r() * 0.2,
          tint: r() < 0.2 ? r() * 0.2 : 0,
          spin: 0.25,
          mass: MASS_PAD,
          kind: KIND.SMOKE,
        });
    }

    // ------------------------------------------------ deluge water spray
    // deluge only matters at the pad (and before the vehicle leaves it)
    const spray = s.atPad === false || t > 60 ? 0 : sim.deluge * Math.max(0, 1 - thrust * 3);
    n = this.rate('spray', 260 * spray * (s.quality ?? 1), dt);
    for (let i = 0; i < n; i++) {
      const ang = r() * Math.PI * 2, rad = Math.sqrt(r()) * 13;
      ps.emit(Math.cos(ang) * rad, 1, Math.sin(ang) * rad, Math.cos(ang) * (1 + r() * 4), 12 + r() * 22, Math.sin(ang) * (1 + r() * 4), {
        life: 2.5 + r() * 2, r0: 0.6, r1: 2.2 + r() * 2, growT: 1.5, dens: 0.3, grav: 1, drag: 0.15, kind: KIND.SPRAY, spin: 0.5, erode: 0.3,
      });
    }
    // mist rising from the plate once water is flowing under the engines
    n = this.rate('mist', s.atPad === false || t > 60 ? 0 : 18 * sim.deluge * (thrust < 0.05 ? 1 : 0), dt);
    for (let i = 0; i < n; i++) {
      const ang = r() * Math.PI * 2, rad = Math.sqrt(r()) * 16;
      ps.emit(Math.cos(ang) * rad, 3, Math.sin(ang) * rad, 0, 1 + r() * 2, 0, { life: 10 + r() * 6, r0: 3, r1: 11, growT: 4, dens: 0.35, kind: KIND.VAPOR });
    }

    // ------------------------------------------------ cryogenic vents & frost vapour
    const hB = B.telemetry.h;
    if (B.active && hB < 20000) {
      const speed = s.boosterVel.length();
      const onPad = !sim.released;
      const vRate = onPad ? 22 : 0;
      n = this.rate('vent', vRate, dt);
      for (let i = 0; i < n; i++) {
        const k = r();
        const hLocal = k < 0.4 ? 67 : k < 0.7 ? 71 + 12 : 71 + 30;
        const ang = r() < 0.5 ? 0.6 : 3.8;
        _v.set(Math.cos(ang) * 4.6, hLocal, Math.sin(ang) * 4.6).applyQuaternion(s.boosterQuat).add(s.boosterPos);
        ps.emit(_v.x, _v.y, _v.z, Math.cos(ang) * 4, 0.3, Math.sin(ang) * 4, { life: 3 + r() * 2, r0: 0.5, r1: 3.2, growT: 1.5, warm: -25, dens: 0.3, kind: KIND.VAPOR, erode: 0.2 });
      }
      // cold vapour sheet flowing down the frosted booster (denser than air)
      const frostRate = onPad ? 36 : speed < 300 && hB < 4000 && sim.stacked ? 60 * Math.exp(-hB / 2000) : 0;
      n = this.rate('frost', frostRate * (s.quality ?? 1), dt);
      for (let i = 0; i < n; i++) {
        const ang = r() * Math.PI * 2;
        const hl = 6 + r() * 60;
        _v.set(Math.cos(ang) * 4.7, hl, Math.sin(ang) * 4.7).applyQuaternion(s.boosterQuat).add(s.boosterPos);
        _a.set(Math.cos(ang), 0, Math.sin(ang)).applyQuaternion(s.boosterQuat);
        const keep = onPad ? 0 : 0.9 + r() * 0.08;
        ps.emit(_v.x, _v.y, _v.z,
          s.boosterVel.x * keep + _a.x * 1.5, s.boosterVel.y * keep - (onPad ? 2.5 : 0) + _a.y, s.boosterVel.z * keep + _a.z * 1.5, {
            life: onPad ? 2 + r() * 1.5 : 0.35 + r() * 0.5, r0: 0.5, r1: onPad ? 2.0 : 2.5 + speed * 0.006, growT: 0.6,
            warm: onPad ? -40 : 0, dens: onPad ? 0.22 : 0.3, drag: onPad ? 1 : 0.2, kind: KIND.VAPOR, erode: onPad ? 0.25 : 0.1,
          });
      }
      // transonic condensation collar (Prandtl–Glauert cloud)
      const M = B.telemetry.mach;
      const pg = Math.exp(-Math.pow((M - 1.0) / 0.12, 2)) * (B.telemetry.h < 14000 ? 1 : 0);
      n = 0; void pg;
      for (let i = 0; i < n; i++) {
        const ang = r() * Math.PI * 2;
        const hl = r() < 0.55 ? 71 + r() * 3 : 104 + r() * 6;
        const rr = 5 + r() * 5;
        _v.set(Math.cos(ang) * rr, hl, Math.sin(ang) * rr).applyQuaternion(s.boosterQuat).add(s.boosterPos);
        const vv = s.stacked ? s.boosterVel : s.boosterVel;
        ps.emit(_v.x, _v.y, _v.z, vv.x, vv.y, vv.z, { life: 0.18 + r() * 0.2, r0: 3, r1: 6, growT: 0.3, dens: 0.5, drag: 0, kind: KIND.VAPOR });
      }
    }

    // ------------------------------------------------ exhaust entrained along the plume column
    // (flame -> glowing gas -> steam gradient while the booster is still low)
    const bp = s.boosterPlume;
    if (bp && bp.axis.visible && nearPad && hAbove < 300) {
      n = this.rate('column', 170 * thrust * Math.exp(-hAbove / 160) * (s.quality ?? 1), dt);
      const reach = Math.max(4, s.boosterPos.y - 1);
      for (let i = 0; i < n; i++) {
        const f = 1 - Math.pow(r(), 3) * 0.25; // mostly at the bottom where the plume hits the plate
        _v.copy(bp.axis.origin).addScaledVector(bp.axis.dir, reach * f);
        const ang = r() * Math.PI * 2, rad = 3 + r() * 5 + f * 6;
        ps.emit(_v.x + Math.cos(ang) * rad, Math.max(2, _v.y), _v.z + Math.sin(ang) * rad,
          Math.cos(ang) * (40 + r() * 70), -(10 + r() * 20) * (1 - f), Math.sin(ang) * (40 + r() * 70), {
            life: 25 + r() * 40, r0: 4, r1: 16 + r() * 14, growT: 5, hot: 1500 + r() * 400, heatT: 0.7 + r() * 0.8,
            warm: 80 + r() * 60, dens: 0.55, kind: KIND.SMOKE, spin: 0.3, mass: MASS_COL,
          });
      }
    }

    // ------------------------------------------------ exhaust trail / contrail
    // Methalox exhaust is mostly water vapour and CO2, and clear while hot. In the humid
    // marine layer a faint condensation column forms. Above ~8 km the air is colder than
    // ~ -40 C, so the exhaust water freezes into a dense, persistent ice contrail
    // (Schmidt-Appleman criterion), until the air gets too thin. The trail then spreads
    // by turbulent diffusion and is twisted by the wind shear aloft (fluid.ambientWind).
    for (const [pl, pos, vel, lev, key] of [[s.boosterPlume, s.boosterPos, s.boosterVel, thrust, 'trailB'], [s.shipPlume, s.shipPos, s.shipVel, s.shipThrust, 'trailS']]) {
      if (!pl || lev < 0.05 || !pl.axis.visible) continue;
      const alt = pl === s.boosterPlume ? B.telemetry.h : sim.ship.telemetry.h;
      if (alt < 140 || alt > 42000) continue;
      const tC = (alt < 11000 ? 15 - 6.5e-3 * alt : alt < 20000 ? -56.5 : -56.5 + 1e-3 * (alt - 20000));
      const ice = THREE.MathUtils.smoothstep(-tC, 36, 46) * Math.exp(-Math.max(0, alt - 18000) / 8000);
      const humid = Math.exp(-alt / 1500);
      // keep the puff spacing along the path roughly constant at speed
      const speed = vel.length();
      n = this.rate(key, 48 * lev * (s.quality ?? 1) * THREE.MathUtils.clamp(speed / 350, 1, 4), dt);
      for (let i = 0; i < n; i++) {
        const f = 0.45 + r() * 0.6;
        _v.copy(pl.axis.origin).addScaledVector(pl.axis.dir, pl.axis.length * f);
        const inVol = insideVolume(_v.x, _v.y, _v.z, 40);
        const d = 0.035 + 0.17 * humid + 0.3 * ice;
        const rr = pl.axis.radius * 0.7;
        ps.emit(_v.x + (r() - 0.5) * rr, _v.y, _v.z + (r() - 0.5) * rr, vel.x * 0.1, vel.y * 0.1, vel.z * 0.1, {
          life: (ice > 0.3 ? 110 : 45) + r() * 40, r0: Math.max(5, rr * 0.8), r1: 30 + r() * 25, growT: 10, hot: 750 + r() * 250, heatT: 1.2,
          warm: 10, dens: d, tint: 0.04, kind: inVol ? KIND.SMOKE : KIND.TRAIL,
          // eddy diffusivity (m^2/s): convective boundary layer > free troposphere > stable stratosphere
          diff: alt < 1500 ? 30 : alt < 12000 ? 14 : 3,
        });
      }
    }

    // ------------------------------------------------ hot staging
    if (sim.flags['Hot staging'] && !this.stagingBurst) {
      this.stagingBurst = true;
      this.stageT0 = t;
    }
    if (this.stagingBurst && t - this.stageT0 < 4.5 && B.active) {
      n = this.rate('hs', 140, dt);
      for (let i = 0; i < n; i++) {
        const ang = r() * Math.PI * 2;
        _v.set(Math.cos(ang) * 4.8, 70.1, Math.sin(ang) * 4.8).applyQuaternion(s.boosterQuat).add(s.boosterPos);
        _a.set(Math.cos(ang), (r() - 0.5) * 0.4, Math.sin(ang)).applyQuaternion(s.boosterQuat).multiplyScalar(90 + r() * 160);
        ps.emit(_v.x, _v.y, _v.z, s.boosterVel.x + _a.x, s.boosterVel.y + _a.y, s.boosterVel.z + _a.z, {
          life: 1.2 + r() * 1.6, r0: 3, r1: 45 + r() * 40, growT: 0.9, hot: 2300, dens: 0.09, drag: 0.02, kind: KIND.FIRE, spin: 0.6, erode: 0.2,
        });
      }
    }

    // ------------------------------------------------ booster landing burn over the Gulf
    if (B.phase === 'landing' && B.active) {
      const h = B.telemetry.h;
      const g = Math.exp(-h / 60) * thrust * 3;
      n = this.rate('splash', 260 * Math.min(1, g), dt);
      for (let i = 0; i < n; i++) {
        const ang = r() * Math.PI * 2;
        const sp = 30 + r() * 70;
        ps.emit(s.boosterPos.x + Math.cos(ang) * 6, 2, s.boosterPos.z + Math.sin(ang) * 6, Math.cos(ang) * sp, 4 + r() * 16, Math.sin(ang) * sp, {
          life: 25 + r() * 30, r0: 4, r1: 18 + r() * 14, growT: 5, hot: 500, warm: 40, dens: 0.75, kind: KIND.SMOKE, mass: 6e3,
        });
      }
    }
    // ------------------------------------------------ ship landing burn, tip-over and fireball
    const S = sim.ship;
    if ((S.phase === 'landing' || S.phase === 'flip') && S.active) {
      const h = S.telemetry.h;
      const lev = S.engines.reduce((a, e) => a + (e.ring === 0 ? e.level : 0), 0) / 3;
      n = this.rate('shipSplash', 220 * Math.min(1, Math.exp(-h / 50) * lev * 3), dt);
      for (let i = 0; i < n; i++) {
        const ang = r() * Math.PI * 2, sp = 25 + r() * 55;
        ps.emit(s.shipPos.x + Math.cos(ang) * 4, 2, s.shipPos.z + Math.sin(ang) * 4, Math.cos(ang) * sp, 3 + r() * 12, Math.sin(ang) * sp, {
          life: 18 + r() * 20, r0: 3, r1: 12 + r() * 10, growT: 4, hot: 450, warm: 30, dens: 0.7, kind: KIND.SMOKE, mass: 3e3,
        });
      }
    }
    if (sim.shipLanded) {
      const ts = t - sim.shipLanded.t;
      // the ship topples and its residual propellant ignites (Flight 14: large fireball)
      if (ts > 3.4 && !this.boom) {
        this.boom = true;
        for (let i = 0; i < 700; i++) {
          const a = r() * Math.PI * 2, e = r() * 1.2, sp = 18 + r() * 70;
          const along = (r() - 0.5) * 50;
          const fire = r() < 0.65;
          ps.emit(s.shipPos.x + s.shipAxis.x * along, 3 + r() * 6, s.shipPos.z + s.shipAxis.z * along,
            Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 8, Math.sin(a) * Math.cos(e) * sp, {
              life: fire ? 4 + r() * 5 : 30 + r() * 30, r0: 4, r1: fire ? 22 + r() * 18 : 30 + r() * 25, growT: fire ? 1.2 : 6,
              hot: fire ? 2100 + r() * 300 : 600, heatT: fire ? 1.3 : 0.6, warm: 160, dens: fire ? 0.8 : 0.6, tint: fire ? 0.2 : 0.75,
              kind: KIND.SMOKE, spin: 0.5, mass: 2e3,
            });
        }
      }
      if (ts > 3.4 && ts < 14) {
        n = this.rate('boomSmoke', 80, dt);
        for (let i = 0; i < n; i++) {
          const a = r() * Math.PI * 2;
          ps.emit(s.shipPos.x + (r() - 0.5) * 30, 4, s.shipPos.z + (r() - 0.5) * 30, Math.cos(a) * 6, 8 + r() * 10, Math.sin(a) * 6, {
            life: 40 + r() * 30, r0: 8, r1: 35, growT: 8, hot: 900, heatT: 1, warm: 120, dens: 0.55, tint: 0.85, kind: KIND.SMOKE,
          });
        }
      }
    } else this.boom = false;
    void _b;
  }
}
