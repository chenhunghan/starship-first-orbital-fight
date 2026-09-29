import * as THREE from 'three';
import { NOISE, AERIAL } from './glsl.js';
import { shared, rng } from './shared.js';

// Smoke / steam / cloud particles.
//
// Physics (CPU, per particle):
//  - momentum: exhaust jets decelerate by entraining ambient air (v ~ v0 / (1 + t/tau))
//  - buoyancy: a = g * dT / (Ta + dT), dT = hot core (fast mixing) + warm steam (slow)
//  - turbulence: divergence-free ABC flow at two scales, advected with the wind
//  - ground: particles cannot sink below the surface and spread radially
//  - growth: radius grows with entrainment, opacity dissipates over the lifetime
// Lighting: a coarse density grid is rebuilt every few frames; per-particle optical
// depth toward the sun and the engine fire gives self-shadowing and the orange
// under-lighting seen in launch photos.

export const KIND = { SMOKE: 0, SPRAY: 1, VAPOR: 2, CLOUD: 3, FIRE: 4, TRAIL: 5 };

const GRID = { nx: 48, ny: 28, nz: 48, cell: 26, ox: -624, oy: -10, oz: -624 };

export class ParticleSystem {
  constructor(max = 16000) {
    this.max = max;
    const f = (n = 1) => new Float32Array(max * n);
    this.p = f(3); this.v = f(3);
    this.age = f(); this.life = f(); this.r0 = f(); this.r1 = f(); this.gt = f(); this.size = f();
    this.hot = f(); this.warm = f(); this.dens = f(); this.seed = f(); this.rot = f(); this.rotV = f();
    this.sunT = f(); this.ao = f(); this.flameT = f(); this.tint = f(); this.op = f(); this.erode = f(); this.er0 = f();
    this.drag = f(); this.grav = f();
    this.kind = new Uint8Array(max);
    this.count = 0;
    this.rand = rng(99);
    this.time = 0;
    this.grid = new Float32Array(GRID.nx * GRID.ny * GRID.nz);
    this.lightCursor = 0;
    this.wind = new THREE.Vector3(-3.2, 0, -2.4); // SE sea breeze (m/s)
    this.flamePos = new THREE.Vector3();
    this.flameOn = 0;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.cloudCount = 0;
    this.buildRender();
  }

  // ---------------------------------------------------------------- emit
  emit(x, y, z, vx, vy, vz, o) {
    if (this.count >= this.max) return -1;
    const i = this.count++;
    const r = this.rand;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = o.life;
    this.r0[i] = o.r0; this.r1[i] = o.r1; this.gt[i] = o.growT ?? 6; this.size[i] = o.r0;
    this.hot[i] = o.hot ?? 0; this.warm[i] = o.warm ?? 0;
    this.dens[i] = o.dens ?? 1;
    this.seed[i] = r();
    this.rot[i] = r() * 6.283; this.rotV[i] = (r() - 0.5) * (o.spin ?? 0.2);
    this.sunT[i] = 1; this.ao[i] = 1; this.flameT[i] = 1;
    this.tint[i] = o.tint ?? 0;
    this.op[i] = 0;
    this.erode[i] = this.er0[i] = o.erode ?? 0.05;
    this.drag[i] = o.drag ?? 1;
    this.grav[i] = o.grav ?? 0;
    this.kind[i] = o.kind ?? KIND.SMOKE;
    return i;
  }

  kill(i) {
    const j = --this.count;
    if (i === j) return;
    const c3 = (a) => { a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; };
    c3(this.p); c3(this.v);
    for (const a of [this.age, this.life, this.r0, this.r1, this.gt, this.size, this.hot, this.warm, this.dens, this.seed, this.rot, this.rotV, this.sunT, this.ao, this.flameT, this.tint, this.op, this.erode, this.er0, this.drag, this.grav, this.kind]) a[i] = a[j];
  }

