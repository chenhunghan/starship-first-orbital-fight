import { FluidSim, FLUID, PSTRIDE, sampleField, insideFluid } from './fluid.js';
import { KIND } from './particles.js';

// Main-thread side of the pad air-flow solver. Once per frame it packs the smoke
// particles and hands them to the worker together with the elapsed sim time. The worker
// answers with the new velocity / temperature field, which the particles sample
// (one frame of latency). If the worker is still busy, the time accumulates and the
// next step covers it. The solver stays stable for large steps, which keeps it in sync
// during seeks and time warp. Without Worker support it runs inline.

const MAXP = 24000;

export class FluidField {
  constructor() {
    this.g = FLUID;
    const N = FLUID.nx * FLUID.ny * FLUID.nz;
    const ambient = new FluidSim(FLUID);
    this.field = ambient.output(new Float32Array(N * 4));
    this.ambient = this.field.slice();
    this.spare = this.field.slice();
    this.parts = new Float32Array(MAXP * PSTRIDE);
    this.busy = false;
    this.pending = 0;
    this.gen = 0;
    this.active = false;
    this.ms = 0;
    try {
      this.worker = new Worker(new URL('./fluid.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.receive(e.data);
      this.worker.onerror = () => {
        // fall back to running inline; buffers that were in flight are gone
        this.worker = null; this.busy = false; this.sim = ambient;
        this.parts = new Float32Array(MAXP * PSTRIDE);
        this.spare = this.field.slice();
      };
    } catch {
      this.worker = null;
      this.sim = ambient;
    }
  }

  reset() {
    this.gen++;
    this.pending = 0;
    this.active = false;
    this.field.set(this.ambient);
    if (this.worker) this.worker.postMessage({ type: 'reset' });
    else this.sim?.reset();
  }

  receive(m) {
    this.busy = false;
    this.parts = m.parts;
    if (m.gen !== this.gen) { this.spare = m.field; return; } // computed before a reset
    this.spare = this.field;
    this.field = m.field;
    this.active = m.active;
    this.ms = m.ms;
  }

  /** Pack the particles inside the domain (drag = mass * entrainment rate, volume, dT). */
  pack(ps) {
    const P = this.parts;
    let n = 0;
    for (let i = 0; i < ps.count && n < MAXP; i++) {
      const k = ps.kind[i];
      if (k === KIND.CLOUD || k === KIND.TRAIL) continue;
      const x = ps.p[i * 3], y = ps.p[i * 3 + 1], z = ps.p[i * 3 + 2];
      if (!insideFluid(x, y, z)) continue;
      const age = ps.age[i], r = ps.size[i];
      const o = n * PSTRIDE;
      P[o] = x; P[o + 1] = y; P[o + 2] = z;
      P[o + 3] = ps.v[i * 3]; P[o + 4] = ps.v[i * 3 + 1]; P[o + 5] = ps.v[i * 3 + 2];
      P[o + 6] = ps.mass[i] * ps.drag[i] / (0.9 + age * 0.5);
      P[o + 7] = 4.19 * r * r * r * Math.min(1, ps.op[i] * 2);
      let dT = ps.hot[i] * Math.exp(-age / 0.7) + ps.warm[i] * Math.exp(-age / 28);
      if (y > 200 && dT > 0) dT *= Math.pow(1 + (y - 200) / 300, -5 / 3); // as in ParticleSystem.update
      P[o + 8] = dT;
      P[o + 9] = ps.mass[i];
      n++;
    }
    return n;
  }

  /** Call once per frame after the particles moved. jet: engine exhaust column at the pad. */
  update(simDt, ps, jet) {
    this.pending += simDt;
    if (this.busy || this.pending <= 0) return;
    const n = this.pack(ps);
    if (n === 0 && !this.active) { this.pending = 0; return; }
    const dt = this.pending;
    this.pending = 0;
    const j = jet && { x: jet.x, z: jet.z, yTop: jet.yTop, strength: jet.strength };
    if (this.worker) {
      this.busy = true;
      this.worker.postMessage({ type: 'step', dt, parts: this.parts, n, jet: j, field: this.spare, gen: this.gen }, [this.parts.buffer, this.spare.buffer]);
    } else {
      const t0 = performance.now();
      this.active = this.sim.step(dt, this.parts, n, j);
      this.sim.output(this.field);
      this.ms = performance.now() - t0;
    }
  }

  /** Resolved air velocity (xyz) and gas temperature excess (w) at a point; false outside. */
  sample(x, y, z, out) {
    if (!insideFluid(x, y, z)) return false;
    sampleField(this.field, this.g, x, y, z, out);
    return true;
  }
}
