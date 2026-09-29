import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FlightSim, LAUNCH_AZIMUTH } from './physics.js';
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
import { createClouds } from './clouds.js';
import { SmokeVolume, insideVolume } from './smoke.js';
import { sunTransmittanceJS } from './sky.js';

// ------------------------------------------------------------------ setup
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance', stencil: false });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
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
let qualityName = params.get('q') || (/(iPhone|iPad|Android)/i.test(navigator.userAgent) ? 'low' : 'high');
let Q = QUALITY[qualityName] || QUALITY.high;

// sky & light
const sky = createSky();
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
const sunState = { el: 11, az: 102 };
const sunDir = new THREE.Vector3();
let lighting = null;
function setSun(el, az) {
  sunState.el = el; sunState.az = az;
  const e = THREE.MathUtils.degToRad(el), a = THREE.MathUtils.degToRad(az);
  sunDir.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
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
  const il = (ill.x + ill.y + ill.z) / 3;
  const wb = new THREE.Vector3(il / ill.x, il / ill.y, il / ill.z);
  wb.set(Math.pow(wb.x, 0.55), Math.pow(wb.y, 0.55), Math.pow(wb.z, 0.55));
  const wl = 0.2126 * wb.x + 0.7152 * wb.y + 0.0722 * wb.z;
  pipeline.params.wb = wb.multiplyScalar(1 / wl);
  baseExposure = 1.15 / Math.max(0.02, lum(lighting.sky) * 1.4 + lum(lighting.sun) * Math.max(0.05, sunDir.y) * 0.25);
}
let baseExposure = 1, userEV = 0;