  // ------------------------------------------------------------- simulate
  update(dt) {
    if (dt <= 0) return;
    this.time += dt;
    const t = this.time;
    const { p, v } = this;
    const wx0 = this.wind.x, wz0 = this.wind.z;
    for (let i = 0; i < this.count; i++) {
      const k = this.kind[i];
      if (k === KIND.CLOUD) {
        p[i * 3] += wx0 * 0.6 * dt; p[i * 3 + 2] += wz0 * 0.6 * dt;
        continue;
      }
      const age = (this.age[i] += dt);
      const life = this.life[i];
      if (age >= life) { this.kill(i); i--; continue; }
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      // temperature excess (K)
      const dT = this.hot[i] * Math.exp(-age / 0.7) + this.warm[i] * Math.exp(-age / 28);
      const buoy = (9.81 * dT) / (288 + dT) * 0.55;
      // wind profile (power law) and turbulence
      const ws = Math.pow(Math.max(y, 2) / 10, 0.14);
      const s1 = 0.011, s2 = 0.037;
      const ph = t * 0.05;
      const tx = x - wx0 * t * 0.8, tz = z - wz0 * t * 0.8;
      const a1 = Math.sin(tz * s1 + ph) + Math.cos(y * s1 * 1.3 - ph);
      const b1 = Math.sin(tx * s1 * 1.1 - ph * 0.7) + Math.cos(tz * s1 + ph * 1.3);
      const c1 = Math.sin(y * s1 * 1.2 + ph * 0.9) + Math.cos(tx * s1 - ph);
      const a2 = Math.sin(tz * s2 - ph * 2) + Math.cos(y * s2 + ph * 1.7);
      const b2 = Math.sin(tx * s2 + ph * 1.5) + Math.cos(tz * s2 - ph);
      const c2 = Math.sin(y * s2 - ph * 2.2) + Math.cos(tx * s2 + ph * 0.6);
      const turbA = (k === KIND.SMOKE ? 2.6 : 1.0) * (1 + Math.min(age, 20) * 0.08);
      const txv = wx0 * ws + (a1 * 1.0 + a2 * 0.55) * turbA;
      const tyv = (b1 * 0.55 + b2 * 0.4) * turbA * 0.8;
      const tzv = wz0 * ws + (c1 * 1.0 + c2 * 0.55) * turbA;
      // entrainment drag: fast early deceleration, then follow the air
      const kd = this.drag[i] / (0.55 + age * 0.45);
      const kk = Math.min(1, kd * dt);
      v[i * 3] += (txv - v[i * 3]) * kk;
      v[i * 3 + 1] += (tyv - v[i * 3 + 1]) * kk + (buoy - this.grav[i] * 9.81) * dt;
      v[i * 3 + 2] += (tzv - v[i * 3 + 2]) * kk;
      p[i * 3] += v[i * 3] * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
      // growth
      const r = this.r0[i] + (this.r1[i] - this.r0[i]) * (1 - Math.exp(-age / this.gt[i])) + age * 0.12 * (k === KIND.SMOKE ? 1 : 0.2);
      this.size[i] = r;
      // ground: spread sideways instead of sinking
      const floor = k === KIND.SPRAY ? 0.3 : r * 0.38;
      if (p[i * 3 + 1] < floor) {
        p[i * 3 + 1] = floor;
        if (v[i * 3 + 1] < 0) {
          if (k === KIND.SPRAY) { this.kill(i); i--; continue; }
          const vv = -v[i * 3 + 1] * 0.6;
          const hx = x, hz = z;
          const hl = Math.hypot(hx, hz) + 1e-3;
          v[i * 3] += (hx / hl) * vv; v[i * 3 + 2] += (hz / hl) * vv;
          v[i * 3 + 1] = 0;
        }
      }
      // opacity envelope
      const fin = Math.min(1, age / (k === KIND.VAPOR ? 0.3 : 0.15));
      const u = age / life;
      const fout = u < 0.55 ? 1 : Math.max(0, 1 - (u - 0.55) / 0.45);
      this.op[i] = this.dens[i] * fin * fout * fout;
      this.erode[i] = Math.min(0.9, this.er0[i] + u * u * 0.7);
      this.rot[i] += this.rotV[i] * dt;
      // emissive temperature (for fire) stored in warm-independent channel
    }
  }

