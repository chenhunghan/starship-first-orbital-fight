import { FlightSim, RE } from '../src/physics.js';
for (const [ht, vy, tau] of [[250000, 300, 500]]) {
  const s = new FlightSim(); s.shipTargetAlt = ht; s.shipVyMax = vy; s.shipTau = tau;
  let seco = null, ins = null;
  while (s.t < 4000) { s.step(1 / 30); if (!seco && s.flags['SECO']) seco = { t: s.t, h: s.ship.telemetry.h, apo: s.apogee(s.ship) - RE, v: s.ship.telemetry.v }; if (!ins && s.flags['Orbit achieved']) { ins = { t: s.t, apo: s.apogee(s.ship) - RE, peri: s.perigee(s.ship) - RE, prop: s.ship.prop }; break; } }
  console.log(ht, vy, tau, 'SECO', seco && `${seco.t.toFixed(0)}s h=${(seco.h/1e3).toFixed(0)} apo=${(seco.apo/1e3).toFixed(0)} v=${seco.v.toFixed(0)}`, 'INS', ins && `${ins.t.toFixed(0)}s ${(ins.peri/1e3).toFixed(0)}x${(ins.apo/1e3).toFixed(0)} prop=${(ins.prop/1e3).toFixed(0)}t`);
}
