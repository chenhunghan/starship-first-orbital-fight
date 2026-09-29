import { FlightSim, RE } from '../src/physics.js';
const sim = new FlightSim();
let next = 450, ev = 0;
while (sim.t < 14000 && sim.ship.active) {
  sim.step(1 / 60);
  while (ev < sim.events.length) { const e = sim.events[ev++]; console.log(`  EVENT T+${(e.t/60).toFixed(0)}:${String(Math.floor(e.t%60)).padStart(2,'0')} (${e.t.toFixed(0)}s) ${e.name}`); }
  const S = sim.ship, t = S.telemetry;
  if (sim.t >= next) {
    next += t.h < 100000 ? (t.h < 20000 ? 60 : 60) : 900;
    console.log(`T+${sim.t.toFixed(0)} h=${(t.h/1e3).toFixed(1)} v=${t.v.toFixed(0)} M=${t.mach.toFixed(1)} vy=${t.vVert.toFixed(0)} q=${(t.q/1e3).toFixed(2)} a=${(t.accel/9.81).toFixed(1)}g heat=${(S.heat||0).toFixed(2)} dr=${(t.downrange/1e3).toFixed(0)}km prop=${(S.prop/1e3).toFixed(0)} ${S.phase} tilt=${(t.tilt*57.3).toFixed(0)} perigee=${((sim.perigee(S)-RE)/1e3).toFixed(0)}`);
  }
}
console.log('landed', sim.shipLanded, 'dr', (sim.ship.telemetry.downrange/1e3).toFixed(0), 'km');