  // --------------------------------------------------------- lighting grid
  rebuildGrid() {
    const g = this.grid;
    g.fill(0);
    const { nx, ny, nz, cell, ox, oy, oz } = GRID;
    for (let i = 0; i < this.count; i++) {
      const k = this.kind[i];
      if (k === KIND.CLOUD || k === KIND.VAPOR) continue;
      const r = this.size[i];
      const fx = (this.p[i * 3] - ox) / cell - 0.5, fy = (this.p[i * 3 + 1] - oy) / cell - 0.5, fz = (this.p[i * 3 + 2] - oz) / cell - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      if (ix < 0 || iy < 0 || iz < 0 || ix >= nx - 1 || iy >= ny - 1 || iz >= nz - 1) continue;
      // mass of the puff spread over cells (volume ratio, clamped)
      const m = this.op[i] * Math.min(3, (4.19 * r * r * r) / (cell * cell * cell)) * 0.6;
      const dx = fx - ix, dy = fy - iy, dz = fz - iz;
      const b = ix + nx * (iy + ny * iz);
      g[b] += m * (1 - dx) * (1 - dy) * (1 - dz);
      g[b + 1] += m * dx * (1 - dy) * (1 - dz);
      g[b + nx] += m * (1 - dx) * dy * (1 - dz);
      g[b + nx + 1] += m * dx * dy * (1 - dz);
      g[b + nx * ny] += m * (1 - dx) * (1 - dy) * dz;
      g[b + nx * ny + 1] += m * dx * (1 - dy) * dz;
      g[b + nx * ny + nx] += m * (1 - dx) * dy * dz;
      g[b + nx * ny + nx + 1] += m * dx * dy * dz;
    }
  }
  sampleGrid(x, y, z) {
    const { nx, ny, nz, cell, ox, oy, oz } = GRID;
    const ix = Math.floor((x - ox) / cell), iy = Math.floor((y - oy) / cell), iz = Math.floor((z - oz) / cell);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return 0;
    return Math.min(1.2, this.grid[ix + nx * (iy + ny * iz)]);
  }
  updateLighting(fraction = 0.34) {
    const n = this.count;
    if (!n) return;
    const todo = Math.ceil(n * fraction);
    const sd = this.sunDir;
    const step = GRID.cell;
    const sigma = 0.9;
    for (let c = 0; c < todo; c++) {
      const i = (this.lightCursor + c) % n;
      const k = this.kind[i];
      if (k === KIND.CLOUD) continue;
      const x = this.p[i * 3], y = this.p[i * 3 + 1], z = this.p[i * 3 + 2];
      // sun
      let od = 0;
      for (let s = 1; s <= 14; s++) od += this.sampleGrid(x + sd.x * s * step, y + sd.y * s * step, z + sd.z * s * step);
      // single scattering transmittance + a softer multiple-scattering octave
      const sunT = Math.max(Math.exp(-od * sigma), 0.3 * Math.exp(-od * sigma * 0.2));
      // flame (engine fire at the pad)
      let fT = 0;
      if (this.flameOn > 0.001) {
        const fx = this.flamePos.x - x, fy = this.flamePos.y - y, fz = this.flamePos.z - z;
        const d = Math.hypot(fx, fy, fz);
        const ns = Math.min(14, Math.ceil(d / step));
        let odf = 0;
        for (let s = 1; s < ns; s++) { const q = s / ns; odf += this.sampleGrid(x + fx * q, y + fy * q, z + fz * q); }
        fT = Math.max(Math.exp(-odf * sigma * 0.8), 0.25 * Math.exp(-odf * sigma * 0.15));
      }
      // ambient occlusion from the neighbourhood
      const o = step * 1.6;
      const occ = this.sampleGrid(x, y + o, z) * 1.5 + this.sampleGrid(x + o, y, z) + this.sampleGrid(x - o, y, z) + this.sampleGrid(x, y, z + o) + this.sampleGrid(x, y, z - o) + this.sampleGrid(x, y - o, z) * 0.5;
      const ao = 0.45 + 0.55 * Math.exp(-occ * 0.35);
      const blend = 0.5;
      this.sunT[i] += (sunT - this.sunT[i]) * blend;
      this.flameT[i] += (fT - this.flameT[i]) * blend;
      this.ao[i] += (ao - this.ao[i]) * blend;
    }
    this.lightCursor = (this.lightCursor + todo) % Math.max(1, n);
  }

