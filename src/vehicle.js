import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from './shared.js';

// Super Heavy booster (71 m incl. hot-staging ring) and Starship (50.3 m).
// Each stage's origin is on its axis at the engine exit plane, +Y along the nose.

export const BOOSTER_LEN = 71;
export const SHIP_LEN = 50.3;
const R = 4.5;

// ---------------------------------------------------------------- materials
const STEEL_COMMON = /* glsl */ `
  float ang = atan(vObj.z, vObj.x);
  float yy = vObj.y;
  float ringH = 1.83;
  float ringIdx = floor(yy / ringH);
  float ringF = fract(yy / ringH);
  float sheet = floor(ang / 6.28318 * 3.0 + hash11(ringIdx) * 3.0);
  float panel = hash12(vec2(ringIdx, sheet));
  float fwY = fwidth(yy);
  float weld = 1.0 - smoothstep(0.0, 0.025 + fwY, abs(ringF - 0.5) * ringH - (ringH * 0.5 - 0.03));
  float angU = fract(ang / 6.28318 * 3.0 + hash11(ringIdx) * 3.0);
  float vweld = 1.0 - smoothstep(0.0, 0.02 + fwidth(angU) * 2.0, min(angU, 1.0 - angU) * 9.4);
`;

function steelMaterial({ frost = false, key, sootBase = 0 }) {
  const uniforms = { uFrost: { value: frost ? 1 : 0 }, uFrostTop: { value: 62 }, uHeat: { value: 0 } };
  const m = new THREE.MeshStandardMaterial({ color: 0xb4b4b6, metalness: 1.0, roughness: 0.3, envMapIntensity: 1.0 });
  patchMaterial(
    m,
    {
      key,
      fragHead: `uniform float uFrost, uFrostTop, uHeat; float frostM; float weldM; float panelV;`,
      fragMap: /* glsl */ `
        {
          ${STEEL_COMMON}
          panelV = panel;
          weldM = max(weld, vweld * 0.7);
          diffuseColor.rgb *= 0.9 + 0.16 * panel;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.45, 0.42, 0.38), weldM * 0.6);
          // soot and heat discolouration toward the engines
          float soot = smoothstep(${(sootBase + 7).toFixed(1)}, ${sootBase.toFixed(1)}, yy) * (0.6 + 0.4 * fbm3(vObj * vec3(0.8, 0.3, 0.8), 3));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13, 0.1, 0.08), soot * 0.8);
          // frost / ice from cryogenic propellant, in vertical runs
          float fn = fbm3(vec3(ang * 5.0, yy * 0.18, 0.0), 5);
          float runs = fbm3(vec3(ang * 22.0, yy * 0.04, 1.0), 3);
          frostM = uFrost * smoothstep(0.18, 0.42, fn * 0.7 + runs * 0.5) * smoothstep(uFrostTop + 2.0, uFrostTop - 3.0, yy) * smoothstep(2.0, 7.0, yy);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.84, 0.86) * (0.85 + 0.2 * fn), frostM);
        }`,
      fragRough: `roughnessFactor = mix(0.42 + 0.2 * panelV + weldM * 0.2, 0.8, frostM);`,
      fragMetal: `metalnessFactor = mix(1.0, 0.0, frostM);`,
      fragNormal: /* glsl */ `
        {
          // subtle waviness of the rolled sheets ("quilting")
          float w = vnoise2(vec2(atan(vObj.z, vObj.x) * 14.0, vObj.y * 0.9)) - 0.5;
          vec3 nObj = normalize(vObjN + vec3(0.0, w * 0.05, 0.0));
          normal = normalize(normal + (viewMatrix * vec4(nObj - vObjN, 0.0)).xyz * 1.5);
        }`,
    },
    uniforms
  );
  m.userData.uniforms = uniforms;
  return m;
}

