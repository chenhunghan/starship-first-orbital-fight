import { FlightSim } from '../src/physics.js';
const sim = new FlightSim();
const dt = 1 / 100;
let next = -10;
let lastEv = 0;
while (sim.t < 700) {
  sim.step(dt);
  while (lastEv < sim.events.length) { const e = sim.events[lastEv++]; console.log(`  EVENT T${e.t >= 0 ? '+' : ''}${e.t.toFixed(1)} ${e.name}`); }
  if (sim.t >= next) {
    next += sim.t < 60 ? 5 : 20;
    const b = sim.booster.telemetry, s = sim.ship.telemetry;
    console.log(`T+${sim.t.toFixed(0).padStart(4)} B h=${(b.h/1000).toFixed(2).padStart(7)}km v=${b.v.toFixed(0).padStart(5)} M=${b.mach.toFixed(2)} q=${(b.q/1000).toFixed(1)}kPa a=${(b.accel/9.81).toFixed(2)}g dr=${(b.downrange/1000).toFixed(1)} prop=${(sim.booster.prop/1000).toFixed(0)}t ${sim.booster.phase} | S h=${(s.h/1000).toFixed(1)} v=${s.v.toFixed(0)} vi=${s.vInertial.toFixed(0)} dr=${(s.downrange/1000).toFixed(0)} prop=${(sim.ship.prop/1000).toFixed(0)} ${sim.ship.phase}`);
  }
}
console.log('maxQ', (sim.booster.maxQ/1000).toFixed(1), 'kPa');
