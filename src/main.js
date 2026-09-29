import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FlightSim, LAUNCH_AZIMUTH, OMEGA, RE } from './physics.js';
import { Plasma } from './reentry.js';
import { StarlinkDeploy, DEPLOY_START, DEPLOY_END } from './starlink.js';
import { createSky, computeLighting, atmosParams } from './sky.js';
import { createTerrain } from './terrain.js';
import { createPad, MOUNT_HEIGHT } from './pad.js';
import { createBooster, createShip, BOOSTER_LEN } from './vehicle.js';
import { Plume } from './plume.js';
import { ParticleSystem, createPuffAtlas, KIND } from './particles.js';
import { Effects } from './effects.js';
import { Pipeline } from './post.js';
import { LaunchAudio } from './audio.js';
import { shared } from './shared.js';
import { createUI } from './ui.js';
import { createClouds, bakeWeather } from './clouds.js';
import { SmokeVolume, insideVolume } from './smoke.js';
import { sunTransmittanceJS } from './sky.js';
import { prof } from './prof.js';
import { QualityGovernor } from './governor.js';

// ------------------------------------------------------------------ setup
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance', stencil: false });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // re-rendered on demand (updateShadowCache)
renderer.autoClear = true;

const FAR = 2e6;
const camera = new THREE.PerspectiveCamera(38, 1, 0.5, FAR);
const scene = new THREE.Scene();
const pscene = new THREE.Scene(); // particles & plumes (rendered into the transparent pass)
const pipeline = new Pipeline(renderer);

const QUALITY = {
  low: { smokeSteps: 48, smokeScale: 0.4, cloudScale: 0.33, clouds: 64, scale: 0.55, part: 0.4, refl: 0.25, shadow: 2048, msaa: 0, emit: 0.55, sky: 10, lighting: 0.2, maxParticles: 9000 },
  medium: { smokeSteps: 72, smokeScale: 0.5, cloudScale: 0.4, clouds: 90, scale: 0.75, part: 0.5, refl: 0.33, shadow: 2048, msaa: 2, emit: 0.75, sky: 12, lighting: 0.25, maxParticles: 12000 },
  high: { smokeSteps: 100, smokeScale: 0.6, cloudScale: 0.5, clouds: 128, scale: 1.0, part: 0.6, refl: 0.5, shadow: 4096, msaa: 4, emit: 1.0, sky: 16, lighting: 0.34, maxParticles: 16000 },
  ultra: { smokeSteps: 150, smokeScale: 0.75, cloudScale: 0.6, clouds: 160, scale: Math.min(window.devicePixelRatio || 1, 2), part: 0.75, refl: 0.6, shadow: 4096, msaa: 4, emit: 1.0, sky: 20, lighting: 0.5, maxParticles: 16000 },
};
const params = new URLSearchParams(location.search);
// ?prof (GPU timer queries), ?prof=sync (exact, serialised), ?prof=cpu; window.__prof.report()
prof.init(renderer.getContext(), params.has('prof') && (params.get('prof') || true));
if (prof.enabled) {
  const sm = renderer.shadowMap, r0 = sm.render.bind(sm);
  sm.render = (...a) => { if ((!sm.needsUpdate && !sm.autoUpdate) || !a[0].length) return r0(...a); prof.begin('shadow'); r0(...a); prof.end(); };
}
let qualityName = params.get('q') || (/(iPhone|iPad|Android)/i.test(navigator.userAgent) ? 'low' : 'high');
let Q = QUALITY[qualityName] || QUALITY.high;
// keeps >= 30 fps by trading internal resolution (never above the preset; ?nogov disables)
const gov = new QualityGovernor({ targetFps: 30, enabled: !params.has('nogov') });

// sky & light
const sky = createSky(renderer);
scene.add(sky.mesh);
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.castShadow = true;
sun.shadow.mapSize.set(Q.shadow, Q.shadow);
const sc = sun.shadow.camera;
sc.left = -430; sc.right = 430; sc.top = 430; sc.bottom = -430; sc.near = 10; sc.far = 7000;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.8;
scene.add(sun, sun.target);
const flameLight = new THREE.PointLight(0xff9a50, 0, 0, 2);
scene.add(flameLight);

const terrain = createTerrain();
scene.add(terrain);
const pad = createPad();
scene.add(pad);

const booster = createBooster();
const ship = createShip();
scene.add(booster.group, ship.group);
const boosterPlume = new Plume(booster.layout, { clusterR: 4.2, gain: 1.0 });
const shipPlume = new Plume(ship.layout, { clusterR: 3.0, gain: 0.9 });
pscene.add(boosterPlume.group, shipPlume.group);
const plasma = new Plasma();
pscene.add(plasma.group);
const starlink = new StarlinkDeploy();
scene.add(starlink.group);

const ps = new ParticleSystem(QUALITY.high.maxParticles + 4000);
pscene.add(ps.farMesh, ps.nearMesh);
const clouds = createClouds();
pscene.add(clouds.mesh);
const smoke = new SmokeVolume(renderer, clouds.noise);
pscene.add(smoke.compBack, smoke.compFront);
ps.volumeTest = (x, y, z) => insideVolume(x, y, z, 20);
const effects = new Effects(ps);
const audio = new LaunchAudio();
const sim = new FlightSim();

