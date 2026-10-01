// Headless check of the pad fluid solver: synthetic exhaust particles, timing, divergence and flow stats.
import { FluidSim, FLUID, PSTRIDE, sampleField } from '../src/fluid.js';
const sim = new FluidSim();
if (process.env.VORT) sim.params.vort = +process.env.VORT;
if (process.env.IT) sim.params.iters = +process.env.IT;
if (process.env.TIMING) sim.timing = {};
if (process.env.BUOY) sim.params.buoy = +process.env.BUOY;
const N = FLUID.nx * FLUID.ny * FLUID.nz;
const field = new Float32Array(N * 4);
sim.output(field);
const MAX = 16000;
const P = []; // particles {x,y,z,vx,vy,vz,age,r,m}
const parts = new Float32Array(MAX * PSTRIDE);
let rnd = 1; const r = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
const dt = 1 / 15, fv = [0, 0, 0, 0];
let tStep = 0, steps = 0;
for (let t = 0; t < (+process.argv[2] || 40); t += dt) {
  const thrust = Math.min(1, t / 2), ground = t < 12 ? Math.exp(-Math.max(0, t * t * 1.2 - 2) / 120) : 0;
  const ne = Math.floor(420 * thrust * ground * dt);
  for (let i = 0; i < ne && P.length < MAX; i++) {
    const a = r() * 6.283, sp = (60 + r() * 150) * Math.sqrt(thrust) * (0.35 + 0.65 * ground);
    P.push({ x: Math.cos(a) * 8, y: 4, z: Math.sin(a) * 8, vx: Math.cos(a) * sp, vy: 1 + r() * 6, vz: Math.sin(a) * sp, age: 0, life: 55 + r() * 110, r0: 5, r1: 20 + r() * 32, hot: r() < 0.55 ? 1500 : 350, warm: 70 + r() * 80, m: +(process.env.M || 7e3) });
  }
  let n = 0;
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i]; p.age += dt;
    if (p.age > p.life) { P.splice(i, 1); continue; }
    sampleField(field, FLUID, p.x, p.y, p.z, fv);
    const dT = p.hot * Math.exp(-p.age / 0.7) + p.warm * Math.exp(-p.age / 28);
    const kd = 1 / (0.9 + p.age * 0.5), kk = Math.min(1, kd * dt);
    const buoy = 9.81 * Math.max(0, dT - fv[3]) / (288 + dT) * 0.3;
    p.vx += (fv[0] - p.vx) * kk; p.vy += (fv[1] - p.vy) * kk + buoy * dt; p.vz += (fv[2] - p.vz) * kk;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    const rad = p.r0 + (p.r1 - p.r0) * (1 - Math.exp(-p.age / 6)) + p.age * 0.12;
    if (p.y < rad * 0.38) { p.y = rad * 0.38; if (p.vy < 0) p.vy = 0; }
    const o = n * PSTRIDE;
    parts[o] = p.x; parts[o + 1] = p.y; parts[o + 2] = p.z; parts[o + 3] = p.vx; parts[o + 4] = p.vy; parts[o + 5] = p.vz;
    parts[o + 6] = p.m * kd; parts[o + 7] = 4.19 * rad ** 3; parts[o + 8] = dT; parts[o + 9] = p.m;
    n++;
  }
  const t0 = performance.now();
  sim.step(dt, parts, n, { x: 0, z: 0, yTop: 25 + t * t * 1.2, strength: thrust * Math.exp(-Math.max(0, t * t * 1.2 - 5) / 150) });
  sim.output(field);
  const el = performance.now() - t0;
  tStep += el; steps++;
  if (steps % 38 === 0) {
    // stats: divergence (after projection), max speed, particle extents
    let dmax = 0, vmax = 0;
    const { nx, ny, nz, u, v, w } = sim;
    const b = sim.box || [0, 0, 0, 0, 0];
    for (let k = b[3]; k < b[4]; k++) for (let j = 0; j < b[2] && j < ny; j++) for (let i = b[0]; i < b[1]; i++) {
      const fu = i + (nx + 1) * (j + ny * k), fv2 = i + nx * (j + (ny + 1) * k), c = i + nx * (j + ny * k);
      const d = u[fu + 1] - u[fu] + v[fv2 + nx] - v[fv2] + w[c + nx * ny] - w[c];
      dmax = Math.max(dmax, Math.abs(d));
      const sp = Math.hypot(field[c * 4], field[c * 4 + 1], field[c * 4 + 2]);
      if (sp > vmax) { vmax = sp; globalThis.vat = [i, j, k]; }
    }
    let rmax = 0, ymax = 0, rr = 0, yy = 0;
    for (const p of P) { const rad = Math.hypot(p.x, p.z); rmax = Math.max(rmax, rad); ymax = Math.max(ymax, p.y); rr += rad; yy += p.y; }
    console.log(`t=${t.toFixed(1)} n=${P.length} box=${JSON.stringify(sim.box)} step=${el.toFixed(1)}ms avg=${(tStep / steps).toFixed(1)}ms div=${dmax.toFixed(3)} vmax=${vmax.toFixed(1)} r=${(rr / P.length).toFixed(0)}/${rmax.toFixed(0)} y=${(yy / P.length).toFixed(0)}/${ymax.toFixed(0)} nan=${field.some(Number.isNaN)} at=${globalThis.vat}`);
  }
}
if (sim.timing) console.log(Object.fromEntries(Object.entries(sim.timing).map(([k, v]) => [k, +(v / steps).toFixed(2)])));