// environment map (sky + terrain + pad) for metal reflections & ambient
const pmrem = new THREE.PMREMGenerator(renderer);
const cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
const cubeCam = new THREE.CubeCamera(1, FAR, cubeRT);
let envDirty = true, envRT = null;
function updateEnvironment() {
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
const pose = {
  boosterPos: new THREE.Vector3(), boosterQuat: new THREE.Quaternion(), boosterVel: new THREE.Vector3(),
  shipPos: new THREE.Vector3(), shipQuat: new THREE.Quaternion(), shipVel: new THREE.Vector3(),
};
const prevB = new THREE.Vector3(), prevS = new THREE.Vector3();
let splashT = null;
function stagePose(tel, offsetY, outPos, outQuat, yaw) {
  outPos.copy(dirH).multiplyScalar(tel.s);
  outPos.y = tel.y + offsetY;
  outQuat.setFromAxisAngle(tiltAxis, tel.tilt).multiply(yaw);
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
    stagePose(S.telemetry, off, pose.shipPos, pose.shipQuat, yawShip);
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
  booster.group.position.copy(pose.boosterPos);
  booster.group.quaternion.copy(pose.boosterQuat);
  ship.group.position.copy(pose.shipPos);
  ship.group.quaternion.copy(pose.shipQuat);
  booster.group.visible = !(splashT !== null && sim.t - splashT > 30);
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
  const chunk = seeking !== null ? 1 / 12 : 1 / 30;
  let left = simDt;
  while (left > 1e-6) {
    const d = Math.min(chunk, left);
    simAcc += d;
    while (simAcc >= STEP) { sim.step(STEP); simAcc -= STEP; }
    updatePoses(d);
    effects.update(d, {
      sim, quality: Q.emit, stacked: sim.stacked,
      boosterPos: pose.boosterPos, boosterQuat: pose.boosterQuat, boosterVel: pose.boosterVel,
      shipPos: pose.shipPos, shipQuat: pose.shipQuat, shipVel: pose.shipVel,
      boosterPlume, shipPlume, shipThrust: sim.ship.engines.reduce((a, e) => a + e.level, 0) / 6,
    });
    ps.update(d);
    left -= d;
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
  clouds.uniforms.uSteps.value = Q.clouds;
  smoke.uniforms.uSteps.value = Q.smokeSteps;
  if (sun.shadow.map && sun.shadow.mapSize.x !== Q.shadow) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  sun.shadow.mapSize.set(Q.shadow, Q.shadow);
  resize();
  ui.setQuality(name);
}

// ------------------------------------------------------------------ resize
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(1);
  renderer.setSize(Math.floor(w * Q.scale), Math.floor(h * Q.scale), false);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pipeline.setSize(Math.floor(w * Q.scale), Math.floor(h * Q.scale));
  shared.uResolution.value.set(pipeline.w, pipeline.h);
  clouds.setSize(pipeline.w * Q.cloudScale, pipeline.h * Q.cloudScale);
  smoke.setSize(pipeline.w * Q.smokeScale, pipeline.h * Q.smokeScale);
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------------ render
const mirror = new THREE.PerspectiveCamera();
const reflMatrix = new THREE.Matrix4();
const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
const _d = new THREE.Vector3(), _u = new THREE.Vector3();
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
  const ss = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(pipeline.refl);
  renderer.render(scene, mirror);
  clouds.renderReflection(renderer, mirror);
  smoke.compBack.visible = smoke.compFront.visible = false;
  smoke.renderReflection(mirror);
  ps.setReflectionMode(true); boosterPlume.setReflectionMode(true); shipPlume.setReflectionMode(true);
  clouds.mesh.visible = false;
  renderer.autoClear = false;
  renderer.render(pscene, mirror);
  renderer.autoClear = true;
  ps.setReflectionMode(false); boosterPlume.setReflectionMode(false); shipPlume.setReflectionMode(false);
  clouds.mesh.visible = true;
  smoke.compBack.visible = smoke.compFront.visible = true;
  renderer.shadowMap.autoUpdate = ss;
  terrain.visible = true;
  shared.uReflection.value = pipeline.refl.texture;
}

let frameCount = 0;
function render(time) {
  // reflection first (sampled by the water in the main pass)
  renderReflection();
  sky.mesh.position.copy(camera.position);
  sky.uniforms.uCamAlt.value = Math.max(1, camera.position.y);
  renderer.setRenderTarget(pipeline.main);
  renderer.render(scene, camera);

  // particles & plumes, manual depth test against the main depth buffer
  const res = new THREE.Vector2(pipeline.part.width, pipeline.part.height);
  ps.uniforms.uDepth.value = pipeline.main.depthTexture;
  ps.uniforms.uPartRes.value.copy(res);
  ps.uniforms.uLogFar.value = Math.log2(FAR + 1);
  boosterPlume.setDepth(pipeline.main.depthTexture, res, Math.log2(FAR + 1));
  clouds.render(renderer, camera, pipeline.main.depthTexture);
  smoke.render(camera, pipeline.main.depthTexture, boosterPlume.axis, ps.time);
  shipPlume.setDepth(pipeline.main.depthTexture, res, Math.log2(FAR + 1));
  renderer.setRenderTarget(pipeline.part);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.autoClear = false;
  renderer.render(pscene, camera);
  renderer.autoClear = true;

  pipeline.params.exposure = baseExposure * Math.pow(2, userEV);
  pipeline.finish(time);
  frameCount++;
}

// ------------------------------------------------------------------ loop
let last = performance.now();
let fpsAcc = 0, fpsN = 0, eventsShown = 0;
const shakeQ = new THREE.Quaternion(), saveQ = new THREE.Quaternion();
let started = false;
function tick(now) {
  requestAnimationFrame(tick);
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsAcc += dtReal; fpsN++;
  if (fpsAcc > 0.5) { ui.setFps(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }

  let scale = paused || !started ? 0 : timeScale;
  if (seeking !== null) {
    scale = Math.min(60, Math.max(4, (seeking - sim.t) * 2));
    if (sim.t >= seeking) { seeking = null; if (params.has('pause')) { paused = true; ui.setPaused(true); } }
  }
  const simDt = dtReal * scale;
  advance(simDt);

  // lighting follows the vehicle altitude when the camera is up there
  const alt = Math.max(30, Math.min(camera.position.y, 150000));
  if (Math.abs(alt - lastLightAlt) > Math.max(200, lastLightAlt * 0.15)) refreshLighting(alt);

  // engines, plumes, flame light
  const bLev = sim.booster.engines.map((e) => (sim.booster.active ? e.level : 0));
  const sLev = sim.ship.engines.map((e) => e.level);
  booster.setGlow(bLev);
  ship.setGlow(sLev);
  booster.group.updateMatrixWorld(true);
  ship.group.updateMatrixWorld(true);
  boosterPlume.update(booster.group.matrixWorld, bLev, sim.booster.telemetry.pa, camera, Q.emit);
  shipPlume.update(ship.group.matrixWorld, sLev, sim.ship.telemetry.pa, camera, Q.emit);
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
  const nozzle = new THREE.Vector3(0, -2, 0).applyQuaternion(pose.boosterQuat).add(pose.boosterPos);
  const fire = new THREE.Vector3(nozzle.x, Math.max(4, Math.min(nozzle.y - 25, nozzle.y * 0.5)), nozzle.z);
  const flicker = 0.85 + 0.15 * Math.sin(now * 0.05) * Math.sin(now * 0.031);
  const fI = thrust * flicker * (bh < 3000 ? 1 : 0.3);
  flameLight.position.copy(fire);
  flameLight.intensity = 9.0e4 * fI;
  flameLight.color.setRGB(1, 0.58, 0.3);
  shared.uFlamePos.value.copy(fire);
  shared.uFlameColor.value.set(1, 0.55, 0.26).multiplyScalar(3.2e4 * fI);
  ps.flamePos.copy(fire);
  ps.flameOn = fI;

  // camera
  const focus = focusPoint();
  if (cam.mode === 'chase') {
    const d = focus.clone().sub(lastFocus);
    camera.position.add(d);
    controls.target.add(d);
  } else if (cam.mode === 'track') {
    trackTarget.lerp(focus, 1 - Math.exp(-dtReal * 6));
    controls.target.copy(trackTarget);
    if (cam.fov === 'auto') { camera.fov = autoFov(); camera.updateProjectionMatrix(); }
  }
  lastFocus.copy(focus);
  if (cam.mode === 'onboard') {
    const src = sim.stacked || !followShip ? booster.group : ship.group;
    const p = sim.stacked || !followShip ? new THREE.Vector3(3.6, 64, 3.9) : new THREE.Vector3(3.6, 30, 3.6);
    camera.position.copy(p.applyMatrix4(src.matrixWorld));
    const look = new THREE.Vector3(0, -1, 0).transformDirection(src.matrixWorld);
    const up = new THREE.Vector3(0.7, 0, 0.7).transformDirection(src.matrixWorld);
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
  const sTarget = bh < 1500 ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(0, 0, 0);
  sun.target.position.copy(sTarget);
  sun.position.copy(sTarget).addScaledVector(sunDir, 3000);

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
    shakeQ.setFromEuler(new THREE.Euler(Math.sin(tt * 37) * shake * Math.sin(tt * 5.1), Math.sin(tt * 43 + 1) * shake * Math.sin(tt * 3.7), 0));
    camera.quaternion.multiply(shakeQ);
  }
  camera.updateMatrixWorld();

  // particle lighting & sorting
  ps.rebuildGrid();
  ps.updateLighting(Q.lighting);
  ps.upload(camera, [boosterPlume.axis, shipPlume.axis]);
  smoke.gather(ps);
  smoke.build();

  shared.uTime.value = now * 0.001;
  shared.uCloudTime.value = now * 0.001;
  sky.uniforms.uTime.value = now * 0.001;
  if (envDirty) updateEnvironment();
  render(now * 0.001);
  camera.quaternion.copy(saveQ);

  // HUD
  ui.update(sim, timeScale);
  while (eventsShown < sim.events.length) ui.pushEvent(sim.events[eventsShown++]);
}

// ------------------------------------------------------------------ boot
function boot() {
  resize();
  setQuality(qualityName);
  ps.uniforms.uAtlas.value = createPuffAtlas(renderer);
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
  window.__app = { scene, booster, ship, terrain, clouds, seekingDone: () => seeking === null && started, sim, ps, camera, controls, seek, setCamera, CAMS, renderer, pipeline, setSun, setQuality };
}
boot();
void atmosParams;