// ------------------------------------------------------------------ sun
const sunState = { el: 6, az: 92 }; // Flight 14: 07:49 CDT, ~30 min after sunrise
const sunDir = new THREE.Vector3();
const sun0 = new THREE.Vector3(); // sun direction at the pad at T-0 (fixed in inertial space)
let lighting = null;
function setSun(el, az) {
  sunState.el = el; sunState.az = az;
  const e = THREE.MathUtils.degToRad(el), a = THREE.MathUtils.degToRad(az);
  sun0.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
  localSun(sunDir);
  refreshLighting(40);
  ps.sunDir.copy(sunDir);
  ps.lightClouds(sunDir);
  envDirty = true;
}
let lastLightAlt = 0;
function refreshLighting(alt) {
  lastLightAlt = alt;
  lighting = computeLighting(sunDir, alt);
  shared.uSunDir.value.copy(sunDir);
  sky.uniforms.uSunDir.value.copy(sunDir);
  shared.uSunColor.value.copy(lighting.sun);
  shared.uSkyAmb.value.copy(lighting.sky);
  shared.uGroundAmb.value.copy(lighting.ground);
  shared.uAerialSun.value.copy(lighting.aerialSun);
  shared.uAerialAmb.value.copy(lighting.sky);
  lighting.ring.forEach((c, i) => shared.uHorizon.value[i].copy(c));
  sun.color.setRGB(lighting.sun.x, lighting.sun.y, lighting.sun.z);
  clouds.uniforms.uCloudSun.value.copy(sunTransmittanceJS(2500, sunDir)).multiplyScalar(22);
  sun.intensity = 1;
  // auto exposure from scene illuminance (sky + sun)
  const lum = (v) => 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
  // partial automatic white balance, like a camera: neutralise the scene illuminant by ~55%
  const ill = lighting.sun.clone().multiplyScalar(Math.max(0.05, sunDir.y) * 0.5).add(lighting.sky.clone().multiplyScalar(3.0));
  ill.addScalar(1e-4); // night side: no illuminant, keep the balance neutral (and finite)
  const il = (ill.x + ill.y + ill.z) / 3;
  const wb = new THREE.Vector3(il / ill.x, il / ill.y, il / ill.z);
  if (il < 0.01) wb.set(1, 1, 1);
  wb.set(Math.pow(wb.x, 0.55), Math.pow(wb.y, 0.55), Math.pow(wb.z, 0.55));
  const wl = 0.2126 * wb.x + 0.7152 * wb.y + 0.0722 * wb.z;
  pipeline.params.wb = wb.multiplyScalar(1 / wl);
  baseExposure = Math.min(3, 1.15 / Math.max(0.02, lum(lighting.sky) * 1.4 + lum(lighting.sun) * Math.max(0.05, sunDir.y) * 0.25));
}
let baseExposure = 1, userEV = 0;

// environment map (sky + terrain + pad) for metal reflections & ambient
const pmrem = new THREE.PMREMGenerator(renderer);
const cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
const cubeCam = new THREE.CubeCamera(1, FAR, cubeRT);
let envDirty = true, envRT = null;
function updateEnvironment() {
  prof.begin('env');
  booster.group.visible = ship.group.visible = false;
  sky.uniforms.uSunDisc.value = 0;
  cubeCam.position.set(40, 70, 60);
  sky.mesh.position.copy(cubeCam.position);
  cubeCam.update(renderer, scene);
  sky.uniforms.uSunDisc.value = 1;
  if (envRT) envRT.dispose();
  envRT = pmrem.fromCubemap(cubeRT.texture);
  scene.environment = envRT.texture;
  booster.group.visible = ship.group.visible = true;
  envDirty = false;
  envSun.copy(sunDir);
  prof.end();
}

// ------------------------------------------------------------------ shadow cache
// The sun shadow map is only re-rendered when the sun moved or a shadow caster inside the
// shadow frustum moved, appeared or vanished (the pad itself is static).
const shadowCache = { sig: NaN, casters: [], n: -1 };
const _sph = new THREE.Sphere();
const worldVisible = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
function updateShadowCache() {
  if (shadowCache.n !== scene.children.length) {
    shadowCache.n = scene.children.length;
    shadowCache.casters = [];
    for (const c of scene.children) {
      if (c === pad) continue;
      c.traverse((o) => { if (o.isMesh && o.castShadow) { if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); shadowCache.casters.push(o); } });
    }
  }
  for (const c of scene.children) if (c !== pad && c !== terrain && c !== sky.mesh) c.updateMatrixWorld();
  sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
  sun.shadow.updateMatrices(sun);
  const fr = sun.shadow.getFrustum();
  const p = sun.position, q = sun.target.position;
  let sig = p.x + p.y * 3 + p.z * 7 + q.x * 11 + q.y * 13 + q.z * 17 + (pad.visible ? 0.5 : 0) + sun.shadow.mapSize.x;
  for (const m of shadowCache.casters) {
    if (!worldVisible(m)) continue;
    _sph.copy(m.geometry.boundingSphere).applyMatrix4(m.matrixWorld);
    if (!fr.intersectsSphere(_sph)) continue;
    const e = m.matrixWorld.elements;
    sig = sig * 1.000123 + 1;
    for (let k = 0; k < 16; k++) sig += Math.round(e[k] * 1e4) * (k + 1.37); // ignore sub-mm pose jitter
  }
  if (sig !== shadowCache.sig) { shadowCache.sig = sig; renderer.shadowMap.needsUpdate = true; }
}

// ------------------------------------------------------------------ camera
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 1.5e6;
controls.minDistance = 3;
controls.zoomSpeed = 1.2;

