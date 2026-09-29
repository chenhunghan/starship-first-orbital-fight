// Procedural launch audio with physical propagation delay (343 m/s), inverse
// distance attenuation and air absorption (distant sound loses highs).

const C_SOUND = 343;

function noiseBuffer(ctx, seconds, kind) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b = 0, p0 = 0, p1 = 0, p2 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'brown') { b = (b + 0.02 * w) / 1.02; d[i] = b * 3.5; }
      else if (kind === 'pink') { p0 = 0.99765 * p0 + w * 0.099; p1 = 0.963 * p1 + w * 0.2965; p2 = 0.57 * p2 + w * 1.0527; d[i] = (p0 + p1 + p2 + w * 0.1848) * 0.12; }
      else if (kind === 'crackle') {
        // sparse N-wave impulses: the characteristic "crackle" of rocket noise
        d[i] = 0;
        if (Math.random() < 0.0016) {
          const a = (Math.random() * 0.7 + 0.3) * (Math.random() < 0.5 ? -1 : 1);
          const len = 8 + Math.floor(Math.random() * 30);
          for (let k = 0; k < len && i + k < n; k++) d[i + k] += a * (1 - (2 * k) / len);
        }
      }
    }
  }
  return buf;
}

export class LaunchAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.history = []; // {t, x, y, z, p}
  }

  async start() {
    if (!this.ctx) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 6;
      master.connect(comp).connect(ctx.destination);
      this.master = master;
      const src = (buf, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(); return s; };
      // rumble
      this.rumbleF = ctx.createBiquadFilter(); this.rumbleF.type = 'lowpass'; this.rumbleF.frequency.value = 140;
      this.rumbleG = ctx.createGain(); this.rumbleG.gain.value = 0;
      src(noiseBuffer(ctx, 6, 'brown')).connect(this.rumbleF).connect(this.rumbleG).connect(master);
      // roar
      this.roarF = ctx.createBiquadFilter(); this.roarF.type = 'lowpass'; this.roarF.frequency.value = 2500;
      this.roarG = ctx.createGain(); this.roarG.gain.value = 0;
      src(noiseBuffer(ctx, 5, 'pink')).connect(this.roarF).connect(this.roarG).connect(master);
      // crackle
      this.crackF = ctx.createBiquadFilter(); this.crackF.type = 'highpass'; this.crackF.frequency.value = 500;
      this.crackL = ctx.createBiquadFilter(); this.crackL.type = 'lowpass'; this.crackL.frequency.value = 6000;
      this.crackG = ctx.createGain(); this.crackG.gain.value = 0;
      src(noiseBuffer(ctx, 4, 'crackle')).connect(this.crackF).connect(this.crackL).connect(this.crackG).connect(master);
      // ambient coastal wind
      this.windF = ctx.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.frequency.value = 400; this.windF.Q.value = 0.4;
      this.windG = ctx.createGain(); this.windG.gain.value = 0.02;
      src(noiseBuffer(ctx, 5, 'pink'), 0.7).connect(this.windF).connect(this.windG).connect(master);
    }
    await this.ctx.resume();
    this.enabled = true;
  }

  stop() {
    this.enabled = false;
    if (this.ctx) this.ctx.suspend();
  }

  // record acoustic power emitted at sim time t by the sources
  record(t, sources) {
    const h = this.history;
    if (h.length && t < h[h.length - 1].t) h.length = 0; // restart
    h.push({ t, s: sources.map((s) => ({ x: s.pos.x, y: s.pos.y, z: s.pos.z, p: s.power })) });
    while (h.length > 4000 || (h.length > 2 && t - h[0].t > 90)) h.shift();
  }

  // returns perceived loudness 0..1 (also used for camera shake)
  update(t, listener, timeScale) {
    const h = this.history;
    let level = 0, lowpass = 20000, crack = 0;
    if (h.length > 1) {
      const nSrc = h[h.length - 1].s.length;
      for (let k = 0; k < nSrc; k++) {
        // search backwards for the emission time whose wavefront reaches the listener now
        for (let i = h.length - 1; i >= 0; i--) {
          const e = h[i].s[k];
          if (!e) break;
          const d = Math.hypot(e.x - listener.x, e.y - listener.y, e.z - listener.z);
          if (t - h[i].t >= d / C_SOUND) {
            if (e.p > 0) {
              const L = e.p / (1 + d / 250);
              level += L;
              lowpass = Math.min(lowpass, 300 + 16000 * Math.exp(-d / 2500));
              crack += L * Math.exp(-d / 6000);
            }
            break;
          }
        }
      }
    }
    level = Math.min(1.5, level);
    if (this.enabled && this.ctx) {
      const now = this.ctx.currentTime;
      const mute = Math.abs(timeScale - 1) > 0.01 && timeScale > 0 ? 0.35 : timeScale === 0 ? 0 : 1;
      const lv = Math.min(1, level) * mute;
      this.rumbleG.gain.setTargetAtTime(lv * 1.1, now, 0.08);
      this.roarG.gain.setTargetAtTime(lv * 0.55, now, 0.08);
      this.crackG.gain.setTargetAtTime(Math.min(1, crack) * 0.9 * mute, now, 0.05);
      this.roarF.frequency.setTargetAtTime(Math.max(200, lowpass * 0.35), now, 0.2);
      this.crackL.frequency.setTargetAtTime(Math.max(600, lowpass), now, 0.2);
    }
    return level;
  }
}