  // --------------------------------------------------------------- clouds
  generateClouds(sunDir) {
    const r = rng(2024);
    // remove existing clouds
    for (let i = this.count - 1; i >= 0; i--) if (this.kind[i] === KIND.CLOUD) this.kill(i);
    const clouds = [];
    const addCloud = (cx, cz, w, hgt, base, puffR, n) => {
      const start = this.count;
      for (let k = 0; k < n; k++) {
        // cauliflower: denser near the core, flat base, rising turrets
        const a = r() * Math.PI * 2;
        const rr = Math.sqrt(r()) * w * 0.5;
        let x = cx + Math.cos(a) * rr * (1 + r() * 0.3);
        let z = cz + Math.sin(a) * rr * 0.75;
        const core = 1 - rr / (w * 0.5);
        let y = base + puffR * 0.5 + Math.pow(r(), 0.8) * hgt * (0.25 + 0.75 * core);
        const size = puffR * (0.55 + r() * 0.6) * (0.7 + 0.5 * core);
        const i = this.emit(x, y, z, 0, 0, 0, { life: 1e9, r0: size, r1: size, kind: KIND.CLOUD, dens: 0.9 + r() * 0.1, erode: 0.08 + r() * 0.1, spin: 0 });
        if (i < 0) break;
        this.size[i] = size;
        this.op[i] = this.dens[i];
      }
      clouds.push({ start, end: this.count, base, top: base + hgt + puffR, cx, cz, w });
    };
    // cumulus field around (but not over) the pad
    for (let c = 0; c < 46; c++) {
      const ang = r() * Math.PI * 2;
      const dist = 3500 + Math.pow(r(), 0.7) * 26000;
      const cx = Math.cos(ang) * dist, cz = Math.sin(ang) * dist;
      const big = r() < 0.35;
      const w = big ? 1800 + r() * 2200 : 700 + r() * 1100;
      const hgt = big ? 1200 + r() * 1600 : 300 + r() * 600;
      const puffR = big ? 260 + r() * 140 : 150 + r() * 100;
      addCloud(cx, cz, w, hgt, 1050 + r() * 250, puffR, big ? 110 : 45);
    }
    // a few closer cumulus behind the pad for drama (west & north-west)
    addCloud(-6200, -2600, 3200, 2200, 1100, 360, 150);
    addCloud(-4800, 3600, 2400, 1500, 1150, 300, 110);
    addCloud(5200, -4400, 2600, 1700, 1200, 320, 110);
    // distant stratocumulus band toward the horizon
    for (let c = 0; c < 70; c++) {
      const ang = r() * Math.PI * 2;
      const dist = 32000 + r() * 50000;
      addCloud(Math.cos(ang) * dist, Math.sin(ang) * dist, 5000 + r() * 6000, 400 + r() * 700, 1300 + r() * 500, 900 + r() * 500, 14);
    }
    this.cloudCount = this.count;
    this.clouds = clouds;
    this.lightClouds(sunDir);
  }