const CAMS = [
  { id: 'drone', name: 'Drone', mode: 'track', pos: [-760, 300, 1180], fov: 34 },
  { id: 'telephoto', name: 'Long lens', mode: 'track', pos: [-980, 3.5, 2950], fov: 5.4, lead: 0.1 },
  { id: 'lagoon', name: 'Lagoon', mode: 'track', pos: [-3300, 1.7, 1150], fov: 6.2 },
  { id: 'chase', name: 'Chase plane', mode: 'chase', offset: [180, -40, 1250], fov: 20 },
  { id: 'pad', name: 'Pad cam', mode: 'track', pos: [150, 4, 210], fov: 48 },
  { id: 'onboard', name: 'Onboard', mode: 'onboard', fov: 70 },
  { id: 'tracker', name: 'Tracker', mode: 'track', pos: [700, 4, -8700], fov: 'auto' },
  { id: 'orbit', name: 'Free orbit', mode: 'free', pos: [-260, 140, 380], target: [0, 60, 0], fov: 45 },
];
let cam = CAMS[0];
let lensFov = 34;
let followShip = true;
const trackTarget = new THREE.Vector3(0, 60, 0);
const lastFocus = new THREE.Vector3();
function setCamera(c) {
  cam = c;
  controls.enabled = c.mode !== 'onboard';
  if (c.pos) camera.position.set(...c.pos);
  const f = focusPoint();
  if (c.target) controls.target.set(...c.target);
  else controls.target.copy(f);
  if (c.mode === 'chase') {
    camera.position.copy(f).add(new THREE.Vector3(...c.offset));
    controls.target.copy(f);
  }
  lastFocus.copy(f);
  lensFov = c.fov === 'auto' ? autoFov() : c.fov;
  camera.fov = lensFov;
  camera.updateProjectionMatrix();
  controls.update();
  ui.setCamera(c.id, lensFov);
}
function autoFov() {
  const f = focusPoint();
  const d = camera.position.distanceTo(f);
  return THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((140 * 2.2) / 2 / d)), 0.4, 60);
}

// ------------------------------------------------------------------ poses
const dirH = new THREE.Vector3(Math.sin(LAUNCH_AZIMUTH), 0, -Math.cos(LAUNCH_AZIMUTH));
const tiltAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dirH).normalize();
const yawBooster = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-30));
const yawShip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-30));
const yawEntry = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI - LAUNCH_AZIMUTH);
const _yawTmp = new THREE.Quaternion();
const pose = {
  boosterPos: new THREE.Vector3(), boosterQuat: new THREE.Quaternion(), boosterVel: new THREE.Vector3(),
  shipPos: new THREE.Vector3(), shipQuat: new THREE.Quaternion(), shipVel: new THREE.Vector3(), shipAxis: new THREE.Vector3(0, 1, 0),
};
const prevB = new THREE.Vector3(), prevS = new THREE.Vector3();
let splashT = null;
// Scene origin ("anchor") = a point on the launch great circle. It stays at the pad
// until the tracked stage is far downrange, then hops along with it so that the
// scene stays numerically small (orbit, re-entry, splashdown in the Indian Ocean).
let anchorAngle = 0;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function stagePose(tel, offsetY, outPos, outQuat, yaw) {
  const d = wrapPi(tel.downrange / RE - anchorAngle);
  const r = RE + tel.h;
  outPos.copy(dirH).multiplyScalar(r * Math.sin(d));
  outPos.y = r * Math.cos(d) - RE + (anchorAngle === 0 ? offsetY : 0);
  outQuat.setFromAxisAngle(tiltAxis, tel.tilt - anchorAngle).multiply(yaw);
}
// local sun direction at the anchor: the Earth has turned (omega*t) and we moved (anchor)
function localSun(out) {
  const ang = anchorAngle + OMEGA * Math.max(0, sim.t);
  return out.copy(sun0).applyAxisAngle(tiltAxis, -ang);
}
function updateAnchor() {
  const tel = sim.stacked || followShip ? sim.ship.telemetry : sim.booster.telemetry;
  const range = tel.downrange;
  const angle = range / RE;
  let a = anchorAngle;
  if (Math.abs(range) < 250000 && anchorAngle === 0) a = 0;
  else if (Math.abs(wrapPi(angle - anchorAngle)) * RE > 60000 || (anchorAngle === 0 && Math.abs(range) >= 250000)) a = Math.round(angle * RE / 50000) * 50000 / RE;
  if (Math.abs(range) < 200000) a = 0;
  if (a !== anchorAngle) {
    anchorAngle = a;
    const far = anchorAngle !== 0;
    pad.visible = !far;
    terrain.userData.uniforms.uOpen.value = far ? 1 : 0;
    for (let i = ps.count - 1; i >= 0; i--) if (ps.kind[i] !== KIND.CLOUD) ps.kill(i);
    return true;
  }
  return false;
}
function updatePoses(dt) {
  prevB.copy(pose.boosterPos); prevS.copy(pose.shipPos);
  const B = sim.booster, S = sim.ship;
  // the launch mount raises the vehicle 20 m; blend the offset out after staging
  const off = sim.stacked ? MOUNT_HEIGHT : MOUNT_HEIGHT * Math.max(0, 1 - (sim.t - (sim.stageTime ?? sim.t)) / 30);
  stagePose(B.telemetry, off, pose.boosterPos, pose.boosterQuat, yawBooster);
  if (sim.stacked) {
    pose.shipQuat.copy(pose.boosterQuat).multiply(yawBooster.clone().invert()).multiply(yawShip);
    pose.shipPos.set(0, BOOSTER_LEN, 0).applyQuaternion(pose.boosterQuat).add(pose.boosterPos);
  } else {
    // after SECO the ship rolls so its tiled belly (local +Z) faces the direction of flight
    const k = sim.secoT !== undefined ? Math.min(1, Math.max(0, (sim.t - sim.secoT - 20) / 90)) : 0;
    stagePose(S.telemetry, off, pose.shipPos, pose.shipQuat, _yawTmp.copy(yawShip).slerp(yawEntry, k * k * (3 - 2 * k)));
  }
  // splashdown: tip over and sink
  if (!B.active && sim.flags['Booster splashdown']) {
    splashT ??= sim.t;
    const k = Math.min(1, (sim.t - splashT) / 7);
    const tip = new THREE.Quaternion().setFromAxisAngle(tiltAxis, -k * k * 1.45);
    pose.boosterQuat.premultiply(tip);
    pose.boosterPos.y = -k * 6;
  } else splashT = null;
  if (dt > 0) {
    pose.boosterVel.subVectors(pose.boosterPos, prevB).divideScalar(dt);
    pose.shipVel.subVectors(pose.shipPos, prevS).divideScalar(dt);
    if (pose.boosterVel.length() > 20000) pose.boosterVel.set(0, 0, 0);
    if (pose.shipVel.length() > 20000) pose.shipVel.set(0, 0, 0);
  }
  // ship: after a tail-first splashdown it topples onto the water
  if (sim.shipLanded) {
    const k = Math.min(1, Math.max(0, (sim.t - sim.shipLanded.t) / 3.4));
    const tip = new THREE.Quaternion().setFromAxisAngle(tiltAxis, k * k * 1.5);
    pose.shipQuat.premultiply(tip);
    pose.shipPos.y = -k * 4;
  }
  pose.shipAxis.set(0, 1, 0).applyQuaternion(pose.shipQuat);
  booster.group.position.copy(pose.boosterPos);
  booster.group.quaternion.copy(pose.boosterQuat);
  ship.group.position.copy(pose.shipPos);
  ship.group.quaternion.copy(pose.shipQuat);
  booster.group.visible = !(splashT !== null && sim.t - splashT > 30) && (anchorAngle === 0 || Math.abs(wrapPi(B.telemetry.downrange / RE - anchorAngle)) * RE < 400000);
  ship.group.visible = !(sim.shipLanded && sim.t - sim.shipLanded.t > 4.2);
}

