// HUD (webcast-style telemetry) and the control panel.

const $ = (id) => document.getElementById(id);

// Flight 14 profile (T+ seconds)
const TIMELINE = [
  { t: 0, name: 'Liftoff' },
  { t: 60, name: 'Max-Q' },
  { t: 142, name: 'Hot staging' },
  { t: 150, name: 'Boostback' },
  { t: 420, name: 'Booster splashdown' },
  { t: 432, name: 'SECO' },
  { t: 1540, name: 'Orbit insertion' },
  { t: 2047, name: 'Starlink deploy' },
  { t: 7938, name: 'Deorbit burn' },
  { t: 9600, name: 'Entry' },
  { t: 10550, name: 'Peak heating' },
  { t: 11200, name: 'Flip & splashdown' },
];
const T_START = -20, T_END = 11300;
// piecewise time axis: the first 10 minutes get half of the bar
const axis = (t) => (t < 600 ? ((t - T_START) / (600 - T_START)) * 50 : 50 + ((t - 600) / (T_END - 600)) * 50);
const axisInv = (p) => (p < 50 ? T_START + (p / 50) * (600 - T_START) : 600 + ((p - 50) / 50) * (T_END - 600));
const SPEEDS = [
  { s: 0.25, l: '¼×' }, { s: 1, l: '1×' }, { s: 5, l: '5×' }, { s: 20, l: '20×' },
];
const LENS_MIN = 12, LENS_MAX = 2400; // mm, 35 mm full-frame equivalent (24 mm frame height)
const fovToMm = (fov) => 12 / Math.tan((fov * Math.PI) / 360);
const mmToFov = (mm) => (2 * Math.atan(12 / mm) * 180) / Math.PI;
const sliderToMm = (v) => LENS_MIN * Math.pow(LENS_MAX / LENS_MIN, v / 1000);
const mmToSlider = (mm) => (Math.log(mm / LENS_MIN) / Math.log(LENS_MAX / LENS_MIN)) * 1000;

function engineSvg(svg, layout, scale) {
  const circles = layout.map(([x, z, , type]) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', (x * scale).toFixed(2));
    c.setAttribute('cy', (z * scale).toFixed(2));
    c.setAttribute('r', type === 'vac' ? 1.25 : 0.55);
    svg.appendChild(c);
    return c;
  });
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ring.setAttribute('r', 4.6);
  ring.setAttribute('style', 'fill:none;stroke:rgba(255,255,255,.35);stroke-width:.08');
  svg.appendChild(ring);
  return circles;
}

