import * as THREE from 'three';
import { KIND } from './particles.js';
import { MOUNT_HEIGHT } from './pad.js';

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
    const a = (this.acc[name] || 0) + perSecond * dt;
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
    let n = this.rate('pad', 420 * thrust * ground * (s.quality ?? 1), dt);
    for (let i = 0; i < n; i++) {
      const ang = r() * Math.PI * 2;
      const hot = r() < 0.55;
      const up = r() < 0.3;
      const sp = (45 + r() * 120) * Math.sqrt(thrust) * (0.35 + 0.65 * ground);
      const rad = 5 + r() * 9;
      const cx = s.boosterPos.x, cz = s.boosterPos.z;
      ps.emit(cx + Math.cos(ang) * rad, 2 + r() * 7, cz + Math.sin(ang) * rad,
        Math.cos(ang) * sp * (up ? 0.45 : 1), up ? 18 + r() * 30 : 2 + r() * 12, Math.sin(ang) * sp * (up ? 0.45 : 1), {
          life: 55 + r() * 110,
          r0: 4 + r() * 4,
          r1: 20 + r() * 32 + (up ? 10 : 0),
          growT: 5 + r() * 7,
          hot: hot ? 1300 + r() * 500 : 350,
          warm: 55 + r() * 60,
          dens: 0.8 + r() * 0.2,
          tint: r() < 0.2 ? r() * 0.2 : 0,
          spin: 0.25,
          kind: KIND.SMOKE,
        });
    }

    // ------------------------------------------------ deluge water spray
    const spray = sim.deluge * (1 - thrust * 0.7);
    n = this.rate('spray', 260 * spray * (s.quality ?? 1), dt);
    for (let i = 0; i < n; i++) {
      const ang = r() * Math.PI * 2, rad = Math.sqrt(r()) * 13;
      ps.emit(Math.cos(ang) * rad, 1, Math.sin(ang) * rad, Math.cos(ang) * (1 + r() * 4), 12 + r() * 22, Math.sin(ang) * (1 + r() * 4), {
        life: 2.5 + r() * 2, r0: 0.6, r1: 2.2 + r() * 2, growT: 1.5, dens: 0.3, grav: 1, drag: 0.15, kind: KIND.SPRAY, spin: 0.5, erode: 0.3,
      });
    }
    // mist rising from the plate once water is flowing under the engines
    n = this.rate('mist', 18 * sim.deluge * (thrust < 0.05 ? 1 : 0), dt);
    for (let i = 0; i < n; i++) {
      const ang = r() * Math.PI * 2, rad = Math.sqrt(r()) * 16;
      ps.emit(Math.cos(ang) * rad, 3, Math.sin(ang) * rad, 0, 1 + r() * 2, 0, { life: 10 + r() * 6, r0: 3, r1: 11, growT: 4, dens: 0.35, kind: KIND.VAPOR });
    }

    // ------------------------------------------------ cryogenic vents & frost vapour
    if (B.active && s.boosterPos.y < 20000) {
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
      const frostRate = onPad ? 36 : speed < 300 && s.boosterPos.y < 4000 ? 60 * Math.exp(-s.boosterPos.y / 2000) : 0;
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
      n = this.rate('pg', 900 * pg, dt);
      for (let i = 0; i < n; i++) {
        const ang = r() * Math.PI * 2;
        const hl = r() < 0.55 ? 71 + r() * 3 : 104 + r() * 6;
        const rr = 5 + r() * 5;
        _v.set(Math.cos(ang) * rr, hl, Math.sin(ang) * rr).applyQuaternion(s.boosterQuat).add(s.boosterPos);
        const vv = s.stacked ? s.boosterVel : s.boosterVel;
        ps.emit(_v.x, _v.y, _v.z, vv.x, vv.y, vv.z, { life: 0.18 + r() * 0.2, r0: 3, r1: 6, growT: 0.3, dens: 0.5, drag: 0, kind: KIND.VAPOR });
      }
    }

    // ------------------------------------------------ faint exhaust / condensation trail
    for (const [pl, pos, vel, lev, key] of [[s.boosterPlume, s.boosterPos, s.boosterVel, thrust, 'trailB'], [s.shipPlume, s.shipPos, s.shipVel, s.shipThrust, 'trailS']]) {
      if (!pl || lev < 0.05 || !pl.axis.visible) continue;
      const alt = pos.y;
      if (alt < 900 || alt > 20000) continue;
      n = this.rate(key, 30 * lev * (s.quality ?? 1), dt);
      for (let i = 0; i < n; i++) {
        const f = 0.35 + r() * 0.5;
        _v.copy(pl.axis.origin).addScaledVector(pl.axis.dir, pl.axis.length * f);
        const hum = Math.exp(-alt / 3500) + (alt > 8000 ? 0.5 : 0); // contrail forms again in the cold upper troposphere
        ps.emit(_v.x + (r() - 0.5) * 8, _v.y, _v.z + (r() - 0.5) * 8, vel.x * 0.12, vel.y * 0.12, vel.z * 0.12, {
          life: 30 + r() * 30, r0: 9, r1: 38 + r() * 20, growT: 12, warm: 8, dens: 0.012 * hum + 0.004, tint: 0.05, kind: KIND.TRAIL,
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
      const h = s.boosterPos.y;
      const g = Math.exp(-h / 60) * thrust * 3;
      n = this.rate('splash', 260 * Math.min(1, g), dt);
      for (let i = 0; i < n; i++) {
        const ang = r() * Math.PI * 2;
        const sp = 30 + r() * 70;
        ps.emit(s.boosterPos.x + Math.cos(ang) * 6, 2, s.boosterPos.z + Math.sin(ang) * 6, Math.cos(ang) * sp, 4 + r() * 16, Math.sin(ang) * sp, {
          life: 25 + r() * 30, r0: 4, r1: 18 + r() * 14, growT: 5, hot: 500, warm: 40, dens: 0.75, kind: KIND.SMOKE,
        });
      }
    }
    void _b;
  }
}