function tileMaterial({ key, windward = new THREE.Vector2(0, 1), coverage = 1.62, noseStart = 36.5 }) {
  const uniforms = { uHeat: { value: 0 } };
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1.0, roughness: 0.3 });
  patchMaterial(
    m,
    {
      key,
      fragHead: /* glsl */ `
        uniform float uHeat;
        float tileM; float tileEdge; float tileV;
        vec4 hexCell(vec2 uv) {
          const vec2 rr = vec2(1.0, 1.7320508);
          vec2 h = rr * 0.5;
          vec2 a = mod(uv, rr) - h;
          vec2 b = mod(uv - h, rr) - h;
          vec2 gv = dot(a, a) < dot(b, b) ? a : b;
          vec2 ap = abs(gv);
          float d = max(dot(ap, normalize(rr)), ap.x);
          return vec4(uv - gv, d, 0.0);
        }`,
      fragMap: /* glsl */ `
        {
          ${STEEL_COMMON}
          float rad = max(length(vObj.xz), 0.05);
          vec2 uv = vec2(ang * rad, yy) / 0.3;
          vec4 hc = hexCell(uv);
          vec2 cellCenter = hc.xy * 0.3;
          float cAng = cellCenter.x / rad;
          vec2 dirC = vec2(cos(cAng), sin(cAng));
          float cosW = dot(dirC, vec2(${windward.x.toFixed(3)}, ${windward.y.toFixed(3)}));
          float noseF = smoothstep(${noseStart.toFixed(1)} + 6.0, ${(noseStart + 13.5).toFixed(1)}, cellCenter.y);
          float cover = mix(${coverage.toFixed(2)}, 2.1, noseF);
          float jag = hash12(hc.xy) * 0.06;
          tileM = step(acos(clamp(cosW, -1.0, 1.0)) + jag, cover);
          float fw = fwidth(uv.x) + fwidth(uv.y);
          tileEdge = smoothstep(0.43 - fw, 0.5, hc.z) * (1.0 - smoothstep(0.3, 1.2, fw));
          tileV = hash12(hc.xy + 7.0);
          vec3 tileC = vec3(0.028 + 0.02 * tileV);
          tileC = mix(tileC, vec3(0.16, 0.155, 0.15), step(0.996, tileV));
          tileC = mix(tileC, vec3(0.012), tileEdge * 0.7);
          vec3 steelC = diffuseColor.rgb * (0.9 + 0.16 * panel);
          steelC = mix(steelC, vec3(0.45, 0.42, 0.38), max(weld, vweld * 0.7) * 0.6);
          diffuseColor.rgb = mix(steelC, tileC, tileM);
          // heating glow on the windward side during reentry (unused on ascent)
        }`,
      fragRough: `roughnessFactor = mix(0.28, 0.62 + 0.18 * tileV, tileM);`,
      fragMetal: `metalnessFactor = mix(1.0, 0.0, tileM);`,
      fragNormal: /* glsl */ `
        normal = normalize(normal + (viewMatrix * vec4(vec3(0.0, 1.0, 0.0), 0.0)).xyz * tileEdge * tileM * 0.15);`,
    },
    uniforms
  );
  m.color.setRGB(0.78, 0.78, 0.8);
  m.userData.uniforms = uniforms;
  return m;
}

function engineMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x3a3634, metalness: 0.85, roughness: 0.45, side: THREE.DoubleSide });
  patchMaterial(m, {
    key: 'engine',
    vertexHead: 'attribute float aGlow; varying float vGlow;',
    vertexBegin: 'vGlow = aGlow;',
    fragHead: 'varying float vGlow;',
    fragMap: /* glsl */ `
      // heat tint: bronze/blue banding near the nozzle exit
      float band = smoothstep(0.0, 1.5, vObj.y);
      diffuseColor.rgb = mix(vec3(0.24, 0.2, 0.2), vec3(0.3, 0.26, 0.2), band) * (0.8 + 0.3 * fbm3(vObj * 4.0, 2));`,
    fragEmissive: /* glsl */ `
      // inner bell glows while firing (back faces = inside of the bell)
      float inside = gl_FrontFacing ? 0.0 : 1.0;
      float throat = smoothstep(0.0, 1.6, vObj.y);
      totalEmissiveRadiance += vec3(1.0, 0.62, 0.35) * vGlow * inside * (30.0 + 250.0 * throat);
      totalEmissiveRadiance += vec3(1.0, 0.35, 0.15) * vGlow * (1.0 - inside) * smoothstep(0.4, 0.0, vObj.y) * 1.5;`,
  });
  return m;
}

