// Incompressible air flow around the pad: "stable fluids" on a staggered (MAC) grid,
// two-way coupled to the smoke / steam particles.
//
//  1. P2G      : particles splat their drag (mass x entrainment rate), momentum and
//                heat onto the cells. The air in a cell is pulled toward the particle
//                velocity, an implicit momentum exchange that is stable for any dt.
//                This is how the 100-200 m/s exhaust leaving the deluge plate
//                accelerates the surrounding air into a radial wall jet.
//  2. forces   : Boussinesq buoyancy from the hot gas temperature, vorticity
//                confinement (it restores the small eddies that numerical diffusion
//                removes), and slow relaxation toward the ambient wind profile.
//  3. advect   : semi-Lagrangian back-trace of the face velocities.
//  4. project  : red-black SOR pressure solve, warm-started from the previous
//                step. The ground is solid (no-penetration). The sides and top are
//                open, so outflow can leave the domain.
//  5. output   : cell-centred velocity + temperature for the particles (G2P), which
//                relax toward the resolved air velocity. Sub-grid eddies are added
//                on the particle side.
//
// The grid only runs inside an "active box" around the smoke, which grows with it.
// The solver is plain JS with no three.js dependency, so it can run in a worker.

export const FLUID = { nx: 64, ny: 32, nz: 64, h: 25, ox: -800, oy: 0, oz: -800 };

// floats per packed particle: x y z vx vy vz drag(mass*k) volume dT mass
export const PSTRIDE = 10;

// ambient wind (m/s) at height y: SE sea breeze near the ground (power-law boundary
// layer). It veers into the westerlies aloft, with a jet near 11 km and shear layers
// that twist an exhaust trail over a few minutes.
export function ambientWind(y, out) {
  const ws = Math.pow(Math.max(y, 2) / 10, 0.14);
  if (y < 900) { out[0] = -3.2 * ws; out[1] = 0; out[2] = -2.4 * ws; return out; }
  const sx = -3.2 * 2.03, sz = -2.4 * 2.03; // sea breeze at 900 m
  const a = Math.min(1, (y - 900) / 3500);
  const blend = a * a * (3 - 2 * a);
  const km = y / 1000;
  const jet = 6 + 22 * Math.exp(-(((km - 11) / 4.5) ** 2)) - (km > 18 ? Math.min(14, (km - 18) * 1.2) : 0);
  // shear layers (gravity-wave-like) with ~1-2 km vertical wavelength
  const shx = 4.5 * Math.sin(km * 3.7 + 0.6) + 2.5 * Math.sin(km * 8.3 + 2.1);
  const shz = 4.0 * Math.cos(km * 4.4 + 1.3) + 2.0 * Math.sin(km * 9.1 + 0.4);
  out[0] = sx + (jet + shx - sx) * blend;
  out[1] = 0;
  out[2] = sz + (1.5 + shz - sz) * blend;
  return out;
}

const _w = [0, 0, 0];

export class FluidSim {
  constructor(g = FLUID) {
    const { nx, ny, nz } = g;
    this.g = g;
    this.nx = nx; this.ny = ny; this.nz = nz; this.h = g.h;
    const N = (this.N = nx * ny * nz);
    this.u = new Float32Array((nx + 1) * ny * nz); this.u0 = new Float32Array(this.u.length);
    this.v = new Float32Array(nx * (ny + 1) * nz); this.v0 = new Float32Array(this.v.length);
    this.w = new Float32Array(nx * ny * (nz + 1)); this.w0 = new Float32Array(this.w.length);
    const NP = (nx + 2) * (ny + 2) * (nz + 2);
    this.q = new Float32Array(NP);                      // pressure * dt / (rho h), warm start (padded)
    this.div = new Float32Array(NP);
    this.A = new Float32Array(N);                       // particle drag sum (kg/s)
    this.BU = new Float32Array(N); this.BV = new Float32Array(N); this.BW = new Float32Array(N);
    this.VS = new Float32Array(N); this.HT = new Float32Array(N); // particle volume, volume * dT
    this.MP = new Float32Array(N);                      // particle mass (kg)
    this.T = new Float32Array(N);                       // gas temperature excess (K)
    this.cu = new Float32Array(N); this.cv = new Float32Array(N); this.cw = new Float32Array(N);
    this.ox_ = new Float32Array(N); this.oy_ = new Float32Array(N); this.oz_ = new Float32Array(N); this.om = new Float32Array(N);
    // ambient wind at the cell-centre heights
    this.windX = new Float32Array(ny); this.windZ = new Float32Array(ny);
    for (let j = 0; j < ny; j++) { ambientWind(g.oy + (j + 0.5) * g.h, _w); this.windX[j] = _w[0]; this.windZ[j] = _w[2]; }
    this.params = {
      rho: 1.2,          // air density (kg/m^3)
      buoy: 0.2,         // buoyancy of the cell air from the mixed gas temperature (the particles carry their own)
      vort: 0.25,        // vorticity confinement strength
      relax: 1 / 45,     // relaxation toward the ambient wind (1/s)
      mixL: 120,         // mixing length of the unresolved turbulence (m)
      iters: 24, sor: 1.7,
    };
    this.reset();
  }

