import { FlightSim } from '../src/physics.js';
for (const k of [6,7,8,9,10]) {
  const sim = new FlightSim(); sim.kickDeg = k; sim.reset();
  let meco=null, bApo=0;
  while (sim.t < 600) { sim.step(0.01); if (!meco && sim.flags['MECO']) meco = {t:sim.t, ...sim.booster.telemetry}; bApo=Math.max(bApo, sim.booster.telemetry.h); if (sim.flags['SECO'] && sim.t>meco.t+5 && !sim.booster.active) break; }
  const s=sim.ship.telemetry;
  console.log(`kick ${k}: MECO T+${meco.t.toFixed(0)} h=${(meco.h/1e3).toFixed(1)} v=${meco.v.toFixed(0)} vy=${meco.vVert.toFixed(0)} dr=${(meco.downrange/1e3).toFixed(1)} | B apogee ${(bApo/1e3).toFixed(0)}km | SECO ${sim.events.find(e=>e.name==='SECO')?.t.toFixed(0)} ship h=${(s.h/1e3).toFixed(0)} v=${s.v.toFixed(0)} | maxQ ${(sim.booster.maxQ/1e3).toFixed(1)}`);
}
