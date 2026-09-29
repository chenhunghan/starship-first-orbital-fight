import { FlightSim } from '../src/physics.js';
const sim = new FlightSim();
let next = 150, ev=0;
while (sim.t < 480 && (sim.booster.active || sim.t < 200)) {
  sim.step(0.01);
  while (ev < sim.events.length) { const e = sim.events[ev++]; if (e.t>100) console.log(`  EVENT T+${e.t.toFixed(1)} ${e.name}`); }
  if (sim.t >= next) { next += sim.booster.telemetry.h < 5000 ? 0.5 : 5;
    const b = sim.booster.telemetry;
    console.log(`T+${sim.t.toFixed(1)} h=${(b.h/1000).toFixed(2)} v=${b.v.toFixed(0)} vy=${b.vVert.toFixed(0)} vx=${b.vHoriz.toFixed(0)} dr=${(b.downrange/1000).toFixed(1)} q=${(b.q/1e3).toFixed(1)} a=${(b.accel/9.81).toFixed(1)}g prop=${(sim.booster.prop/1000).toFixed(0)} lit=${sim.booster.litCount()} tilt=${(b.tilt*180/Math.PI).toFixed(0)} ${sim.booster.phase} imp=${(sim.predictImpact(sim.booster)/1e3).toFixed(1)}`);
  }
}