// ---------------------------------------------------------------- geometry
function raptorGeometry(exitR, bellLen, throatR = 0.2) {
  const pts = [];
  const n = 18;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // bell contour (parabolic approximation of a Rao nozzle)
    const r = throatR + (exitR - throatR) * Math.pow(1 - t, 0.62);
    pts.push(new THREE.Vector2(r, t * bellLen));
  }
  const bell = new THREE.LatheGeometry(pts, 36);
  const ph = new THREE.CylinderGeometry(0.55, 0.45, 1.3, 20);
  ph.translate(0, bellLen + 0.65, 0);
  const turbo = new THREE.CylinderGeometry(0.3, 0.3, 0.9, 12);
  turbo.translate(0.45, bellLen + 0.9, 0);
  return mergeGeometries([bell, ph, turbo].map((x) => x.toNonIndexed()));
}

function gridFinGeometry() {
  const parts = [];
  const span = 3.2, width = 4.2, depth = 0.9, bar = 0.09;
  const frame = (x, z, sx, sz) => { const b = new THREE.BoxGeometry(sx, depth, sz); b.translate(x, 0, z); parts.push(b); };
  frame(span / 2, -width / 2, span, 0.22);
  frame(span / 2, width / 2, span, 0.22);
  frame(span, 0, 0.22, width);
  frame(0.1, 0, 0.3, width + 0.3);
  // diagonal lattice
  const nb = 9;
  for (let i = -nb; i <= nb; i++) {
    for (const s of [-1, 1]) {
      const c = (i / nb) * (span + width) * 0.5;
      // line x - s*z = c clipped to the rectangle [0,span] x [-w/2,w/2]
      const pts = [];
      for (const z of [-width / 2, width / 2]) { const x = c + span / 2 + s * z; if (x >= 0 && x <= span) pts.push([x, z]); }
      for (const x of [0, span]) { const z = s * (x - span / 2 - c); if (z >= -width / 2 && z <= width / 2) pts.push([x, z]); }
      if (pts.length < 2) continue;
      const [a, b] = pts;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.2) continue;
      const g = new THREE.BoxGeometry(bar, depth * 0.95, len);
      g.rotateY(Math.atan2(b[0] - a[0], b[1] - a[1]));
      g.translate((a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2);
      parts.push(g);
    }
  }
  return mergeGeometries(parts.map((p) => p.toNonIndexed()));
}

function flapGeometry(root, tip, span, thick, sweep) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(0, root);
  s.lineTo(span, root - sweep);
  s.lineTo(span, root - sweep - tip);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 2 });
  g.translate(0, 0, -thick / 2);
  return g;
}

function ogivePoints(yBase, L, Rr, tipR = 0.7) {
  const rho = (Rr * Rr + L * L) / (2 * Rr);
  const pts = [];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const x = L * (1 - i / n); // distance from tip
    let r = Math.sqrt(Math.max(0, rho * rho - (L - x) * (L - x))) + Rr - rho;
    pts.push(new THREE.Vector2(Math.max(r, 0), yBase + L - x));
  }
  // blunt the tip with a small spherical cap
  const out = pts.filter((p) => p.x > tipR * 0.9);
  const last = out[out.length - 1];
  for (let i = 1; i <= 6; i++) {
    const a = (i / 6) * Math.PI / 2;
    out.push(new THREE.Vector2(last.x * Math.cos(a), last.y + Math.sin(a) * tipR * 0.6));
  }
  out.push(new THREE.Vector2(0, out[out.length - 1].y));
  return out;
}

export function engineLayoutBooster() {
  const list = [];
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 + Math.PI / 2; list.push([0.78 * Math.cos(a), 0.78 * Math.sin(a), 0]); }
  for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2 + 0.31; list.push([2.3 * Math.cos(a), 2.3 * Math.sin(a), 1]); }
  for (let k = 0; k < 20; k++) { const a = (k / 20) * Math.PI * 2; list.push([3.78 * Math.cos(a), 3.78 * Math.sin(a), 2]); }
  return list;
}

