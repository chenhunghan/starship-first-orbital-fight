// Runs the pad air-flow solver off the main thread (see fluid.js).
import { FluidSim } from './fluid.js';

const sim = new FluidSim();

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'reset') { sim.reset(); return; }
  if (m.type === 'step') {
    const t0 = performance.now();
    const active = sim.step(m.dt, m.parts, m.n, m.jet);
    const out = m.field;
    sim.output(out);
    self.postMessage({ type: 'field', field: out, parts: m.parts, active, gen: m.gen, ms: performance.now() - t0 }, [out.buffer, m.parts.buffer]);
  }
};
