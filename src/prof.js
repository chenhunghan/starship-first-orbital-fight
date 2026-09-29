// Frame profiler (enabled with ?prof): GPU pass timings via EXT_disjoint_timer_query_webgl2
// and CPU section timings via performance.now(). GPU sections may nest and are exclusive
// (a nested section pauses its parent); CPU sections are inclusive. window.__prof.report() returns averages in ms.

class Profiler {
  constructor() { this.enabled = false; this.ext = null; }

  init(gl, enabled) {
    this.enabled = enabled;
    this.gl = gl;
    // ?prof=sync: gl.finish() around every section (serialises the GPU, but is exact on
    // drivers whose timer queries measure command-buffer latency instead of work)
    this.sync = enabled === 'sync';
    // ?prof=cpu: CPU sections and frame time only
    this.ext = enabled && !this.sync && enabled !== 'cpu' ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    this.t0 = 0;
    this.stack = [];
    this.cur = null; // active GPU query
    this.frame = [];
    this.pending = [];
    this.pool = [];
    this.gpu = {}; this.cpu = {};
    this.cpuStack = [];
    this.frames = 0; this.gpuFrames = 0;
    this.frameMs = 0;
    this.ft = [];
  }

  _startQuery(name) {
    const gl = this.gl;
    const q = this.pool.pop() || gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.cur = q;
    this.frame.push([name, q]);
  }
  _stopQuery() {
    if (!this.cur) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.cur = null;
  }

  /** GPU section */
  begin(name) {
    if (this.sync) return this._syncSwitch(name, 1);
    if (!this.ext) return;
    this._stopQuery();
    this.stack.push(name);
    this._startQuery(name);
  }
  end() {
    if (this.sync) return this._syncSwitch(null, -1);
    if (!this.ext) return;
    this._stopQuery();
    this.stack.pop();
    if (this.stack.length) this._startQuery(this.stack[this.stack.length - 1]);
  }

  _wait() {
    // clear + readPixels on a private 1x1 target: blocks until all queued GPU work is done
    const gl = this.gl;
    if (!this.fb) {
      this.fb = gl.createFramebuffer();
      const tex = gl.createTexture();
      const prevT = gl.getParameter(gl.TEXTURE_BINDING_2D);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindTexture(gl.TEXTURE_2D, prevT);
      const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
      this.px = new Uint8Array(4);
    }
    const prevD = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), prevR = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.px);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevD);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevR);
  }

  _syncSwitch(name, dir) {
    this._wait();
    const t = performance.now();
    const top = this.stack[this.stack.length - 1];
    if (top) this.gpu[top] = (this.gpu[top] || 0) + t - this.t0;
    if (dir > 0) this.stack.push(name); else this.stack.pop();
    this.t0 = t;
  }

  /** CPU section */
  cbegin(name) {
    if (!this.enabled) return;
    this.cpuStack.push([name, performance.now()]);
  }
  cend() {
    if (!this.enabled) return;
    const [name, t0] = this.cpuStack.pop();
    const dt = performance.now() - t0;
    this.cpu[name] = (this.cpu[name] || 0) + dt;
  }

  endFrame(frameMs) {
    if (!this.enabled) return;
    this.frames++;
    this.frameMs += frameMs;
    this.ft.push(frameMs);
    if (this.sync) { this.begin('_sync'); this.end(); this.gpuFrames++; return; } // empty section = sync overhead
    if (!this.ext) return;
    const gl = this.gl;
    this.pending.push(this.frame);
    this.frame = [];
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const f = this.pending[0];
      const last = f[f.length - 1];
      if (last && !gl.getQueryParameter(last[1], gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      for (const [name, q] of f) {
        if (!disjoint) this.gpu[name] = (this.gpu[name] || 0) + gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.pool.push(q);
      }
      if (!disjoint) this.gpuFrames++;
    }
  }

  reset() { this.gpu = {}; this.cpu = {}; this.frames = 0; this.gpuFrames = 0; this.frameMs = 0; this.ft = []; }

  report() {
    const r = (o, n) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / Math.max(1, n)).toFixed(2)]));
    const gpu = r(this.gpu, this.gpuFrames), cpu = r(this.cpu, this.frames);
    if (this.sync) { // subtract the measured sync overhead from every section
      const o = gpu._sync || 0;
      delete gpu._sync;
      for (const k in gpu) gpu[k] = +Math.max(0, gpu[k] - o).toFixed(2);
    }
    const sum = (o) => +Object.values(o).reduce((a, b) => a + b, 0).toFixed(2);
    const ft = [...this.ft].sort((a, b) => a - b);
    const pct = (q) => +(ft[Math.min(ft.length - 1, Math.floor(ft.length * q))] || 0).toFixed(1);
    return { frames: this.frames, frameMs: +(this.frameMs / Math.max(1, this.frames)).toFixed(2), p50: pct(0.5), p95: pct(0.95), max: pct(1), gpuTotal: sum(gpu), cpuTotal: sum(cpu), gpu, cpu };
  }
}

export const prof = new Profiler();