function focusPoint() {
  const f = new THREE.Vector3();
  if (sim.stacked) f.set(0, 60, 0).applyQuaternion(pose.boosterQuat).add(pose.boosterPos);
  else if (followShip) f.set(0, 25, 0).applyQuaternion(pose.shipQuat).add(pose.shipPos);
  else f.set(0, 35, 0).applyQuaternion(pose.boosterQuat).add(pose.boosterPos);
  return f;
}

// ------------------------------------------------------------------ time control
let timeScale = 1, paused = false, seeking = null;
const STEP = 1 / 120;
let simAcc = 0;
function restart() {
  sim.reset();
  for (let i = ps.count - 1; i >= 0; i--) if (ps.kind[i] !== KIND.CLOUD) ps.kill(i);
  effects.acc = {}; effects.stagingBurst = false;
  splashT = null;
  eventsShown = 0;
  updatePoses(0);
  ui.clearEvents();
}
function seek(t) {
  if (t < sim.t) restart();
  seeking = t;
}

function advance(simDt) {
  // subdivide so emission and particle integration stay stable under time warp
  // (big warps: coarser particle chunks; the flight physics always steps at 1/120 s)
  const chunk = Math.max(seeking !== null ? 1 / 12 : 1 / 30, simDt / 24);
  let left = simDt;
  while (left > 1e-6) {
    const d = Math.min(chunk, left);
    simAcc += d;
    prof.cbegin('physics');
    while (simAcc >= STEP) { sim.step(STEP); simAcc -= STEP; }
    updatePoses(d);
    prof.cend();
    prof.cbegin('effects');
    effects.update(d, {
      sim, quality: Q.emit, stacked: sim.stacked, atPad: anchorAngle === 0,
      boosterPos: pose.boosterPos, boosterQuat: pose.boosterQuat, boosterVel: pose.boosterVel,
      shipPos: pose.shipPos, shipQuat: pose.shipQuat, shipVel: pose.shipVel, shipAxis: pose.shipAxis,
      boosterPlume, shipPlume, shipThrust: sim.ship.engines.reduce((a, e) => a + e.level, 0) / 6,
    });
    prof.cend();
    prof.cbegin('ps.update');
    ps.update(d);
    prof.cend();
    left -= d;
  }
  ps.driftClouds(simDt);
}

// automatic time-warp through the long quiet parts of the mission (coast, orbit, entry)
let autoWarp = true;
function autoWarpFactor() {
  const S = sim.ship;
  if (sim.stacked || !S.active) return 1;
  const ts = sim.t - (sim.secoT ?? 1e9);
  const vRad = S.telemetry.vVert;
  switch (S.phase) {
    case 'coast':
      if (!sim.flags['Orbit insertion']) return ts < 20 ? 1 : Math.abs(vRad) < 40 ? 2 : 40;
      return S.telemetry.h > 130000 ? 40 : 6; // after the deorbit burn, heading for entry
    case 'orbit': {
      const toDeorbit = sim.deorbitT - sim.t;
      if (toDeorbit < 20) return 1;
      if (toDeorbit < 400) return 10;
      // slow down while the Starlink V3 satellites leave the payload door
      if (sim.t > DEPLOY_START - 30 && sim.t < DEPLOY_END + 60) return 12;
      return 60;
    }
    case 'insertion': case 'deorbit': return 1;
    case 'entry': return (S.heat || 0) > 0.25 ? 4 : 12;
    case 'bellyflop': return S.telemetry.h > 4000 ? 3 : 1;
    default: return 1;
  }
}