  reset() {
    const { nx, ny, nz } = this;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const wx = this.windX[j], wz = this.windZ[j];
      const bu = (nx + 1) * (j + ny * k);
      for (let i = 0; i <= nx; i++) this.u[bu + i] = wx;
    }
    for (let k = 0; k <= nz; k++) for (let j = 0; j < ny; j++) {
      const wz = this.windZ[j];
      const bw = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) this.w[bw + i] = wz;
    }
    this.v.fill(0); this.q.fill(0); this.T.fill(0);
    this.box = null; // [i0, i1, j1, k0, k1] (j0 = 0), half-open
    this.idle = 0;
    this.active = false;
    this.time = 0;
  }

  /** Particles -> cells (trilinear weights). parts: PSTRIDE floats per particle. */
  splat(parts, n) {
    const { nx, ny, nz, h, A, BU, BV, BW, VS, HT, MP } = this;
    const { ox, oy, oz } = this.g;
    A.fill(0); BU.fill(0); BV.fill(0); BW.fill(0); VS.fill(0); HT.fill(0); MP.fill(0);
    let i0 = 1e9, i1 = -1e9, j1 = -1e9, k0 = 1e9, k1 = -1e9;
    const sxy = nx * ny;
    for (let p = 0; p < n; p++) {
      const o = p * PSTRIDE;
      let gx = (parts[o] - ox) / h - 0.5, gy = (parts[o + 1] - oy) / h - 0.5, gz = (parts[o + 2] - oz) / h - 0.5;
      if (gx < 0) gx = 0; else if (gx > nx - 1.0001) gx = nx - 1.0001;
      if (gy < 0) gy = 0; else if (gy > ny - 1.0001) gy = ny - 1.0001;
      if (gz < 0) gz = 0; else if (gz > nz - 1.0001) gz = nz - 1.0001;
      const i = gx | 0, j = gy | 0, k = gz | 0;
      const fx = gx - i, fy = gy - j, fz = gz - k;
      if (i < i0) i0 = i; if (i + 1 > i1) i1 = i + 1;
      if (j + 1 > j1) j1 = j + 1;
      if (k < k0) k0 = k; if (k + 1 > k1) k1 = k + 1;
      const a = parts[o + 6], vol = parts[o + 7], dT = parts[o + 8], m = parts[o + 9];
      const ax = a * parts[o + 3], ay = a * parts[o + 4], az = a * parts[o + 5], vt = vol * dT;
      const b = i + nx * (j + ny * k);
      for (let c = 0; c < 8; c++) {
        const dx = c & 1, dy = (c >> 1) & 1, dz = c >> 2;
        const wgt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        if (wgt <= 0) continue;
        const idx = b + dx + nx * dy + sxy * dz;
        A[idx] += a * wgt; BU[idx] += ax * wgt; BV[idx] += ay * wgt; BW[idx] += az * wgt;
        VS[idx] += vol * wgt; HT[idx] += vt * wgt; MP[idx] += m * wgt;
      }
    }
    // temperature of the cell: volume-weighted mix of hot gas and ambient air
    const cellV = h * h * h;
    for (let c = 0; c < this.N; c++) this.T[c] = VS[c] > 0 ? HT[c] / Math.max(cellV, VS[c]) : 0;
    if (n === 0) return null;
    return [i0, i1, j1, k0, k1];
  }

  growBox(b) {
    if (!b) return;
    const m = 4; // margin (cells): room for the flow the smoke pushes ahead of it
    const nb = [Math.max(0, b[0] - m), Math.min(this.nx, b[1] + m), Math.min(this.ny, b[2] + m + 2), Math.max(0, b[3] - m), Math.min(this.nz, b[4] + m)];
    if (!this.box) this.box = nb;
    else {
      const o = this.box;
      this.box = [Math.min(o[0], nb[0]), Math.max(o[1], nb[1]), Math.max(o[2], nb[2]), Math.min(o[3], nb[3]), Math.max(o[4], nb[4])];
    }
  }

  /**
   * Advance by dt (s). parts / n: packed particles (see PSTRIDE).
   * jet: { x, z, yTop, strength } is the engine exhaust column hitting the pad.
   */
  step(dt, parts, n, jet) {
    const bx = this.splat(parts, n);
    if (jet && jet.strength > 0.01) {
      const { ox, oz } = this.g, h = this.h;
      const ji = Math.floor((jet.x - ox) / h), jk = Math.floor((jet.z - oz) / h);
      const jj = Math.min(this.ny, Math.ceil(jet.yTop / h) + 1);
      this.growBox([ji, ji + 1, jj, jk, jk + 1]);
    }
    if (bx) { this.growBox(bx); this.idle = 0; } else this.idle += dt;
    if (!this.box) return false;
    if (this.idle > 6) { this.reset(); return false; }
    this.active = true;
    // sub-steps of <= 0.1 s; a long interval (seeking, time warp) is integrated in full
    // with up to 10 larger steps (semi-Lagrangian advection stays stable)
    const sub = Math.min(10, Math.max(1, Math.ceil(dt / 0.1)));
    const d = Math.min(dt, 3) / sub;
    const tm = this.timing;
    let t0 = tm ? performance.now() : 0;
    const lap = (name) => { if (!tm) return; const t1 = performance.now(); tm[name] = (tm[name] || 0) + t1 - t0; t0 = t1; };
    for (let s = 0; s < sub; s++) {
      this.couple(d);
      if (jet && jet.strength > 0.01) this.jetForce(d, jet);
      this.centre();
      lap('couple');
      this.forces(d);
      lap('forces');
      this.advect(d);
      lap('advect');
      this.project();
      lap('project');
      this.time += d;
    }
    this.centre();
    return true;
  }

  // drag exchange with the particles + relaxation toward the ambient wind.
  // Air (mass mAir) and the particles in a cell (mass mp, drag rate a = sum m k) relax
  // toward their common momentum-weighted velocity: u -> u_eq + (u - u_eq) exp(-a (1/mAir + 1/mp) dt).
  // This is exact for the two-body exchange and stable for any dt.
  couple(dt) {
    const { nx, ny, nz, A, BU, BV, BW, MP, u, v, w, windX, windZ } = this;
    const [i0, i1, j1, k0, k1] = this.box;
    const mAir = this.params.rho * this.h * this.h * this.h;
    const rl = Math.min(1, this.params.relax * dt);
    // unresolved turbulent mixing with the still air around the jet: a quadratic drag on
    // the deviation from the ambient wind (rate |du| / L)
    const ent = dt / this.params.mixL;
    const sxy = nx * ny;
    const xch = (uf, a, b, mp) => {
      if (a <= 0) return uf;
      const ue = (mAir * uf + mp * (b / a)) / (mAir + mp);
      return ue + (uf - ue) * Math.exp(-a * (1 / mAir + 1 / Math.max(mp, 1)) * dt);
    };
    const relax = (uf, target) => { const d = target - uf; return uf + d * Math.min(1, rl + ent * Math.abs(d)); };
    const jTop = Math.min(ny, j1);
    for (let k = k0; k < k1; k++) for (let j = 0; j < jTop; j++) {
      const bc = nx * (j + ny * k), bu = (nx + 1) * (j + ny * k);
      // u faces between cells i - 1 and i
      for (let i = i0; i <= i1; i++) {
        let a = 0, b = 0, mp = 0;
        if (i > 0) { const c = bc + i - 1; a += A[c]; b += BU[c]; mp += MP[c]; }
        if (i < nx) { const c = bc + i; a += A[c]; b += BU[c]; mp += MP[c]; }
        u[bu + i] = relax(xch(u[bu + i], a * 0.5, b * 0.5, mp * 0.5), windX[j]);
      }
      // v faces between cells j - 1 and j (j = 0 is the ground)
      if (j > 0) {
        const bv = nx * (j + (ny + 1) * k);
        for (let i = i0; i < i1; i++) {
          const c = bc + i, cb = c - nx;
          const f = bv + i;
          v[f] = relax(xch(v[f], (A[c] + A[cb]) * 0.5, (BV[c] + BV[cb]) * 0.5, (MP[c] + MP[cb]) * 0.5), 0);
        }
      }
    }
    // w faces between cells k - 1 and k
    for (let k = k0; k <= k1; k++) for (let j = 0; j < jTop; j++) {
      const bw = nx * (j + ny * k);
      for (let i = i0; i < i1; i++) {
        const f = bw + i;
        let a = 0, b = 0, mp = 0;
        if (k > 0) { const c = f - sxy; a += A[c]; b += BW[c]; mp += MP[c]; }
        if (k < nz) { a += A[f]; b += BW[f]; mp += MP[f]; }
        w[f] = relax(xch(w[f], a * 0.5, b * 0.5, mp * 0.5), windZ[j]);
      }
    }
  }

  // the exhaust column drives the air below the engines down into the plate
  jetForce(dt, jet) {
    const { nx, ny, h, v } = this;
    const { ox, oz } = this.g;
    const gx = (jet.x - ox) / h - 0.5, gz = (jet.z - oz) / h - 0.5;
    const i = Math.floor(gx), k = Math.floor(gz), fx = gx - i, fz = gz - k;
    const top = Math.min(ny, Math.floor(jet.yTop / h));
    const target = -110 * jet.strength;
    const rate = 1 - Math.exp(-dt * 6);
    for (let c = 0; c < 4; c++) {
      const ii = i + (c & 1), kk = k + (c >> 1);
      if (ii < 0 || kk < 0 || ii >= nx || kk >= this.nz) continue;
      const wgt = ((c & 1) ? fx : 1 - fx) * ((c >> 1) ? fz : 1 - fz);
      for (let j = 1; j <= top; j++) {
        const f = ii + nx * (j + (ny + 1) * kk);
        v[f] += (target - v[f]) * rate * wgt;
      }
    }
  }

  // cell-centred velocity (box + 1 cell margin)
  centre() {
    const { nx, ny, nz, u, v, w, cu, cv, cw } = this;
    const [i0, i1, j1, k0, k1] = this.box;
    const a0 = Math.max(0, i0 - 1), a1 = Math.min(nx, i1 + 1), c0 = Math.max(0, k0 - 1), c1 = Math.min(nz, k1 + 1), b1 = Math.min(ny, j1 + 1);
    for (let k = c0; k < c1; k++) for (let j = 0; j < b1; j++) {
      const bu = (nx + 1) * (j + ny * k), bv = nx * (j + (ny + 1) * k), bw = nx * (j + ny * k), bc = nx * (j + ny * k);
      for (let i = a0; i < a1; i++) {
        cu[bc + i] = 0.5 * (u[bu + i] + u[bu + i + 1]);
        cv[bc + i] = 0.5 * (v[bv + i] + v[bv + i + nx]);
        cw[bc + i] = 0.5 * (w[bw + i] + w[bw + i + nx * ny]);
      }
    }
  }

  // buoyancy + vorticity confinement
  forces(dt) {
    const { nx, ny, nz, h, cu, cv, cw, T, v, u, w, om } = this;
    const [i0, i1, j1, k0, k1] = this.box;
    const sxy = nx * ny;
    const B = 9.81 * this.params.buoy * dt;
    // buoyancy on v faces
    for (let k = k0; k < k1; k++) for (let j = 1; j < j1 && j < ny; j++) for (let i = i0; i < i1; i++) {
      const c = i + nx * (j + ny * k);
      const t = 0.5 * (T[c] + T[c - nx]);
      if (t > 0.01) v[i + nx * (j + (ny + 1) * k)] += B * t / (288 + t);
    }
    // vorticity confinement
    const eps = this.params.vort;
    if (eps <= 0) return;
    const inv2h = 0.5 / h;
    const { ox_, oy_, oz_ } = this;
    // vorticity of the deviation from the ambient wind profile (its shear near the
    // ground must not be amplified)
    const { windX, windZ } = this;
    for (let k = k0; k < k1; k++) for (let j = 0; j < j1; j++) {
      const jm = j > 0 ? j - 1 : j, jp = j < ny - 1 ? j + 1 : j;
      const dwx = windX[jp] - windX[jm], dwz = windZ[jp] - windZ[jm];
      for (let i = i0; i < i1; i++) {
        const c = i + nx * (j + ny * k);
        const xm = i > 0 ? c - 1 : c, xp = i < nx - 1 ? c + 1 : c;
        const ym = c + (jm - j) * nx, yp = c + (jp - j) * nx;
        const zm = k > 0 ? c - sxy : c, zp = k < nz - 1 ? c + sxy : c;
        const wx = ((cw[yp] - cw[ym] - dwz) - (cv[zp] - cv[zm])) * inv2h;
        const wy = ((cu[zp] - cu[zm]) - (cw[xp] - cw[xm])) * inv2h;
        const wz = ((cv[xp] - cv[xm]) - (cu[yp] - cu[ym] - dwx)) * inv2h;
        ox_[c] = wx; oy_[c] = wy; oz_[c] = wz;
        om[c] = Math.sqrt(wx * wx + wy * wy + wz * wz);
      }
    }
    // force at cell centres, spread onto the faces (half to each neighbour face)
    // only where there is smoke: the eddies are what we see, clear air is left smooth
    const k_ = eps * h * dt * 0.5, VS = this.VS, vs0 = 1 / (0.25 * h * h * h);
    for (let k = k0 + 1; k < k1 - 1; k++) for (let j = 1; j < j1 - 1; j++) for (let i = i0 + 1; i < i1 - 1; i++) {
      const c = i + nx * (j + ny * k);
      if (om[c] < 1e-3 || VS[c] <= 0) continue;
      const kc = k_ * Math.min(1, VS[c] * vs0);
      let gx = om[c + 1] - om[c - 1], gy = om[c + nx] - om[c - nx], gz = om[c + sxy] - om[c - sxy];
      const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (gl < 1e-6) continue;
      gx /= gl; gy /= gl; gz /= gl;
      const fx = (gy * oz_[c] - gz * oy_[c]) * kc;
      const fy = (gz * ox_[c] - gx * oz_[c]) * kc;
      const fz = (gx * oy_[c] - gy * ox_[c]) * kc;
      const fu = i + (nx + 1) * (j + ny * k);
      u[fu] += fx; u[fu + 1] += fx;
      const fv = i + nx * (j + (ny + 1) * k);
      v[fv] += fy; v[fv + nx] += fy;
      w[c] += fz; w[c + sxy] += fz;
    }
  }

  // semi-Lagrangian advection of the face velocities (inside the box)
  advect(dt) {
    const { nx, ny, nz, h, u, v, w, u0, v0, w0, cu, cv, cw } = this;
    u0.set(u); v0.set(v); w0.set(w);
    const [i0, i1, j1, k0, k1] = this.box;
    const s = dt / h;
    const sxy = nx * ny;
    const NX1 = nx + 1, NY1 = ny + 1;
    // u faces: grid coords of u samples are (i, j + 0.5, k + 0.5) -> index space (i, j, k)
    for (let k = k0; k < k1; k++) for (let j = 0; j < j1; j++) for (let i = Math.max(1, i0); i <= Math.min(nx - 1, i1); i++) {
      const c = i + nx * (j + ny * k);
      const f = i + NX1 * (j + ny * k);
      const vx = u0[f], vy = 0.5 * (cv[c - 1] + cv[c]), vz = 0.5 * (cw[c - 1] + cw[c]);
      u[f] = samp(u0, NX1, ny, nz, i - vx * s, j - vy * s, k - vz * s);
    }
    // v faces: (i + 0.5, j, k + 0.5) -> index (i, j, k), j = 0 stays 0 (ground)
    for (let k = k0; k < k1; k++) for (let j = 1; j <= Math.min(j1, ny - 1); j++) for (let i = i0; i < i1; i++) {
      const c = i + nx * (j + ny * k);
      const f = i + nx * (j + NY1 * k);
      const vx = 0.5 * (cu[c - nx] + cu[c]), vy = v0[f], vz = 0.5 * (cw[c - nx] + cw[c]);
      let gy = j - vy * s;
      if (gy < 0) gy = 0;
      v[f] = samp(v0, nx, NY1, nz, i - vx * s, gy, k - vz * s);
    }
    // w faces: (i + 0.5, j + 0.5, k) -> index (i, j, k)
    for (let k = Math.max(1, k0); k <= Math.min(nz - 1, k1); k++) for (let j = 0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const f = i + nx * (j + ny * k);
      const c = f, cB = f - sxy;
      const vx = 0.5 * (cu[cB] + cu[c]), vy = 0.5 * (cv[cB] + cv[c]), vz = w0[f];
      w[f] = samp(w0, nx, ny, nz + 1, i - vx * s, j - vy * s, k - vz * s);
    }
  }

  // pressure projection: make the velocity divergence-free inside the box.
  // q and div live on a grid padded by one ghost cell; ghosts and cells outside the box
  // stay 0 (open boundary), so the inner loop needs no branches. The ground is solid.
  project() {
    const { nx, ny, u, v, w, q, div } = this;
    const [i0, i1, j1, k0, k1] = this.box;
    const sxy = nx * ny, NX1 = nx + 1, NY1 = ny + 1;
    const PX = nx + 2, PXY = PX * (ny + 2);
    const jTop = Math.min(ny, j1);
    for (let k = k0; k < k1; k++) for (let j = 0; j < jTop; j++) {
      const bc = nx * (j + ny * k), bu = NX1 * (j + ny * k), bv = nx * (j + NY1 * k), bp = 1 + PX * (j + 1) + PXY * (k + 1);
      for (let i = i0; i < i1; i++) {
        const c = bc + i, fu = bu + i, fv = bv + i;
        div[bp + i] = u[fu + 1] - u[fu] + v[fv + nx] - v[fv] + w[c + sxy] - w[c];
      }
    }
    const iters = this.params.iters, om = this.params.sor;
    for (let it = 0; it < iters; it++) {
      for (let col = 0; col < 2; col++) {
        for (let k = k0; k < k1; k++) for (let j = 0; j < jTop; j++) {
          const inv = j === 0 ? 1 / 5 : 1 / 6;
          const bp = 1 + PX * (j + 1) + PXY * (k + 1);
          for (let i = i0 + ((i0 + j + k + col) & 1); i < i1; i += 2) {
            const p = bp + i;
            const qn = (q[p - 1] + q[p + 1] + q[p - PX] + q[p + PX] + q[p - PXY] + q[p + PXY] - div[p]) * inv;
            q[p] += om * (qn - q[p]);
          }
        }
      }
    }
    // subtract the pressure gradient
    for (let k = k0; k <= k1; k++) for (let j = 0; j < jTop; j++) {
      const bu = NX1 * (j + ny * k), bv = nx * (j + NY1 * k), bw = nx * (j + ny * k), bp = 1 + PX * (j + 1) + PXY * (k + 1);
      if (k < k1) {
        for (let i = i0; i <= i1; i++) u[bu + i] -= q[bp + i] - q[bp + i - 1];
        if (j > 0) for (let i = i0; i < i1; i++) v[bv + i] -= q[bp + i] - q[bp + i - PX];
        if (j === jTop - 1) for (let i = i0; i < i1; i++) v[bv + nx + i] -= q[bp + i + PX] - q[bp + i];
      }
      for (let i = i0; i < i1; i++) w[bw + i] -= q[bp + i] - q[bp + i - PXY];
    }
  }

  /** Cell-centred velocity + temperature, 4 floats per cell. */
  output(out) {
    const { N, cu, cv, cw, T } = this;
    if (!this.box) {
      const { nx, ny } = this;
      for (let c = 0; c < N; c++) {
        const j = ((c / nx) | 0) % ny;
        out[c * 4] = this.windX[j]; out[c * 4 + 1] = 0; out[c * 4 + 2] = this.windZ[j]; out[c * 4 + 3] = 0;
      }
      return out;
    }
    const { nx, ny, nz } = this;
    const [i0, i1, j1, k0, k1] = this.box;
    // centre() covered the box + 1; everything else is still the ambient wind
    const a0 = Math.max(0, i0 - 1), a1 = Math.min(nx, i1 + 1), c0 = Math.max(0, k0 - 1), c1 = Math.min(nz, k1 + 1), b1 = Math.min(ny, j1 + 1);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const inside = k >= c0 && k < c1 && j < b1;
      const base = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) {
        const c = base + i, o = c * 4;
        if (inside && i >= a0 && i < a1) { out[o] = cu[c]; out[o + 1] = cv[c]; out[o + 2] = cw[c]; }
        else { out[o] = this.windX[j]; out[o + 1] = 0; out[o + 2] = this.windZ[j]; }
        out[o + 3] = T[c];
      }
    }
    return out;
  }
}