function engineCluster(layout, geoFor, mat) {
  const geos = {};
  const meshes = [];
  const byType = {};
  layout.forEach((e, i) => { const t = e[3] || 'sl'; (byType[t] ||= []).push([e, i]); });
  for (const [type, list] of Object.entries(byType)) {
    const geo = (geos[type] ||= geoFor(type));
    const glow = new Float32Array(list.length);
    const g = geo.clone();
    g.setAttribute('aGlow', new THREE.InstancedBufferAttribute(glow, 1));
    const mesh = new THREE.InstancedMesh(g, mat, list.length);
    list.forEach(([e], k) => {
      mesh.setMatrixAt(k, new THREE.Matrix4().makeTranslation(e[0], e[4] ?? 0, e[1]));
    });
    mesh.castShadow = true;
    mesh.userData.indices = list.map(([, i]) => i);
    mesh.userData.glow = g.getAttribute('aGlow');
    meshes.push(mesh);
  }
  return meshes;
}

// ---------------------------------------------------------------- booster
export function createBooster() {
  const g = new THREE.Group();
  g.name = 'booster';
  const steel = steelMaterial({ frost: true, key: 'bstSteel', sootBase: 0.5 });
  steel.userData.uniforms.uFrostTop.value = 64;
  const dark = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x2c2a28, metalness: 0.8, roughness: 0.5 }), { key: 'bdark' });
  const finMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x6d6b68, metalness: 0.9, roughness: 0.4 }), { key: 'fin' });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 68.6, 128, 60, true), steel);
  body.position.y = 0.6 + 68.6 / 2;
  // keep object-space y measured from the booster base for the procedural pattern
  body.geometry.translate(0, 68.6 / 2 + 0.6, 0);
  body.position.y = 0;
  g.add(body);

  // aft heat shield and engine bay floor
  const floor = new THREE.Mesh(new THREE.CircleGeometry(R, 64), dark);
  floor.rotation.x = Math.PI / 2;
  floor.position.y = 1.7;
  g.add(floor);

  // hot staging ring: vented cylinder
  const ringMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x3b3835, metalness: 0.8, roughness: 0.45, side: THREE.DoubleSide }), {
    key: 'hsr',
    fragHead: 'uniform float uVentGlow;',
    fragMap: /* glsl */ `
      float a = atan(vObj.z, vObj.x) / 6.28318 * 48.0;
      float slot = step(0.28, fract(a)) * step(fract(a), 0.9) * step(69.55, vObj.y) * step(vObj.y, 70.75);
      diffuseColor.rgb = mix(diffuseColor.rgb * (0.7 + 0.5 * fbm3(vObj * 2.0, 2)), vec3(0.01), slot);`,
    fragEmissive: /* glsl */ `
      float a2 = atan(vObj.z, vObj.x) / 6.28318 * 48.0;
      float slot2 = step(0.28, fract(a2)) * step(fract(a2), 0.9) * step(69.55, vObj.y) * step(vObj.y, 70.75);
      totalEmissiveRadiance += vec3(1.0, 0.55, 0.25) * slot2 * uVentGlow * 400.0;`,
  }, { uVentGlow: { value: 0 } });
  const ringGeo = new THREE.CylinderGeometry(R, R, 1.8, 96, 3, true);
  ringGeo.translate(0, 69.2 + 0.9, 0);
  const ring = new THREE.Mesh(ringGeo, ringMat);
  g.add(ring);
  const topDome = new THREE.Mesh(new THREE.SphereGeometry(R * 0.98, 48, 12, 0, Math.PI * 2, 0, Math.PI / 2), dark);
  topDome.scale.y = 0.25;
  topDome.position.y = 69.2;
  g.add(topDome);

  // grid fins: two pairs
  const finGeo = gridFinGeometry();
  for (const deg of [55, 125, 235, 305]) {
    const f = new THREE.Mesh(finGeo, finMat);
    const a = (deg * Math.PI) / 180;
    f.position.set(Math.cos(a) * R, 66.8, Math.sin(a) * R);
    f.rotation.y = -a;
    f.castShadow = true;
    g.add(f);
  }
  // chines along the LOX tank + raceway
  const chineGeo = new THREE.BoxGeometry(0.9, 30, 0.6);
  for (const deg of [0, 90, 180, 270]) {
    const a = ((deg + 15) * Math.PI) / 180;
    const c = new THREE.Mesh(chineGeo, steel);
    c.position.set(Math.cos(a) * (R + 0.2), 22, Math.sin(a) * (R + 0.2));
    c.rotation.y = -a;
    g.add(c);
  }
  const race = new THREE.Mesh(new THREE.BoxGeometry(0.6, 60, 0.5), steel);
  race.position.set(0, 36, -(R + 0.15));
  g.add(race);

  // engines
  const layout = engineLayoutBooster().map(([x, z]) => [x, z, 0, 'sl', 0]);
  const engMat = engineMaterial();
  const engines = engineCluster(layout, () => raptorGeometry(0.65, 1.7), engMat);
  engines.forEach((m) => g.add(m));

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // condensation / sublimating-frost sheath streaming down the cryogenic tanks
  const vaporMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, color: 0xffffff });
  const vaporU = { uVapor: { value: 0 }, uFlow: { value: 0 } };
  patchMaterial(vaporMat, {
    key: 'vapor',
    vertexHead: 'varying vec3 vWN;',
    vertexEnd: 'vWN = normalize(mat3(modelMatrix) * normal);',
    fragHead: 'uniform float uVapor, uFlow; uniform vec3 uSunColor, uSkyAmb; varying vec3 vWN;',
    fragMap: /* glsl */ `
      {
        float a = atan(vObj.z, vObj.x);
        float y = vObj.y;
        float flow = y * 0.09 + uFlow;
        float n = fbm3(vec3(cos(a) * 3.0, sin(a) * 3.0, flow), 5);
        float streak = fbm3(vec3(cos(a) * 9.0, sin(a) * 9.0, y * 0.02 + uFlow * 0.25), 3);
        float m = smoothstep(0.36, 0.66, n * 0.75 + streak * 0.45) * uVapor * 1.5;
        m *= smoothstep(4.0, 12.0, y) * smoothstep(69.0, 60.0, y);
        vec3 V = normalize(cameraPosition - vWorld);
        float rim = 1.0 - abs(dot(normalize(vWN), V));
        m *= 0.55 + 0.45 * rim;
        float wrap = clamp(dot(normalize(vWN), uSunDir) * 0.5 + 0.6, 0.0, 1.0);
        diffuseColor.rgb = vec3(0.92) * (uSunColor * wrap * 0.3 + uSkyAmb * 1.2);
        diffuseColor.a = clamp(m, 0.0, 0.85);
      }`,
  }, vaporU);
  const vaporGeo = new THREE.CylinderGeometry(R + 0.35, R + 0.35, 66, 48, 12, true);
  vaporGeo.translate(0, 36, 0);
  const vapor = new THREE.Mesh(vaporGeo, vaporMat);
  vapor.renderOrder = 5;
  vapor.castShadow = false;
  g.add(vapor);

  // transonic condensation collars (Prandtl–Glauert vapour cones) behind the
  // hot-staging ring and the ship's flaps, driven by the Mach number
  const collarU = { uCollar: { value: 0 }, uFlow: vaporU.uFlow };
  const collarMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  patchMaterial(collarMat, {
    key: 'collar',
    vertexHead: 'varying vec3 vWN;',
    vertexEnd: 'vWN = normalize(mat3(modelMatrix) * normal);',
    fragHead: 'uniform float uCollar, uFlow; uniform vec3 uSunColor, uSkyAmb; varying vec3 vWN;',
    fragMap: /* glsl */ `
      {
        float a = atan(vObj.z, vObj.x);
        float v = uv.y;
        float n = fbm3(vec3(cos(a) * 4.0, sin(a) * 4.0, vObj.y * 0.35 + uFlow * 0.5), 4);
        float m = smoothstep(0.35, 0.7, n) * smoothstep(0.0, 0.25, v) * smoothstep(1.0, 0.45, v) * uCollar;
        vec3 V = normalize(cameraPosition - vWorld);
        m *= 0.35 + 0.65 * (1.0 - abs(dot(normalize(vWN), V)));
        float wrap = clamp(dot(normalize(vWN), uSunDir) * 0.5 + 0.6, 0.0, 1.0);
        diffuseColor.rgb = vec3(0.95) * (uSunColor * wrap * 0.3 + uSkyAmb * 1.3);
        diffuseColor.a = clamp(m, 0.0, 0.8);
      }`,
  }, collarU);
  // uv is needed in the fragment shader
  collarMat.onBeforeCompile = ((orig) => (sh) => {
    orig(sh);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vCUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvCUv = uv;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vCUv;').replace('float v = uv.y;', 'float v = vCUv.y;');
  })(collarMat.onBeforeCompile);
  for (const [y0, len, r0, r1] of [[70.5, 16, 4.9, 9.5], [110.5, 12, 4.6, 8.5]]) {
    const cg = new THREE.CylinderGeometry(r0, r1, len, 48, 4, true);
    cg.translate(0, y0 - len / 2, 0);
    const c = new THREE.Mesh(cg, collarMat);
    c.renderOrder = 6;
    g.add(c);
  }

  return {
    group: g,
    vapor: vaporU,
    collar: collarU,
    materials: { steel, ringMat },
    engines,
    layout,
    setGlow(levels) {
      for (const m of engines) {
        const a = m.userData.glow;
        m.userData.indices.forEach((idx, k) => { a.array[k] = levels[idx]; });
        a.needsUpdate = true;
      }
    },
  };
}