// ------------------------------------------------------------------ UI
const ui = createUI({
  cams: CAMS,
  onCamera: (id) => setCamera(CAMS.find((c) => c.id === id)),
  onLens: (fov) => { lensFov = fov; camera.fov = fov; camera.updateProjectionMatrix(); },
  onSpeed: (s) => { timeScale = s; paused = s === 0; },
  onPlay: () => { paused = !paused; ui.setPaused(paused); },
  onRestart: () => restart(),
  onSeek: (t) => seek(t),
  onSun: (el, az) => setSun(el, az),
  onQuality: (q) => setQuality(q),
  onExposure: (ev) => { userEV = ev; },
  onFollowShip: (v) => { followShip = v; },
  onAutoWarp: (v) => { autoWarp = v; },
  onSound: async () => {
    if (audio.enabled) audio.stop(); else await audio.start();
    ui.setSound(audio.enabled);
  },
  onToggleUI: () => {},
});

function setQuality(name) {
  qualityName = name;
  Q = QUALITY[name];
  pipeline.params.partScale = Q.part;
  pipeline.params.reflScale = Q.refl;
  pipeline.params.msaa = Q.msaa;
  sky.uniforms.uSteps.value = Q.sky;
  gov.set(0); gov.reset();
  applySteps();
  if (sun.shadow.map && sun.shadow.mapSize.x !== Q.shadow) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  sun.shadow.mapSize.set(Q.shadow, Q.shadow);
  resize();
  ui.setQuality(name);
}

function applySteps() {
  clouds.uniforms.uSteps.value = Math.round(Q.clouds * gov.steps);
  smoke.uniforms.uSteps.value = Math.round(Q.smokeSteps * gov.steps);
}

// ------------------------------------------------------------------ resize
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const k = Q.scale * gov.scale;
  renderer.setPixelRatio(1);
  renderer.setSize(Math.floor(w * k), Math.floor(h * k), false);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pipeline.setSize(Math.floor(w * k), Math.floor(h * k));
  shared.uResolution.value.set(pipeline.w, pipeline.h);
  clouds.setSize(pipeline.w * Q.cloudScale, pipeline.h * Q.cloudScale);
  smoke.setSize(pipeline.w * Q.smokeScale, pipeline.h * Q.smokeScale);
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------------ render
const mirror = new THREE.PerspectiveCamera();
const reflMatrix = new THREE.Matrix4();
const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
const _d = new THREE.Vector3(), _u = new THREE.Vector3(), _res = new THREE.Vector2();
function renderReflection() {
  mirror.copy(camera);
  mirror.position.set(camera.position.x, -camera.position.y, camera.position.z);
  camera.getWorldDirection(_d); _d.y *= -1;
  _u.set(0, 1, 0).applyQuaternion(camera.quaternion); _u.y *= -1;
  mirror.up.copy(_u);
  mirror.lookAt(_d.add(mirror.position));
  mirror.updateMatrixWorld();
  mirror.projectionMatrix.copy(camera.projectionMatrix);
  reflMatrix.multiplyMatrices(bias, mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
  shared.uReflMatrix.value.copy(reflMatrix);

  terrain.visible = false;
  sky.mesh.position.copy(mirror.position);
  sky.uniforms.uCamAlt.value = 2;
  renderer.setRenderTarget(pipeline.refl);
  prof.begin('refl.scene');
  renderer.render(scene, mirror);
  prof.end();
  prof.begin('refl.clouds');
  clouds.renderReflection(renderer, mirror);
  prof.end();
  smoke.compBack.visible = smoke.compFront.visible = false;
  prof.begin('refl.smoke');
  smoke.renderReflection(mirror);
  prof.end();
  ps.setReflectionMode(true); boosterPlume.setReflectionMode(true); shipPlume.setReflectionMode(true);
  clouds.mesh.visible = false;
  renderer.autoClear = false;
  prof.begin('refl.part');
  renderer.render(pscene, mirror);
  prof.end();
  renderer.autoClear = true;
  ps.setReflectionMode(false); boosterPlume.setReflectionMode(false); shipPlume.setReflectionMode(false);
  clouds.mesh.visible = true;
  smoke.compBack.visible = smoke.compFront.visible = true;
  terrain.visible = true;
  shared.uReflection.value = pipeline.refl.texture;
}

// depth prepass for the reduced-res passes (soft particles, plumes, clouds, smoke): the opaque
// scene, depth only, without MSAA (resolving the MSAA float depth of the main pass is slow on
// tile GPUs). Log depth like the main pass; transparent objects and the sky write no depth.
const depthMats = {};
function depthMaterial(side, isTerrain) {
  const k = side + (isTerrain ? 't' : '');
  if (!depthMats[k]) {
    const m = new THREE.MeshBasicMaterial({ colorWrite: false, side });
    if (isTerrain) { // same Earth-curvature drop as the terrain material
      m.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n{ vec2 f = (modelMatrix * vec4(transformed, 1.0)).xz; transformed.y -= dot(f, f) / (2.0 * 6371000.0); }');
      };
      m.customProgramCacheKey = () => 'terrainDepth';
    }
    depthMats[k] = m;
  }
  return depthMats[k];
}
const _swap = [];
function renderDepth() {
  _swap.length = 0;
  scene.traverseVisible((o) => {
    if (!o.isMesh) return;
    const m = o.material, m0 = Array.isArray(m) ? m[0] : m;
    const hide = o === sky.mesh || m0.transparent || !m0.depthWrite || !m0.visible;
    _swap.push(o, m, hide);
    if (hide) o.visible = false;
    else o.material = depthMaterial(m0.side, o === terrain);
  });
  renderer.setRenderTarget(pipeline.depth);
  renderer.render(scene, camera);
  for (let i = 0; i < _swap.length; i += 3) { if (_swap[i + 2]) _swap[i].visible = true; else _swap[i].material = _swap[i + 1]; }
  _swap.length = 0;
}