  lightClouds(sunDir) {
    if (!this.clouds) return;
    for (const c of this.clouds) {
      const idx = [];
      for (let i = c.start; i < c.end; i++) if (this.kind[i] === KIND.CLOUD) idx.push(i);
      for (const i of idx) {
        const x = this.p[i * 3], y = this.p[i * 3 + 1], z = this.p[i * 3 + 2];
        let od = 0;
        const stepL = Math.max(60, this.size[i] * 0.6);
        for (let s = 1; s <= 10; s++) {
          const qx = x + sunDir.x * s * stepL, qy = y + sunDir.y * s * stepL, qz = z + sunDir.z * s * stepL;
          for (const j of idx) {
            const dx = this.p[j * 3] - qx, dy = this.p[j * 3 + 1] - qy, dz = this.p[j * 3 + 2] - qz;
            const rj = this.size[j] * 0.9;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < rj * rj) od += (1 - Math.sqrt(d2) / rj) * stepL / rj;
          }
        }
        this.sunT[i] = Math.exp(-od * 0.9);
        const hN = (y - c.base) / Math.max(1, c.top - c.base);
        this.ao[i] = 0.35 + 0.65 * Math.min(1, hN * 1.3);
        this.flameT[i] = 0;
      }
    }
  }

  // --------------------------------------------------------------- render
  buildRender() {
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = () => {
      const g = quad.clone();
      const attrs = ['a0', 'a1', 'a2', 'a3'].map((n) => {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 4), 4);
        a.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute(n, a);
        return a;
      });
      g.instanceCount = 0;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
      return { geo: g, attrs };
    };
    this.far = mk();
    this.near = mk();
    this.atlas = null;
    this.uniforms = {
      uAtlas: { value: null },
      uDepth: { value: null },
      uLogFar: { value: Math.log2(2e6 + 1) },
      uCamRight: { value: new THREE.Vector3() },
      uCamUp: { value: new THREE.Vector3() },
      uCamBack: { value: new THREE.Vector3() },
      uPartRes: { value: new THREE.Vector2(1, 1) },
    };
    this.mainMaterial = particleMaterial(this.uniforms, false);
    this.reflMaterial = particleMaterial(this.uniforms, true);
    this.farMesh = new THREE.Mesh(this.far.geo, this.mainMaterial);
    this.nearMesh = new THREE.Mesh(this.near.geo, this.mainMaterial);
    for (const m of [this.farMesh, this.nearMesh]) m.frustumCulled = false;
    this.farMesh.renderOrder = 10;
    this.nearMesh.renderOrder = 30;
    this.depthKey = new Float32Array(this.max);
    this.side = new Uint8Array(this.max);
    this.order = new Uint32Array(this.max);
    this.buckets = new Uint32Array(4097);
  }

  setReflectionMode(on) {
    const m = on ? this.reflMaterial : this.mainMaterial;
    this.farMesh.material = m;
    this.nearMesh.material = m;
  }

  /**
   * Sort back-to-front and split around the plume axis so the additive plume
   * can be drawn between particles behind it and particles in front of it.
   */
  upload(camera, plumes) {
    const cam = camera.position;
    const e = camera.matrixWorld.elements;
    const rx = e[0], ry = e[1], rz = e[2], ux = e[4], uy = e[5], uz = e[6], bx = e[8], by = e[9], bz = e[10];
    this.uniforms.uCamRight.value.set(rx, ry, rz);
    this.uniforms.uCamUp.value.set(ux, uy, uz);
    this.uniforms.uCamBack.value.set(bx, by, bz);
    const tanY = Math.tan((camera.fov * Math.PI) / 360) * 1.05;
    const tanX = tanY * camera.aspect;
    let nVis = 0;
    const key = this.depthKey;
    for (let i = 0; i < this.count; i++) {
      const op = this.op[i];
      if (op < 0.004) continue;
      const dx = this.p[i * 3] - cam.x, dy = this.p[i * 3 + 1] - cam.y, dz = this.p[i * 3 + 2] - cam.z;
      const d = -(dx * bx + dy * by + dz * bz);
      const r = this.size[i];
      if (d < -r) continue;
      const vx = dx * rx + dy * ry + dz * rz, vy = dx * ux + dy * uy + dz * uz;
      const dd = Math.max(d, 0);
      if (Math.abs(vx) > dd * tanX + r * 1.5 || Math.abs(vy) > dd * tanY + r * 1.5) continue;
      key[i] = d;
      // side test vs plume axes: 1 = in front of the plume
      let front = 0;
      for (const pl of plumes) {
        if (!pl.visible) continue;
        const ax = pl.origin, ad = pl.dir;
        const px = this.p[i * 3] - ax.x, py = this.p[i * 3 + 1] - ax.y, pz = this.p[i * 3 + 2] - ax.z;
        let s = px * ad.x + py * ad.y + pz * ad.z;
        s = Math.max(0, Math.min(pl.length, s));
        const qx = ax.x + ad.x * s - cam.x, qy = ax.y + ad.y * s - cam.y, qz = ax.z + ad.z * s - cam.z;
        const dq = -(qx * bx + qy * by + qz * bz);
        const lat = Math.hypot(px - ad.x * s, py - ad.y * s, pz - ad.z * s);
        if (lat < pl.radius * 4 + r * 2 + 150 && d < dq) { front = 1; break; }
      }
      this.side[i] = front;
      this.order[nVis++] = i;
    }
    // bucket sort by log depth (descending = back to front)
    const NB = 4096;
    const bk = this.buckets;
    bk.fill(0);
    const bucketOf = (d) => Math.min(NB - 1, Math.max(0, Math.floor((Math.log2(Math.max(d, 1)) / 21) * NB)));
    const tmp = this._tmp || (this._tmp = new Uint32Array(this.max));
    for (let k = 0; k < nVis; k++) bk[NB - 1 - bucketOf(key[this.order[k]])]++;
    let acc = 0;
    for (let b = 0; b < NB; b++) { const c = bk[b]; bk[b] = acc; acc += c; }
    for (let k = 0; k < nVis; k++) { const i = this.order[k]; tmp[bk[NB - 1 - bucketOf(key[i])]++] = i; }

    let nf = 0, nn = 0;
    const F = this.far.attrs.map((a) => a.array), N = this.near.attrs.map((a) => a.array);
    for (let k = 0; k < nVis; k++) {
      const i = tmp[k];
      const A = this.side[i] ? N : F;
      const o = (this.side[i] ? nn++ : nf++) * 4;
      A[0][o] = this.p[i * 3]; A[0][o + 1] = this.p[i * 3 + 1]; A[0][o + 2] = this.p[i * 3 + 2]; A[0][o + 3] = this.size[i];
      const kind = this.kind[i];
      const temp = (kind === KIND.SMOKE || kind === KIND.FIRE) && this.hot[i] > 0 ? 288 + this.hot[i] * Math.exp(-this.age[i] / 0.55) : 0;
      A[1][o] = this.rot[i]; A[1][o + 1] = Math.floor(this.seed[i] * 16); A[1][o + 2] = this.op[i]; A[1][o + 3] = temp;
      A[2][o] = this.sunT[i]; A[2][o + 1] = this.ao[i]; A[2][o + 2] = this.flameT[i]; A[2][o + 3] = this.tint[i];
      A[3][o] = this.erode[i]; A[3][o + 1] = kind; A[3][o + 2] = this.seed[i]; A[3][o + 3] = 0;
    }
    for (const [set, n] of [[this.far, nf], [this.near, nn]]) {
      set.geo.instanceCount = n;
      for (const a of set.attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n) * 4); a.needsUpdate = true; }
    }
    this.visible = nVis;
  }
}