// ---------------------------------------------------------------- ship
export function createShip() {
  const g = new THREE.Group();
  g.name = 'ship';
  // windward (tiled) side faces local +Z
  const tiles = tileMaterial({ key: 'shipTiles', windward: new THREE.Vector2(0, 1), coverage: 1.62, noseStart: 36.5 });
  const flapTiles = tileMaterial({ key: 'flapTiles', windward: new THREE.Vector2(0, 1), coverage: 3.2, noseStart: 100 });
  const dark = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x1d1c1b, metalness: 0.6, roughness: 0.5 }), { key: 'sdark' });

  const barrelGeo = new THREE.CylinderGeometry(R, R, 36.5, 128, 40, true);
  barrelGeo.translate(0, 36.5 / 2, 0);
  const noseGeo = new THREE.LatheGeometry(ogivePoints(36.5, 13.8, R), 128);
  const body = new THREE.Mesh(mergeGeometries([barrelGeo.toNonIndexed(), noseGeo.toNonIndexed()]), tiles);
  g.add(body);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(R, 64), dark);
  floor.rotation.x = Math.PI / 2;
  floor.position.y = 0.9;
  g.add(floor);

  // aft flaps on the sides, forward flaps shifted to the leeward side
  const aft = flapGeometry(11.5, 5.5, 4.0, 0.55, 3.5);
  const fwd = flapGeometry(8.5, 3.2, 3.1, 0.45, 3.2);
  for (const side of [-1, 1]) {
    const fa = new THREE.Mesh(aft, flapTiles);
    fa.position.set(side * (R - 0.2), 0.8, 0.4);
    fa.rotation.y = side > 0 ? 0 : Math.PI;
    g.add(fa);
    const ff = new THREE.Mesh(fwd, flapTiles);
    const a = side > 0 ? -0.35 : Math.PI + 0.35; // toward leeward (-Z)
    const rr = 3.6;
    ff.position.set(Math.cos(a) * rr, 38.8, Math.sin(a) * rr);
    ff.rotation.y = -a;
    ff.rotation.z = 0.25; // lean in with the nose taper
    g.add(ff);
  }
  // leeward raceway
  const race = new THREE.Mesh(new THREE.BoxGeometry(0.5, 34, 0.4), tiles);
  race.position.set(0, 18, -(R + 0.12));
  g.add(race);

  // engines: 3 sea-level (centre) + 3 vacuum (outer, big bells)
  const layout = [];
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 + Math.PI / 2; layout.push([1.05 * Math.cos(a), 1.05 * Math.sin(a), 0, 'sl', -1.0]); }
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 - Math.PI / 2; layout.push([3.0 * Math.cos(a), 3.0 * Math.sin(a), 1, 'vac', -1.6]); }
  const engMat = engineMaterial();
  const engines = engineCluster(layout, (t) => (t === 'vac' ? raptorGeometry(1.15, 2.5, 0.22) : raptorGeometry(0.65, 1.7)), engMat);
  engines.forEach((m) => g.add(m));

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return {
    group: g,
    materials: { tiles },
    engines,
    layout,
    setGlow(levels) {
      for (const m of engines) {
        const a = m.userData.glow;
        m.userData.indices.forEach((idx, k) => { a.array[k] = levels[idx]; });
        a.needsUpdate = true;
      }
    },
  };
}
