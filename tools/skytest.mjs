import * as THREE from 'three';
import { computeLighting, atmosParams } from '../src/sky.js';
for (const mie of [1.4e-5]) {
  atmosParams.mieBeta = mie;
  const el = 11 * Math.PI/180, az = 102*Math.PI/180;
  const sd = new THREE.Vector3(Math.sin(az)*Math.cos(el), Math.sin(el), -Math.cos(az)*Math.cos(el));
  const L = computeLighting(sd, 30);
  const f = v => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
  console.log('mie', mie, 'sun', f(L.sun), 'sky', f(L.sky), 'ground', f(L.ground));
  L.ring.forEach((c,i)=>{ if(i%4==0) console.log('  ring', i, f(c)); });
}
