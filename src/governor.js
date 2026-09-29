// Adaptive quality governor: scales the internal render resolution (and, at the lowest
// levels, the ray-march step counts) so the frame rate stays above the target. It never
// exceeds the selected preset. Decisions use a trimmed mean of the real frame interval
// over a window, with hysteresis: step down quickly when too slow, step up only when the
// predicted cost at the higher level fits comfortably, and back off after a failed step-up.

export const GOV_LEVELS = [
  { scale: 1.0, steps: 1.0 },
  { scale: 0.9, steps: 1.0 },
  { scale: 0.8, steps: 1.0 },
  { scale: 0.72, steps: 0.85 },
  { scale: 0.64, steps: 0.75 }, // floor
];

export class QualityGovernor {
  constructor({ targetFps = 30, enabled = true } = {}) {
    this.enabled = enabled;
    this.target = 1000 / targetFps;
    this.level = 0;
    this.win = [];
    this.winMs = 0;
    this.hold = 2500;      // ms to ignore after start / a level change (shader compiles, RT realloc)
    this.upDelay = 4000;   // ms at a level before trying to step up
    this.sinceChange = 0;
    this.lastUpFail = -1;  // level whose step-up had to be undone
    this.backoff = 1;
    this.lastUp = -1;
  }

  get scale() { return GOV_LEVELS[this.level].scale; }
  get steps() { return GOV_LEVELS[this.level].steps; }

  reset() { this.win = []; this.winMs = 0; this.sinceChange = 0; }

  /**
   * dtMs: real frame interval, cpuMs: main-thread time of the frame,
   * busy: frame not representative (seeking). Returns true when the level changed.
   */
  sample(dtMs, cpuMs, busy) {
    if (!this.enabled) return false;
    this.sinceChange += Math.min(dtMs, 250);
    if (busy || dtMs > 250 || this.sinceChange < this.hold) { this.win = []; this.winMs = 0; return false; }
    this.win.push(dtMs);
    this.winMs += dtMs;
    this.cpu = (this.cpu ?? cpuMs) * 0.95 + cpuMs * 0.05;
    if (this.winMs < 1500) return false;
    // trimmed mean (drops the slowest 10%: GC, one-off hitches)
    const s = [...this.win].sort((a, b) => a - b);
    const keep = s.slice(0, Math.max(1, Math.ceil(s.length * 0.9)));
    const ft = keep.reduce((a, b) => a + b, 0) / keep.length;
    this.win = []; this.winMs = 0;
    this.last = ft;
    const n = GOV_LEVELS.length;
    if (this.lastUp === this.level && this.sinceChange > this.upDelay) { this.lastUp = -1; this.backoff = 1; } // step-up held
    // too slow, and not limited by the main thread (a lower resolution would not help then)
    if (ft > this.target * 1.08 && this.level < n - 1 && this.cpu < ft * 0.8) {
      // too slow: jump by the predicted amount (cost ~ pixels), at least one level
      const cur = this.scale;
      let l = this.level + 1;
      while (l < n - 1 && ft * (GOV_LEVELS[l].scale / cur) ** 2 > this.target * 0.95) l++;
      if (this.lastUp === this.level) { this.lastUpFail = this.level; this.backoff = Math.min(8, this.backoff * 2); } // undoing a step-up
      return this.set(l);
    }
    if (this.level > 0 && this.sinceChange > this.upDelay * (this.level - 1 === this.lastUpFail ? this.backoff : 1)) {
      const up = GOV_LEVELS[this.level - 1].scale;
      if (ft * (up / this.scale) ** 2 < this.target * 0.85) { this.lastUp = this.level - 1; return this.set(this.level - 1); }
    }
    return false;
  }

  set(l) {
    if (l === this.level) return false;
    this.level = l;
    this.sinceChange = 0;
    this.win = []; this.winMs = 0;
    return true;
  }

  state() { return { level: this.level, scale: this.scale, steps: this.steps, ft: this.last && +this.last.toFixed(1), cpu: this.cpu && +this.cpu.toFixed(1) }; }
}