// trilinear sample of a grid stored as sx * sy * sz (index coordinates, clamped)
function samp(f, sx, sy, sz, gx, gy, gz) {
  if (gx < 0) gx = 0; else if (gx > sx - 1.0001) gx = sx - 1.0001;
  if (gy < 0) gy = 0; else if (gy > sy - 1.0001) gy = sy - 1.0001;
  if (gz < 0) gz = 0; else if (gz > sz - 1.0001) gz = sz - 1.0001;
  const i = gx | 0, j = gy | 0, k = gz | 0;
  const fx = gx - i, fy = gy - j, fz = gz - k;
  const sxy = sx * sy;
  const b = i + sx * (j + sy * k);
  const a00 = f[b] + (f[b + 1] - f[b]) * fx;
  const a10 = f[b + sx] + (f[b + sx + 1] - f[b + sx]) * fx;
  const b2 = b + sxy;
  const a01 = f[b2] + (f[b2 + 1] - f[b2]) * fx;
  const a11 = f[b2 + sx] + (f[b2 + sx + 1] - f[b2 + sx]) * fx;
  const a0 = a00 + (a10 - a00) * fy, a1 = a01 + (a11 - a01) * fy;
  return a0 + (a1 - a0) * fz;
}

/** Trilinear sample of the cell-centred output field (4 floats per cell). */
export function sampleField(field, g, x, y, z, out) {
  const { nx, ny, nz, h, ox, oy, oz } = g;
  let gx = (x - ox) / h - 0.5, gy = (y - oy) / h - 0.5, gz = (z - oz) / h - 0.5;
  if (gx < 0) gx = 0; else if (gx > nx - 1.0001) gx = nx - 1.0001;
  if (gy < 0) gy = 0; else if (gy > ny - 1.0001) gy = ny - 1.0001;
  if (gz < 0) gz = 0; else if (gz > nz - 1.0001) gz = nz - 1.0001;
  const i = gx | 0, j = gy | 0, k = gz | 0;
  const fx = gx - i, fy = gy - j, fz = gz - k;
  const sx = 4, sy = nx * 4, sz = nx * ny * 4;
  const b = i * sx + j * sy + k * sz;
  for (let ch = 0; ch < 4; ch++) {
    const p = b + ch;
    const a00 = field[p] + (field[p + sx] - field[p]) * fx;
    const a10 = field[p + sy] + (field[p + sy + sx] - field[p + sy]) * fx;
    const a01 = field[p + sz] + (field[p + sz + sx] - field[p + sz]) * fx;
    const a11 = field[p + sz + sy] + (field[p + sz + sy + sx] - field[p + sz + sy]) * fx;
    const a0 = a00 + (a10 - a00) * fy, a1 = a01 + (a11 - a01) * fy;
    out[ch] = a0 + (a1 - a0) * fz;
  }
  return out;
}

export function insideFluid(x, y, z) {
  const g = FLUID;
  return x > g.ox && x < g.ox + g.nx * g.h && y < g.oy + g.ny * g.h && z > g.oz && z < g.oz + g.nz * g.h;
}