export function createUI(h) {
  const ui = {};
  const camWrap = $('cams');
  const camBtns = {};
  h.cams.forEach((c, i) => {
    const b = document.createElement('button');
    b.textContent = `${i + 1} ${c.name}`;
    b.onclick = () => h.onCamera(c.id);
    camWrap.appendChild(b);
    camBtns[c.id] = b;
  });
  const lens = $('lens');
  lens.oninput = () => {
    const mm = sliderToMm(+lens.value);
    $('lensVal').textContent = `${mm.toFixed(0)} mm`;
    h.onLens(mmToFov(mm));
  };
  $('followShip').onchange = (e) => h.onFollowShip(e.target.checked);

  const speedWrap = $('speeds');
  const speedBtns = [];
  for (const sp of SPEEDS) {
    const b = document.createElement('button');
    b.textContent = sp.l;
    b.onclick = () => { speedBtns.forEach((x) => x.classList.remove('active')); b.classList.add('active'); h.onSpeed(sp.s); };
    if (sp.s === 1) b.classList.add('active');
    speedWrap.appendChild(b);
    speedBtns.push(b);
  }

  const el = $('sunEl'), az = $('sunAz');
  const sunChange = () => { $('elVal').textContent = `${(+el.value).toFixed(1)}°`; $('azVal').textContent = `${az.value}°`; h.onSun(+el.value, +az.value); };
  let sunTimer = null;
  const sunDebounced = () => { $('elVal').textContent = `${(+el.value).toFixed(1)}°`; $('azVal').textContent = `${az.value}°`; clearTimeout(sunTimer); sunTimer = setTimeout(sunChange, 60); };
  el.oninput = sunDebounced; az.oninput = sunDebounced;
  document.querySelectorAll('[data-sun]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.sun === 'morning') { el.value = 6; az.value = 92; } else { el.value = 8; az.value = 262; }
      sunChange();
    };
  });

  const qWrap = $('quality');
  const qBtns = {};
  for (const q of ['low', 'medium', 'high', 'ultra']) {
    const b = document.createElement('button');
    b.textContent = q === 'medium' ? 'med' : q;
    b.onclick = () => h.onQuality(q);
    qWrap.appendChild(b);
    qBtns[q] = b;
  }
  const ex = $('exposure');
  ex.oninput = () => { $('expVal').textContent = `${(+ex.value >= 0 ? '+' : '') + (+ex.value).toFixed(2)} EV`; h.onExposure(+ex.value); };
  $('expVal').textContent = '+0.00 EV';

  $('panelToggle').onclick = () => $('panel').classList.toggle('collapsed');
  // phones / narrow windows: start with the control panel folded away
  if (window.matchMedia('(max-width: 820px), (max-height: 520px)').matches) $('panel').classList.add('collapsed');
  $('restart').onclick = () => h.onRestart();
  $('play').onclick = () => h.onPlay();
  $('sound').onclick = () => h.onSound();

  // timeline marks
  const tl = $('timeline');
  const pct = (t) => Math.max(0, Math.min(100, axis(t)));
  const marks = TIMELINE.map((m) => {
    const d = document.createElement('div');
    d.className = 'mark';
    d.style.left = pct(m.t) + '%';
    d.innerHTML = `<span>${m.name}</span>`;
    d.title = m.name;
    d.onclick = () => h.onSeek(m.t - 6);
    tl.appendChild(d);
    return { ...m, el: d };
  });
  tl.addEventListener('click', (e) => {
    if (e.target !== tl && !e.target.classList.contains('progress')) return;
    const r = tl.getBoundingClientRect();
    h.onSeek(axisInv(((e.clientX - r.left) / r.width) * 100));
  });

  // engine maps
  const bLayout = [];
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 + Math.PI / 2; bLayout.push([0.78 * Math.cos(a), 0.78 * Math.sin(a)]); }
  for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2 + 0.31; bLayout.push([2.3 * Math.cos(a), 2.3 * Math.sin(a)]); }
  for (let k = 0; k < 20; k++) { const a = (k / 20) * Math.PI * 2; bLayout.push([3.78 * Math.cos(a), 3.78 * Math.sin(a)]); }
  const bDots = engineSvg($('bEngines'), bLayout, 1.1);
  const sLayout = [];
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 + Math.PI / 2; sLayout.push([1.05 * Math.cos(a), 1.05 * Math.sin(a), 0, 'sl']); }
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 - Math.PI / 2; sLayout.push([3.0 * Math.cos(a), 3.0 * Math.sin(a), 0, 'vac']); }
  const sDots = engineSvg($('sEngines'), sLayout, 1.1);

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); h.onPlay(); }
    else if (e.key === 'r' || e.key === 'R') h.onRestart();
    else if (e.key === 'h' || e.key === 'H') $('ui').classList.toggle('hidden');
    else if (/^[1-8]$/.test(e.key)) { const c = h.cams[+e.key - 1]; if (c) h.onCamera(c.id); }
  });

  const fmtClock = (t) => {
    const s = Math.abs(t);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
    return `T${t < 0 ? '−' : '+'}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };
  let lastHud = 0;
  ui.update = (sim, timeScale) => {
    const now = performance.now();
    if (now - lastHud < 80) return;
    lastHud = now;
    $('clock').textContent = fmtClock(sim.t);
    $('progress').style.width = Math.max(0, Math.min(100, pct(sim.t))) + '%';
    for (const m of marks) m.el.classList.toggle('done', sim.t >= m.t);
    const b = sim.booster.telemetry, s = sim.ship.telemetry;
    $('bSpeed').textContent = Math.round(b.v * 3.6).toLocaleString();
    $('bAlt').textContent = (Math.max(0, b.h) / 1000).toFixed(b.h < 10000 ? 1 : 0);
    $('sSpeed').textContent = Math.round(s.v * 3.6).toLocaleString();
    $('sAlt').textContent = (Math.max(0, s.h) / 1000).toFixed(s.h < 10000 ? 1 : 0);
    sim.booster.engines.forEach((e, i) => bDots[i].classList.toggle('on', sim.booster.active && e.level > 0.3));
    sim.ship.engines.forEach((e, i) => sDots[i].classList.toggle('on', e.level > 0.3));
    void timeScale;
  };
  ui.pushEvent = (e) => {
    const d = document.createElement('div');
    d.className = 'ev';
    d.textContent = e.name;
    $('events').appendChild(d);
    setTimeout(() => d.remove(), 5200);
    while ($('events').children.length > 3) $('events').firstChild.remove();
  };
  ui.clearEvents = () => { $('events').innerHTML = ''; };
  ui.setCamera = (id, fov) => {
    Object.values(camBtns).forEach((b) => b.classList.remove('active'));
    camBtns[id]?.classList.add('active');
    const mm = fovToMm(fov);
    lens.value = mmToSlider(mm);
    $('lensVal').textContent = `${mm.toFixed(0)} mm`;
  };
  ui.setQuality = (q) => { Object.values(qBtns).forEach((b) => b.classList.remove('active')); qBtns[q]?.classList.add('active'); };
  ui.setSun = (e, a) => { el.value = e; az.value = a; $('elVal').textContent = `${e.toFixed(1)}°`; $('azVal').textContent = `${a}°`; };
  ui.setPaused = (p) => { $('play').textContent = p ? '▶' : '❚❚'; };
  ui.setSound = (on) => { $('sound').textContent = on ? '🔊' : '🔇'; };
  ui.setFps = (f, res = 1) => { $('fps').textContent = `${f.toFixed(0)} fps` + (res < 1 ? ` · ${Math.round(res * 100)}% res` : ''); };
  let lastWarp = -1;
  ui.setWarp = (w) => { const r = Math.round(w); if (r === lastWarp) return; lastWarp = r; $('warp').textContent = r > 1 ? `AUTO ${r}×` : ''; };
  $('autoWarp').onchange = (e) => h.onAutoWarp(e.target.checked);
  ui.hideIntro = () => $('intro').classList.add('gone');
  ui.ready = (cb) => {
    $('loading').textContent = 'Ready. Countdown starts at T−20 s.';
    const go = (s) => { ui.hideIntro(); cb(s); };
    $('goSound').onclick = () => go(true);
    $('goMute').onclick = () => go(false);
  };
  return ui;
}