let frameCount = 0;
let spaceFramed = false;
const _sunTmp = new THREE.Vector3(), envSun = new THREE.Vector3();
let lastLightT = 0, lastEnvT = 0;
const DBG = { refl: !params.has('norefl'), clouds: !params.has('noclouds'), smoke: !params.has('nosmoke'), part: !params.has('nopart') };
function render(time) {
  // reflection first (sampled by the water in the main pass; no terrain from high altitude)
  if (DBG.refl && camera.position.y <= 45000) renderReflection();
  sky.mesh.position.copy(camera.position);
  sky.uniforms.uCamAlt.value = Math.max(1, camera.position.y);
  // from high altitude the whole Earth (surface + clouds) comes from the sky shader
  const high = camera.position.y > 45000;
  terrain.visible = !high;
  sky.uniforms.uPlanetOffset.value.set(anchorAngle * 900, 0, 0);
  prof.begin('depth');
  renderDepth();
  prof.end();
  renderer.setRenderTarget(pipeline.main);
  prof.begin('main');
  renderer.render(scene, camera);
  prof.end();

  // particles & plumes, manual depth test against the depth prepass
  const depth = pipeline.depth.depthTexture;
  const res = _res.set(pipeline.part.width, pipeline.part.height);
  ps.uniforms.uDepth.value = depth;
  ps.uniforms.uPartRes.value.copy(res);
  ps.uniforms.uLogFar.value = Math.log2(FAR + 1);
  boosterPlume.setDepth(depth, res, Math.log2(FAR + 1));
  prof.begin('clouds');
  if (DBG.clouds && !high) clouds.render(renderer, camera, depth);
  prof.end();
  clouds.mesh.visible = !high;
  prof.begin('smoke.march');
  if (DBG.smoke) smoke.render(camera, depth, boosterPlume.axis, ps.time);
  prof.end();
  shipPlume.setDepth(depth, res, Math.log2(FAR + 1));
  plasma.setDepth(depth, res, Math.log2(FAR + 1));
  prof.begin('part');
  renderer.setRenderTarget(pipeline.part);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.autoClear = false;
  if (DBG.part) renderer.render(pscene, camera);
  renderer.autoClear = true;
  prof.end();

  pipeline.params.exposure = baseExposure * Math.pow(2, userEV);
  prof.begin('post');
  pipeline.finish(time);
  prof.end();
  frameCount++;
}