// ------------------------------------------------------------ puff atlas
export function createPuffAtlas(renderer) {
  const size = 1024;
  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      ${NOISE}
      float lobes(vec2 p, float tile, int n, float rMin, float rMax, float spread, float lift, float salt) {
        float h = 0.0;
        for (int i = 0; i < 24; i++) {
          if (i >= n) break;
          float fi = float(i) + salt;
          float a = hash11(tile * 17.0 + fi * 1.7) * 6.2831;
          float rr = sqrt(hash11(tile * 31.0 + fi * 2.3)) * spread;
          vec2 c = vec2(cos(a), sin(a)) * rr;
          float r = mix(rMin, rMax, hash11(tile * 13.0 + fi * 3.1));
          vec2 d = p - c;
          float q = r * r - dot(d, d);
          if (q > 0.0) h = max(h, sqrt(q) + lift * (1.0 - rr / max(spread, 1e-3)));
        }
        return h;
      }
      float puffH(vec2 p, float tile) {
        // cauliflower: large lobes carrying medium and small lobes on their surface
        float h1 = lobes(p, tile, 7, 0.28, 0.46, 0.42, 0.12, 0.0);
        float h2 = lobes(p, tile, 16, 0.12, 0.22, 0.72, 0.06, 40.0);
        float h3 = lobes(p, tile, 24, 0.05, 0.11, 0.85, 0.03, 90.0);
        float h = max(h1, max(h2 * 0.92 + h1 * 0.25, h3 * 0.85 + max(h1, h2) * 0.35));
        vec3 sp = vec3(p * 5.0, tile * 3.3);
        h += (fbm3(sp, 5) - 0.5) * 0.16 * smoothstep(0.0, 0.15, h);
        return max(h, 0.0) * smoothstep(1.0, 0.8, length(p));
      }
      void main() {
        vec2 cell = floor(vUv * 4.0);
        float tile = cell.x + cell.y * 4.0;
        vec2 p = (fract(vUv * 4.0) - 0.5) * 2.0;
        float e = 2.0 / 256.0;
        float h = puffH(p, tile);
        float hx = puffH(p + vec2(e, 0.0), tile), hy = puffH(p + vec2(0.0, e), tile);
        vec3 n = normalize(vec3(-(hx - h) / e * 0.35, -(hy - h) / e * 0.35, 1.0));
        // blend towards a sphere normal so large-scale shading reads as a puff
        float rr = min(1.0, length(p));
        vec3 ns = normalize(vec3(p * 0.9, sqrt(max(0.0, 1.0 - rr * rr)) + 0.25));
        n = normalize(mix(ns, n, 0.7));
        gl_FragColor = vec4(n * 0.5 + 0.5, clamp(h * 1.7, 0.0, 1.0));
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  mat.dispose();
  quad.geometry.dispose();
  return rt.texture;
}

// ------------------------------------------------------------ material
export const SOFT_DEPTH = /* glsl */ `
uniform sampler2D uDepth;
uniform float uLogFar;
uniform vec2 uPartRes;
float sceneDepth() {
  float d = texture2D(uDepth, gl_FragCoord.xy / uPartRes).x;
  return exp2(d * uLogFar) - 1.0;
}
`;

function particleMaterial(uniforms, reflection) {
  const u = { ...uniforms, ...shared };
  return new THREE.ShaderMaterial({
    uniforms: u,
    defines: reflection ? { REFLECTION: 1 } : {},
    transparent: true,
    depthWrite: false,
    depthTest: reflection,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      attribute vec4 a0, a1, a2, a3;
      uniform vec3 uCamRight, uCamUp, uCamBack;
      varying vec2 vUv;
      varying vec4 vA1, vA2, vA3;
      varying vec3 vWorldP;
      varying float vViewZ, vSize;
      varying vec2 vRot;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        float s = a0.w;
        vec2 c = position.xy;
        vec3 wp = a0.xyz + (uCamRight * c.x + uCamUp * c.y) * s;
        // clouds seen from below: flatten puffs slightly
        vUv = c;
        vRot = vec2(cos(a1.x), sin(a1.x));
        vA1 = a1; vA2 = a2; vA3 = a3;
        vWorldP = wp;
        vSize = s;
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform vec3 uCamRight, uCamUp, uCamBack;
      uniform vec3 uSunColor, uSkyAmb, uGroundAmb, uFlamePos, uFlameColor;
      uniform float uTime;
      varying vec2 vUv;
      varying vec4 vA1, vA2, vA3;
      varying vec3 vWorldP;
      varying float vViewZ, vSize;
      varying vec2 vRot;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${AERIAL}
      ${SOFT_DEPTH}
      vec3 blackbody(float t) {
        // approximate Planckian locus colour, normalised
        t = clamp(t, 800.0, 4000.0) / 100.0;
        vec3 c;
        c.r = 1.0;
        c.g = clamp(0.39 * log(t) - 0.634, 0.0, 1.0);
        c.b = t > 19.0 ? clamp(0.543 * log(t - 10.0) - 1.186, 0.0, 1.0) : 0.0;
        return pow(c, vec3(2.2));
      }
      void main() {
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0) discard;
        // rotate texture lookup
        vec2 ruv = vec2(vRot.x * vUv.x - vRot.y * vUv.y, vRot.y * vUv.x + vRot.x * vUv.y);
        float tile = vA1.y;
        vec2 tuv = (vec2(mod(tile, 4.0), floor(tile / 4.0)) + (ruv * 0.5 + 0.5) * 0.96 + 0.02) / 4.0;
        vec4 tx = texture2D(uAtlas, tuv);
        float erode = vA3.x;
        float kind = vA3.y;
        float dens = smoothstep(erode, erode + 0.35, tx.a) * vA1.z;
        #ifndef REFLECTION
          float sd = sceneDepth();
          float soft = clamp((sd - vViewZ) / (vSize * 0.6), 0.0, 1.0);
          dens *= soft;
        #endif
        // fade when the camera is inside the puff
        dens *= clamp((vViewZ - vSize * 0.15) / (vSize * 0.6), 0.0, 1.0);
        if (dens < 0.003) discard;

        vec3 nb = tx.xyz * 2.0 - 1.0;
        vec2 nr = vec2(vRot.x * nb.x + vRot.y * nb.y, -vRot.y * nb.x + vRot.x * nb.y);
        vec3 Nfull = normalize(uCamRight * nr.x + uCamUp * nr.y + uCamBack * nb.z);
        // flatten the per-puff normal: macro shading comes from the density grid,
        // strong per-sprite limb darkening is what makes billboards look like balls
        vec3 N = normalize(mix(uCamBack, Nfull, 0.6));
        vec3 V = uCamBack;
        float ndl = dot(N, uSunDir);
        float sunT = vA2.x, ao = vA2.y, flameT = vA2.z, tint = vA2.w;
        bool cloud = kind > 2.5 && kind < 3.5;
        // diffuse with wrap (light bleeds through thin edges) + forward scattering silver lining
        float wrap = clamp((ndl + 0.6) / 1.6, 0.0, 1.0);
        float mu = dot(-V, uSunDir);
        float g = 0.55, gg = g * g;
        float hg = (1.0 - gg) / pow(1.0 + gg - 2.0 * g * mu, 1.5) / 12.566;
        float thin = 1.0 - tx.a;
        vec3 sun = uSunColor * sunT * (wrap * 0.9 + hg * (0.8 + 3.0 * thin)) / 3.14159;
        // self shadowing inside the puff: lower lobes darker
        float selfSh = mix(0.7, 1.0, clamp(dot(Nfull, uSunDir) * 0.5 + 0.5, 0.0, 1.0));
        vec3 amb = mix(uGroundAmb * 1.4, uSkyAmb * 1.25, clamp(N.y * 0.5 + 0.55, 0.0, 1.0)) * ao;
        vec3 toF = uFlamePos - vWorldP;
        float df2 = dot(toF, toF);
        vec3 fl = uFlameColor * flameT * clamp(dot(N, toF * inversesqrt(df2 + 1.0)) * 0.6 + 0.5, 0.0, 1.0) / (df2 + 900.0);
        vec3 albedo = mix(vec3(0.94, 0.94, 0.95), vec3(0.62, 0.55, 0.47), tint);
        if (cloud) albedo = vec3(0.92);
        vec3 col = albedo * (sun * selfSh + amb + fl);
        // incandescent fire
        float temp = vA1.w;
        if (temp > 700.0) {
          float k = (temp - 700.0) / 1300.0;
          col += blackbody(temp) * k * k * 60.0 * (0.4 + 0.6 * tx.a);
        }
        col = applyAerial(col, vWorldP, cameraPosition);
        float a = clamp(dens, 0.0, 1.0);
        gl_FragColor = vec4(col * a, a);
        #include <logdepthbuf_fragment>
      }`,
  });
}