// ------------------------------------------------------------------ loop
let last = performance.now();
let fpsAcc = 0, fpsN = 0, eventsShown = 0;
const shakeQ = new THREE.Quaternion(), saveQ = new THREE.Quaternion(), shakeE = new THREE.Euler();
const _nozzle = new THREE.Vector3(), _fire = new THREE.Vector3(), _off = new THREE.Vector3(), _origin = new THREE.Vector3();
let started = false;
// ?fixdt: deterministic virtual clock (1/60 s per frame, frozen while paused) for reproducible captures
const FIXDT = params.has('fixdt');
let vclock = 0;
let cpuMs = 0;
function tick(now) {
  requestAnimationFrame(tick);
  const t0 = performance.now();
  if (FIXDT) { if (!paused) vclock += 1000 / 60; now = vclock; last = Math.min(last, now - 1000 / 60); }
  if (gov.sample(now - last, cpuMs, seeking !== null || !started)) { resize(); applySteps(); }
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsAcc += dtReal; fpsN++;
  if (fpsAcc > 0.5) { ui.setFps(fpsN / fpsAcc, gov.scale); fpsAcc = 0; fpsN = 0; }

  let scale = paused || !started ? 0 : timeScale * (autoWarp ? autoWarpFactor() : 1);
  ui.setWarp(autoWarp && scale > timeScale * 1.01 ? scale : 0);
  if (seeking !== null) {
    scale = Math.min(sim.t > 900 ? 900 : 60, Math.max(4, (seeking - sim.t) * 2));
    if (sim.t >= seeking) { seeking = null; if (params.has('pause')) { paused = true; ui.setPaused(true); } }
  }
  const simDt = dtReal * scale;
  prof.cbegin('cpu.frame');
  advance(simDt);

  // scene anchor follows the tracked stage far downrange; the local sun moves with
  // Earth's rotation and our position along the ground track
  const reAnchored = updateAnchor();
  localSun(_sunTmp);
  const sunMoved = _sunTmp.angleTo(sunDir) > 0.004;
  if (sunMoved) { sunDir.copy(_sunTmp); ps.sunDir.copy(sunDir); }
  // lighting follows the vehicle altitude when the camera is up there
  const alt = Math.max(30, Math.min(camera.position.y, 150000));
  // (throttled: lighting at most ~5x per second, the environment probe every few seconds)
  if ((sunMoved || reAnchored || Math.abs(alt - lastLightAlt) > Math.max(200, lastLightAlt * 0.15)) && now - lastLightT > 200) { refreshLighting(alt); lastLightT = now; }
  if ((reAnchored || _sunTmp.angleTo(envSun) > 0.05) && !envDirty && now - lastEnvT > 3000 && scale < 20) { envDirty = true; lastEnvT = now; }
  terrain.userData.uniforms.uDeluge.value = anchorAngle === 0 ? sim.deluge : 0;

  // engines, plumes, flame light
  const bLev = sim.booster.engines.map((e) => (sim.booster.active ? e.level : 0));
  const sLev = sim.ship.engines.map((e) => e.level);
  booster.setGlow(bLev);
  ship.setGlow(sLev);
  booster.group.updateMatrixWorld(true);
  ship.group.updateMatrixWorld(true);
  boosterPlume.update(booster.group.matrixWorld, bLev, sim.booster.telemetry.pa, camera, Q.emit);
  shipPlume.update(ship.group.matrixWorld, sLev, sim.ship.telemetry.pa, camera, Q.emit);
  plasma.update(ship.group, pose.shipVel, sim.ship.heat || 0, camera);
  starlink.update(sim.t, ship.group, sim.ship.active && anchorAngle !== 0);
  ship.materials.tiles.userData.uniforms && (ship.materials.tiles.userData.uniforms.uHeat.value = Math.min(1, (sim.ship.heat || 0) * 1.1));
  booster.materials.ringMat.userData.shader && (booster.materials.ringMat.userData.shader.uniforms.uVentGlow.value =
    sim.flags['Hot staging'] && sim.t - (sim.stageTime ?? 0) < 4 ? Math.max(0, 1 - (sim.t - sim.stageTime) / 4) : 0);
  // frost sheds with altitude and aerodynamic heating
  // vapour sheath: light venting on the pad, thick while slow & low, gone by ~10 km
  {
    const v = sim.booster.telemetry.v, hh = sim.booster.telemetry.h;
    const onPad = !sim.released;
    const k = onPad ? 0.5 : Math.min(1, 0.6 + v / 60) * Math.exp(-hh / 5000) * (sim.stacked ? 1 : 0);
    booster.vapor.uVapor.value = k;
    const M = sim.booster.telemetry.mach;
    booster.collar.uCollar.value = sim.stacked ? Math.exp(-Math.pow((M - 1.0) / 0.13, 2)) * (hh < 15000 ? 1 : 0) : 0;
    booster.vapor.uFlow.value += dtReal * scale * (onPad ? 0.25 : 0.25 + v * 0.02);
  }
  const frost = booster.materials.steel.userData.shader;
  if (frost) frost.uniforms.uFrost.value = THREE.MathUtils.clamp(1 - sim.booster.telemetry.h / 30000, 0.25, 1);

  const thrust = bLev.reduce((a, b) => a + b, 0) / 33;
  const bh = pose.boosterPos.y;
  const nozzle = _nozzle.set(0, -2, 0).applyQuaternion(pose.boosterQuat).add(pose.boosterPos);
  const fire = _fire.set(nozzle.x, Math.max(4, Math.min(nozzle.y - 25, nozzle.y * 0.5)), nozzle.z);
  const flicker = 0.85 + 0.15 * Math.sin(now * 0.05) * Math.sin(now * 0.031);
  let fI = thrust * flicker * (bh < 3000 ? 1 : 0.3) * (anchorAngle === 0 ? 1 : 0);
  // splashdown fireball lights the water & smoke
  if (sim.shipLanded && anchorAngle !== 0) {
    const tb = sim.t - sim.shipLanded.t - 3.4;
    const b = tb > 0 ? Math.exp(-tb / 2.2) * 1.4 : 0;
    if (b > 0.01) { fire.copy(pose.shipPos).setY(10); fI = Math.max(fI, b); }
  }
  flameLight.position.copy(fire);
  flameLight.intensity = 9.0e4 * fI;
  flameLight.color.setRGB(1, 0.58, 0.3);
  shared.uFlamePos.value.copy(fire);
  shared.uFlameColor.value.set(1, 0.55, 0.26).multiplyScalar(3.2e4 * fI);
  ps.flamePos.copy(fire);
  ps.flameOn = fI;
  ps.jet = { x: nozzle.x, z: nozzle.z, yTop: nozzle.y, strength: thrust * Math.exp(-Math.max(0, bh - MOUNT_HEIGHT) / 150) * (sim.booster.active ? 1 : 0) };

  // camera
  const focus = focusPoint();
  // far from Starbase, ground-based cameras ride along with the vehicle instead
  if (anchorAngle !== 0 && !spaceFramed && (cam.mode === 'track' || cam.mode === 'fixed' || cam.mode === 'chase') && sim.ship.telemetry.h > 60000) {
    // first frame far downrange: frame the ship with the Earth below (like the webcast views)
    spaceFramed = true;
    const back = dirH.clone().multiplyScalar(-260);
    camera.position.copy(focus).add(back).add(new THREE.Vector3(0, 55, 0)).addScaledVector(tiltAxis, 120);
    controls.target.copy(focus);
  }
  if (anchorAngle === 0) spaceFramed = false;
  if (cam.mode === 'chase' || (anchorAngle !== 0 && (cam.mode === 'track' || cam.mode === 'fixed'))) {
    // keep the user's orbit offset, but lock the target onto the vehicle
    const off = _off.copy(camera.position).sub(controls.target);
    controls.target.copy(focus);
    camera.position.copy(focus).add(off);
  } else if (cam.mode === 'track') {
    trackTarget.lerp(focus, 1 - Math.exp(-dtReal * 6));
    controls.target.copy(trackTarget);
    if (cam.fov === 'auto') { camera.fov = autoFov(); camera.updateProjectionMatrix(); }
  }
  lastFocus.copy(focus);
  if (cam.mode === 'onboard') {
    const src = sim.stacked || !followShip ? booster.group : ship.group;
    const p = sim.stacked || !followShip ? new THREE.Vector3(3.6, 64, 3.9) : new THREE.Vector3(-3.4, 16, -3.6);
    camera.position.copy(p.applyMatrix4(src.matrixWorld));
    const look = new THREE.Vector3(0, -1, 0).transformDirection(src.matrixWorld);
    const up = (sim.stacked || !followShip ? new THREE.Vector3(0.7, 0, 0.7) : new THREE.Vector3(-0.7, 0, -0.7)).transformDirection(src.matrixWorld);
    camera.up.copy(up);
    camera.lookAt(camera.position.clone().add(look));
    camera.fov = lensFov; camera.updateProjectionMatrix();
  } else {
    camera.up.set(0, 1, 0);
    controls.update();
  }
  camera.near = Math.max(0.3, Math.min(20, camera.position.distanceTo(focus) * 0.002));
  camera.updateProjectionMatrix();

  // sun shadow frustum around the pad (or the low vehicle)
  sun.target.position.copy(_origin);
  sun.position.copy(_origin).addScaledVector(sunDir, 3000);

  // audio & camera shake (sound arrives at 343 m/s)
  audio.record(sim.t, [
    { pos: fire, power: thrust * (sim.booster.active ? 1 : 0) * 1.8 * Math.exp(-Math.max(0, bh - 3000) / 20000) },
    { pos: pose.shipPos, power: (sLev.reduce((a, b) => a + b, 0) / 6) * 0.9 * Math.exp(-pose.shipPos.y / 15000) },
  ]);
  const loud = audio.update(sim.t, camera.position, scale);
  saveQ.copy(camera.quaternion);
  const shake = Math.min(1, loud) * (cam.mode === 'onboard' ? 0.0 : 0.0035) * (cam.fov === 'auto' || lensFov < 10 ? 0.3 : 1);
  if (shake > 0) {
    const tt = now * 0.001;
    shakeQ.setFromEuler(shakeE.set(Math.sin(tt * 37) * shake * Math.sin(tt * 5.1), Math.sin(tt * 43 + 1) * shake * Math.sin(tt * 3.7), 0));
    camera.quaternion.multiply(shakeQ);
  }
  camera.updateMatrixWorld();

  // particle lighting & sorting
  prof.cbegin('ps.grid'); ps.rebuildGrid(); prof.cend();
  prof.cbegin('ps.lighting'); ps.updateLighting(Q.lighting); prof.cend();
  prof.cbegin('ps.upload'); ps.upload(camera, [boosterPlume.axis, shipPlume.axis]); prof.cend();
  prof.cbegin('smoke.gather'); smoke.gather(ps); prof.cend();
  prof.cbegin('smoke.build'); smoke.build(); prof.cend();

  shared.uTime.value = now * 0.001;
  shared.uCloudTime.value = now * 0.001;
  sky.uniforms.uTime.value = now * 0.001;
  updateShadowCache();
  sky.updateLUT();
  if (envDirty) updateEnvironment();
  prof.cbegin('render.submit');
  render(now * 0.001);
  prof.cend();
  camera.quaternion.copy(saveQ);

  // HUD
  ui.update(sim, timeScale);
  while (eventsShown < sim.events.length) ui.pushEvent(sim.events[eventsShown++]);
  prof.cend();
  prof.endFrame(dtReal * 1000);
  cpuMs = performance.now() - t0;
}

// ------------------------------------------------------------------ boot
function boot() {
  resize();
  setQuality(qualityName);
  ps.uniforms.uAtlas.value = createPuffAtlas(renderer);
  bakeWeather(renderer);
  setSun(sunState.el, sunState.az);
  updatePoses(0);
  setCamera(CAMS[0]);
  ui.setSun(sunState.el, sunState.az);
  requestAnimationFrame(tick);
  ui.ready(async (withSound) => {
    if (withSound) { await audio.start(); ui.setSound(true); }
    started = true;
  });
  if (params.has('autostart')) { started = true; ui.hideIntro(); }
  if (params.has('t')) seek(parseFloat(params.get('t')));
  if (params.has('cam')) { const c = CAMS.find((x) => x.id === params.get('cam')); if (c) setCamera(c); }
  if (params.has('campos')) {
    const c = { id: 'custom', name: 'Custom', mode: 'free', pos: params.get('campos').split(',').map(Number), target: (params.get('camtgt') || '0,60,0').split(',').map(Number), fov: +(params.get('fov') || 40) };
    setCamera(c);
  }
  window.__app = { scene, booster, ship, terrain, clouds, seekingDone: () => seeking === null && started, sim, ps, camera, controls, seek, setCamera, CAMS, renderer, pipeline, setSun, setQuality,
    smoke, sky, sun, pscene, boosterPlume, shipPlume, plasma, DBG, Q: () => Q, governor: gov };
  window.__prof = prof;
}
boot();
void atmosParams;
