import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from './shared.js';
import { VCOMMON, TILE_GLSL } from './vehicleGLSL.js';

// Super Heavy booster (71 m incl. hot-staging ring) and Starship (50.3 m),
// Block 1 / Flights 3-6 configuration. Fully procedural: silhouettes are real
// geometry, surface detail (welds, tiles, frost, soot) is generated in shaders.
// Each stage's origin is on its axis at the engine exit plane, +Y along the nose.
// Ship windward (tiled) side faces local +Z; the booster shares the same frame.

export const BOOSTER_LEN = 71;
export const SHIP_LEN = 50.3;
const R = 4.5;
const TAU = Math.PI * 2;
// Super Heavy V3 stations (booster frame)
const SKIRT_Y0 = 1.5; // bottom edge of the aft skirt (engines hang below, exposed)
const FLOOR_Y = 2.8; // thrust-section heat shield
const TRUSS_Y0 = 68.6; // forward dome equator / base of the integrated hot-staging truss
const BARREL_TOP = TRUSS_Y0;
const FIN_Y = 62.3; // grid fins (V3: lower, 50% larger)
// [azimuth (atan2(z,x)), isCatchFin]: catch fins at +-X, rudder fin windward (+Z); no fin leeward
const FIN_LAYOUT = [[0, true], [Math.PI, true], [Math.PI / 2, false]];

// ---------------------------------------------------------------- geometry helpers
const _m = new THREE.Matrix4();
// strip to position+normal, non-indexed, optionally transformed -> mergeable
function prep(g, matrix) {
  let x = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(x.attributes)) if (k !== 'position' && k !== 'normal') x.deleteAttribute(k);
  if (!x.attributes.normal) x.computeVertexNormals();
  if (matrix) x.applyMatrix4(matrix);
  return x;
}
const merge = (list) => mergeGeometries(list.map((g) => prep(g)));
// matrix placing a part whose local +X points radially outward at azimuth a (atan2(z, x))
const radialMatrix = (a, r, y) => new THREE.Matrix4().makeRotationY(-a).setPosition(Math.cos(a) * r, y, Math.sin(a) * r);

function roundedBox(w, h, d, rad = 0.06) {
  const s = new THREE.Shape();
  const x0 = -w / 2 + rad, x1 = w / 2 - rad, y0 = -h / 2 + rad, y1 = h / 2 - rad;
  s.moveTo(x0, -h / 2); s.lineTo(x1, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, y0);
  s.lineTo(w / 2, y1); s.quadraticCurveTo(w / 2, h / 2, x1, h / 2); s.lineTo(x0, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, y1); s.lineTo(-w / 2, y0); s.quadraticCurveTo(-w / 2, -h / 2, x0, -h / 2);
  const b = Math.min(0.04, d * 0.25);
  const g = new THREE.ExtrudeGeometry(s, { depth: d - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 3 });
  g.translate(0, 0, -(d - 2 * b) / 2);
  return g; // w along x, h along y, d along z
}

/**
 * Loft a cross-section along the stage axis (chines, raceways, conduits).
 * profile: [t, h] points from one side of the base to the other (t tangential, h radial)
 * ys: heights; sc(y) -> [widthScale, heightScale]; rad(y) -> body radius
 */
function loft(a, profile, ys, sc, rad = () => R) {
  const pos = [];
  const pt = (k, y) => {
    const [ws, hs] = sc(y);
    const [t, h] = profile[k];
    const rr = rad(y) + h * hs;
    const tt = t * ws;
    return new THREE.Vector3(Math.cos(a) * rr - Math.sin(a) * tt, y, Math.sin(a) * rr + Math.cos(a) * tt);
  };
  const tri = (p0, p1, p2, y) => {
    const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0));
    const c = p0.clone().add(p1).add(p2).divideScalar(3);
    const ref = new THREE.Vector3(Math.cos(a) * (rad(y) - 0.4), c.y, Math.sin(a) * (rad(y) - 0.4));
    if (n.dot(c.sub(ref)) < 0) pos.push(p0, p2, p1); else pos.push(p0, p1, p2);
  };
  for (let i = 0; i < ys.length - 1; i++) {
    for (let k = 0; k < profile.length - 1; k++) {
      const a0 = pt(k, ys[i]), a1 = pt(k + 1, ys[i]), b0 = pt(k, ys[i + 1]), b1 = pt(k + 1, ys[i + 1]);
      const ym = (ys[i] + ys[i + 1]) / 2;
      tri(a0, a1, b1, ym);
      tri(a0, b1, b0, ym);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos.flatMap((p) => [p.x, p.y, p.z]), 3));
  g.computeVertexNormals();
  return g;
}
const range = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

// teardrop fairing along +Y from 0 to L, max radius rm at fraction f
function teardrop(L, rm, f = 0.22, seg = 20) {
  const pts = [];
  const n = 18;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let r;
    if (t < f) r = rm * Math.sqrt(1 - Math.pow(1 - t / f, 2));
    else r = rm * (1 - Math.pow((t - f) / (1 - f), 1.6));
    pts.push(new THREE.Vector2(Math.max(r, 0.0001), t * L));
  }
  return new THREE.LatheGeometry(pts, seg);
}

// ---------------------------------------------------------------- nose profile
// Blunted tangent ogive (total length L) on the 9 m barrel.
function noseProfile(y0 = 36.5, L = SHIP_LEN - 36.5, Rr = R, rn = 1.0) {
  let Lo = L, rho = 0, hc = 0;
  for (let it = 0; it < 40; it++) {
    rho = (Rr * Rr + Lo * Lo) / (2 * Rr);
    hc = Math.sqrt((rho - rn) ** 2 - (rho - Rr) ** 2);
    Lo += L - (hc + rn);
  }
  const co = new THREE.Vector2(0, Rr - rho); // ogive circle centre in (h, r)
  const cs = new THREE.Vector2(hc, 0);
  const dir = cs.clone().sub(co).normalize();
  const T = co.clone().addScaledVector(dir, rho);
  const pts = [];
  const n1 = 48;
  for (let i = 0; i <= n1; i++) {
    const h = (T.x * i) / n1;
    pts.push({ y: y0 + h, r: Math.sqrt(rho * rho - h * h) + Rr - rho });
  }
  const th0 = Math.atan2(T.y, T.x - hc);
  const n2 = 14;
  for (let i = 1; i <= n2; i++) {
    const th = th0 * (1 - i / n2);
    pts.push({ y: y0 + hc + rn * Math.cos(th), r: rn * Math.sin(th) });
  }
  pts[pts.length - 1].r = 0;
  // arc length along the meridian (continuing from the barrel) and dr/ds
  let s = y0;
  pts.forEach((p, i) => {
    if (i > 0) s += Math.hypot(p.y - pts[i - 1].y, p.r - pts[i - 1].r);
    p.s = s;
  });
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    p.slope = (b.r - a.r) / Math.max(1e-6, b.s - a.s);
  });
  return pts;
}
const NOSE = noseProfile();
function shipR(y) {
  if (y <= NOSE[0].y) return R;
  for (let i = 1; i < NOSE.length; i++) {
    if (y <= NOSE[i].y) {
      const a = NOSE[i - 1], b = NOSE[i];
      return a.r + ((b.r - a.r) * (y - a.y)) / (b.y - a.y);
    }
  }
  return 0;
}
function shipArc(y) {
  if (y <= NOSE[0].y) return [y, 0];
  for (let i = 1; i < NOSE.length; i++) {
    if (y <= NOSE[i].y + 1e-6) {
      const a = NOSE[i - 1], b = NOSE[i];
      const f = (y - a.y) / Math.max(1e-6, b.y - a.y);
      return [a.s + (b.s - a.s) * f, a.slope + (b.slope - a.slope) * f];
    }
  }
  const l = NOSE[NOSE.length - 1];
  return [l.s, l.slope];
}

// ---------------------------------------------------------------- materials
const OBJ_AXES_V = 'varying vec3 vOX; varying vec3 vOY; varying vec3 vOZ;';
const OBJ_AXES_END = 'vOX = normalize(normalMatrix * vec3(1.0, 0.0, 0.0)); vOY = normalize(normalMatrix * vec3(0.0, 1.0, 0.0)); vOZ = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));';

function boosterSteelMaterial() {
  const uniforms = { uFrost: { value: 1 }, uFrostTop: { value: 64 }, uHeat: { value: 0 } };
  const m = new THREE.MeshStandardMaterial({ color: 0xb9b8b6, metalness: 1.0, roughness: 0.4 });
  patchMaterial(
    m,
    {
      key: 'bstSteel2',
      fragHead: `uniform float uFrost, uFrostTop, uHeat; float frostM; ${VCOMMON}`,
      fragMap: /* glsl */ `
        {
          float rad = length(vObj.xz);
          float fwM = length(fwidth(vObj)) * 0.6 + 1e-5;
          float yy = vObj.y;
          steelSkin(vObj, max(rad, 1.0), fwM);
          float att = step(4.54, rad);
          vec3 c = steelColor(diffuseColor.rgb);
          // raceway cover joints & fastener rows on attachments
          float jr = fract(yy / 1.22);
          c = mix(c, c * 0.55, att * lineAA(min(jr, 1.0 - jr) * 1.22, 0.012, fwM));
          // soot & heat tint on the aft skirt
          float soot = smoothstep(4.8, 0.6, yy) * (0.5 + 0.5 * fbm3(vObj * vec3(0.9, 0.45, 0.9), 3));
          c = mix(c, c * vec3(1.0, 0.86, 0.66), smoothstep(6.0, 2.0, yy) * 0.5);
          c = mix(c, vec3(0.09, 0.08, 0.07), soot * 0.7);
          // cryogenic frost over the LOX (4.5-39.3 m) and CH4 (40.8 m-fill line) tanks
          float jag = (vnoise3(vObj * 0.6) - 0.5) * 2.5;
          float zone = smoothstep(4.3, 6.2, yy)
            * (1.0 - smoothstep(38.7, 39.3, yy + jag * 0.2) * smoothstep(41.4, 40.8, yy + jag * 0.2))
            * smoothstep(uFrostTop + 1.0, uFrostTop - 1.5, yy + jag);
          zone *= mix(1.0, 0.55, att);
          frostM = uFrost * frostMask(vObj, zone * uFrost, skRing);
          c = mix(c, frostColor(vObj), frostM);
          diffuseColor.rgb = c;
        }`,
      fragRough: `roughnessFactor = mix(0.43 + 0.05 * skPanel + skWeld * 0.2 + skHaz * 0.06, 0.9, frostM);`,
      fragMetal: `metalnessFactor = mix(1.0, 0.0, frostM);`,
      fragNormal: `normal = bumpN(normal, skH + frostM * 0.004 * vnoise3(vObj * vec3(9.0, 3.0, 9.0)), faceDirection);`,
    },
    uniforms
  );
  m.userData.uniforms = uniforms;
  return m;
}

// Ship body: black hexagonal TPS on the windward side, bare steel leeward.
function shipBodyMaterial() {
  const uniforms = { uHeat: { value: 0 } };
  const m = new THREE.MeshStandardMaterial({ color: 0xb9b8b6, metalness: 1.0, roughness: 0.4 });
  patchMaterial(
    m,
    {
      key: 'shipBody2',
      vertexHead: `attribute float aArc; attribute float aSlope; varying float vArc; varying float vSlope; ${OBJ_AXES_V}`,
      vertexBegin: 'vArc = aArc; vSlope = aSlope;',
      vertexEnd: OBJ_AXES_END,
      fragHead: `uniform float uHeat; varying float vArc; varying float vSlope; ${OBJ_AXES_V}
        float tileM; float frostM; float gAng; float gFw; float gCover; ${VCOMMON} ${TILE_GLSL}`,
      fragMap: /* glsl */ `
        {
          float rad = length(vObj.xz);
          float fwM = length(fwidth(vObj)) * 0.6 + 1e-5;
          gFw = fwM;
          float ang = atan(vObj.x, vObj.z);
          gAng = ang;
          float yy = vObj.y;
          steelSkin(vObj, max(rad, 0.5), fwM);
          vec3 steelC = steelColor(diffuseColor.rgb);
          tileCells(vArc, ang, max(rad, 0.02), vSlope);
          // tile boundary: just past the flap hinges on the barrel, wrapping leeward
          // around the forward flaps and closing over the nose tip
          float cover = 1.8 + 0.5 * smoothstep(37.0, 40.0, yy) + 0.95 * pow(smoothstep(42.5, 48.4, yy), 1.3);
          gCover = cover;
          float att = step(4.56, rad) * step(yy, 44.0);
          // edge tiles are trimmed to a (nearly) straight line; small per-row jitter
          float edgeCut = cover - (hash11(tcId.y * 7.3) - 0.5) * 0.012;
          float dB = (edgeCut - abs(ang)) * rad;
          tcEdge = min(tcEdge, max(dB, 0.0));
          tileM = step(0.0, dB) * (1.0 - att);
          // steel cut-out around the ship quick-disconnect plate
          vec2 qd = vec2((ang - 0.35) * rad, yy - 3.3);
          tileM *= 1.0 - step(abs(qd.x), 1.0) * step(abs(qd.y), 1.35);
          vec3 tileC = tileColor(tcId, tcEdge, fwM);
          // payload ("pez") door outline on the leeward side
          float da = ang - 2.62; da -= 6.28318 * floor(da / 6.28318 + 0.5);
          vec2 pd = vec2(da * rad, yy - 33.6);
          float box = max(abs(pd.x) - 2.9, abs(pd.y) - 0.42);
          steelC = mix(steelC, steelC * 0.82, step(box, 0.0) * 0.5);
          steelC = mix(steelC, vec3(0.05), lineAA(abs(box), 0.014, fwM));
          // aft skirt soot
          steelC = mix(steelC, steelC * vec3(0.55, 0.5, 0.45), smoothstep(2.0, 0.0, yy) * 0.8);
          // frost over the header/main tanks while loaded, sheds with altitude
          float zone = smoothstep(3.0, 4.5, yy) * smoothstep(17.3, 16.7, yy) + smoothstep(18.0, 18.8, yy) * smoothstep(29.6, 28.4, yy);
          float fk = 1.0 - smoothstep(1500.0, 25000.0, vWorld.y);
          frostM = frostMask(vObj, zone * 0.42 * fk, skRing) * fk * (1.0 - tileM) * (1.0 - att * 0.5);
          steelC = mix(steelC, frostColor(vObj), frostM);
          diffuseColor.rgb = mix(steelC, tileC, tileM);
        }`,
      fragRough: `roughnessFactor = mix(mix(0.43 + 0.05 * skPanel + skWeld * 0.2, 0.9, frostM), 0.5 + 0.22 * tlV + tlGap * 0.3, tileM);`,
      fragMetal: `metalnessFactor = mix(1.0, 0.0, max(tileM, frostM));`,
      fragNormal: /* glsl */ `
        {
          float near = 1.0 - smoothstep(0.004, 0.02, gFw);
          float hT = -0.004 * (1.0 - smoothstep(0.0, 0.02, tcEdge)) * near;
          normal = bumpN(normal, mix(skH, hT, tileM) + frostM * 0.004 * vnoise3(vObj * vec3(9.0, 3.0, 9.0)), faceDirection);
          // each tile sits at a slightly different angle -> patchwork sheen
          vec2 tilt = (hash22(tcId + 11.0) - 0.5) * 0.045 * (1.0 - smoothstep(0.12, 0.4, gFw / TP)) * tileM;
          vec3 dObj = vec3(cos(gAng), 0.0, -sin(gAng)) * tilt.x + vec3(0.0, tilt.y, 0.0);
          normal = normalize(normal + vOX * dObj.x + vOY * dObj.y + vOZ * dObj.z);
        }`,
      fragEmissive: /* glsl */ `
        if (uHeat > 0.001) {
          // re-entry heating: whole windward side glows, hottest at the nose cap and
          // along the tile-line "chines" at the sides; per-tile variation
          float yy = vObj.y;
          float wind = smoothstep(-0.2, 0.95, cos(gAng));
          float side = smoothstep(0.85, 1.45, abs(gAng)) * smoothstep(gCover + 0.02, gCover - 0.3, abs(gAng));
          float noseK = smoothstep(38.0, 49.5, yy);
          float T = 0.62 * wind + 0.32 * side + 0.45 * noseK * (0.4 + 0.6 * wind) - 0.12 * smoothstep(10.0, 1.0, yy);
          T *= 0.91 + 0.17 * hash12(tcId + 3.7) * (1.0 - smoothstep(0.2, 0.5, gFw / TP));
          T *= 1.0 - tlGap * 0.35;
          totalEmissiveRadiance += heatGlow(T * uHeat) * tileM;
          // leeward steel only picks up a faint tint from the plasma
          totalEmissiveRadiance += vec3(0.6, 0.12, 0.05) * 0.1 * uHeat * uHeat * (1.0 - tileM);
        }`,
    },
    uniforms
  );
  m.userData.uniforms = uniforms;
  return m;
}

// Flaps and hinge fairings: tiles on windward-facing surfaces and edges, steel leeward.
// Uses rest-pose (ship-frame) position/normal attributes so the pattern and the
// tile/steel split stay attached to a flap when it is rotated about its hinge.
function flapMaterial(uniforms) {
  const m = new THREE.MeshStandardMaterial({ color: 0xb9b8b6, metalness: 1.0, roughness: 0.4 });
  patchMaterial(m, {
    key: 'flapTiles3',
    vertexHead: `attribute vec3 aP0; attribute vec3 aN0; attribute float aTile; varying vec3 vP0; varying vec3 vN0; varying float vTile; ${OBJ_AXES_V}`,
    vertexBegin: 'vP0 = aP0; vN0 = aN0; vTile = aTile;',
    vertexEnd: OBJ_AXES_END,
    fragHead: `uniform float uHeat; varying vec3 vP0; varying vec3 vN0; varying float vTile; ${OBJ_AXES_V} float tileM; float gFw; float gEdge; ${VCOMMON} ${TILE_GLSL}`,
    fragMap: /* glsl */ `
      {
        float fwM = length(fwidth(vP0)) * 0.6 + 1e-5;
        gFw = fwM;
        vec3 n = normalize(vN0);
        vec2 pp = abs(n.x) > abs(n.z) * 1.3 ? vP0.zy : vP0.xy;
        vec2 id = hexPlane(pp);
        tileM = max(step(-0.45, n.z), step(0.5, vTile));
        gEdge = 1.0 - abs(n.z);
        vec3 tileC = tileColor(id, tcEdge, fwM);
        tcId = id;
        skPanel = vnoise3(vP0 * 0.4);
        skWeld = lineAA(min(fract(vP0.y / 1.83), 1.0 - fract(vP0.y / 1.83)) * 1.83, 0.01, fwM);
        skHaz = 0.0;
        skH = 0.008 * (vnoise3(vP0 * 0.9) - 0.5);
        vec3 steelC = steelColor(diffuseColor.rgb);
        // heat tint on the flap steel after re-entry heating
        steelC = mix(steelC, steelC * vec3(0.95, 0.75, 0.55), clamp(uHeat, 0.0, 1.0) * 0.5);
        diffuseColor.rgb = mix(steelC, tileC, tileM);
      }`,
    fragRough: `roughnessFactor = mix(0.43 + 0.05 * skPanel, 0.5 + 0.22 * tlV + tlGap * 0.3, tileM);`,
    fragMetal: `metalnessFactor = 1.0 - tileM;`,
    fragNormal: /* glsl */ `
      {
        float near = 1.0 - smoothstep(0.004, 0.02, gFw);
        float hT = -0.004 * (1.0 - smoothstep(0.0, 0.02, tcEdge)) * near;
        normal = bumpN(normal, mix(skH, hT, tileM), faceDirection);
        vec2 tilt = (hash22(tcId + 11.0) - 0.5) * 0.045 * (1.0 - smoothstep(0.12, 0.4, gFw / TP)) * tileM;
        normal = normalize(normal + vOX * tilt.x + vOY * tilt.y);
      }`,
    fragEmissive: /* glsl */ `
      if (uHeat > 0.001) {
        // windward faces glow, edges (leading/trailing, tip) hottest
        float wind = smoothstep(-0.3, 0.9, normalize(vN0).z);
        float T = 0.55 * wind + 0.55 * gEdge * tileM;
        T *= 0.91 + 0.17 * hash12(tcId + 3.7) * (1.0 - smoothstep(0.2, 0.5, gFw / TP));
        totalEmissiveRadiance += heatGlow(T * uHeat) * tileM;
        totalEmissiveRadiance += vec3(0.6, 0.12, 0.05) * 0.12 * uHeat * uHeat * (1.0 - tileM);
      }`,
  }, uniforms);
  return m;
}
// bake rest-pose attributes for the flap material
function restAttrs(geo, tiled = 0) {
  const g = prep(geo);
  g.setAttribute('aP0', g.attributes.position.clone());
  g.setAttribute('aN0', g.attributes.normal.clone());
  g.setAttribute('aTile', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(tiled), 1));
  return g;
}

// Heat shield / engine-bay floor: dark, sooty, with flexible boots around each engine.
function heatShieldMaterial(key, rings) {
  const m = new THREE.MeshStandardMaterial({ color: 0x3a3836, metalness: 0.3, roughness: 0.75, side: THREE.DoubleSide });
  const ringCode = rings
    .map(([n, r, off]) => `d = min(d, engDist(vObj.xz, ${n.toFixed(1)}, ${r.toFixed(3)}, ${off.toFixed(4)}));`)
    .join('\n');
  patchMaterial(m, {
    key,
    fragHead: /* glsl */ `
      float engDist(vec2 p, float N, float r, float off) {
        float a = atan(p.y, p.x) - off;
        float k = floor(a * N / 6.28318 + 0.5);
        float ac = off + k * 6.28318 / N;
        return length(p - r * vec2(cos(ac), sin(ac)));
      }`,
    fragMap: /* glsl */ `
      {
        float d = 1e3;
        ${ringCode}
        float soot = fbm3(vObj * 1.3, 4);
        vec3 c = diffuseColor.rgb * (0.45 + 0.7 * soot);
        float boot = smoothstep(0.98, 0.72, d);
        c = mix(c, vec3(0.05, 0.048, 0.045), boot);
        float rad = length(vObj.xz);
        // tile-like panel seams of the shield
        float pa = atan(vObj.z, vObj.x) * rad / 0.6;
        c *= 0.85 + 0.15 * step(0.08, fract(rad / 0.6)) * step(0.06, fract(pa));
        diffuseColor.rgb = c;
      }`,
  });
  return m;
}

function engineMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x8a8580, metalness: 0.9, roughness: 0.36, side: THREE.DoubleSide });
  patchMaterial(m, {
    key: 'engine2',
    vertexHead: 'attribute float aGlow; attribute float aPart; varying float vGlow; varying float vPart;',
    vertexBegin: 'vGlow = aGlow; vPart = aPart;',
    fragHead: 'varying float vGlow; varying float vPart; float engIn;',
    fragMap: /* glsl */ `
      {
        engIn = gl_FrontFacing ? 0.0 : 1.0;
        float y = vObj.y;
        float n = fbm3(vObj * vec3(3.0, 6.0, 3.0), 3);
        // outside: silvery Inconel/steel with heat tint bands (straw -> bronze -> blue)
        vec3 c = diffuseColor.rgb * (0.8 + 0.3 * n);
        float band = smoothstep(0.0, 1.0, y / 1.7);
        vec3 tint = mix(vec3(0.9, 0.78, 0.6), vec3(0.62, 0.62, 0.78), smoothstep(0.35, 0.9, band));
        c *= mix(vec3(1.0), tint, 0.6);
        c = mix(c, c * 0.55, smoothstep(0.12, 0.0, y)); // darker exit lip
        // inside the bell: soot-darkened, with faint bands from the cooling channels
        vec3 ci = vec3(0.06, 0.055, 0.05) * (0.7 + 0.6 * n) * (0.85 + 0.15 * sin(y * 40.0));
        c = mix(c, ci, engIn);
        // radiatively cooled RVac extension: duller, grey-brown
        c = mix(c, vec3(0.3, 0.28, 0.26) * (0.8 + 0.3 * n), step(0.5, vPart) * (1.0 - engIn));
        diffuseColor.rgb = c;
      }`,
    fragRough: `roughnessFactor = mix(roughnessFactor, 0.7, max(engIn, step(0.5, vPart) * 0.6));`,
    fragEmissive: /* glsl */ `
      {
        float throat = smoothstep(0.0, 1.6, vObj.y);
        totalEmissiveRadiance += vec3(1.0, 0.62, 0.35) * vGlow * engIn * (30.0 + 250.0 * throat);
        totalEmissiveRadiance += vec3(1.0, 0.35, 0.15) * vGlow * (1.0 - engIn) * smoothstep(0.4, 0.0, vObj.y) * 1.5;
      }`,
  });
  return m;
}

function gridFinMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x9d9a96, metalness: 0.95, roughness: 0.42 });
  patchMaterial(m, {
    key: 'gridfin2',
    fragMap: /* glsl */ `
      {
        float n = fbm3(vObj * 1.7, 4);
        vec3 c = diffuseColor.rgb * (0.7 + 0.45 * n);
        // heat discolouration from hot staging & re-entry
        c = mix(c, c * vec3(0.95, 0.78, 0.55), smoothstep(0.45, 0.7, n) * 0.7);
        c = mix(c, vec3(0.12, 0.1, 0.09), smoothstep(0.62, 0.8, fbm3(vObj * 3.1 + 4.0, 3)) * 0.6);
        diffuseColor.rgb = c;
      }`,
    fragRough: `roughnessFactor = 0.35 + 0.25 * fbm3(vObj * 2.3, 2);`,
  });
  return m;
}

function darkMetal(key, color = 0x2c2a28, rough = 0.55) {
  const m = new THREE.MeshStandardMaterial({ color, metalness: 0.7, roughness: rough });
  patchMaterial(m, {
    key,
    fragMap: `diffuseColor.rgb *= 0.7 + 0.5 * fbm3(vObj * 2.0, 3);`,
  });
  return m;
}

// ---------------------------------------------------------------- engines
// Raptor 3: regeneratively cooled bell, smooth chamber and a clean, rounded
// powerhead with the turbopumps and plumbing integrated (almost no external lines).
// aPart: 0 regen/metal, 1 radiatively cooled RVac extension.
function raptorGeometry({ exitR, bellLen, throatR = 0.2, vac = false }) {
  const parts = [];
  const tag = (g, v) => { const x = prep(g); x.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(x.attributes.position.count).fill(v), 1)); return x; };
  const pw = vac ? 0.72 : 0.62;
  const bellR = (f) => throatR + (exitR - throatR) * Math.pow(1 - f, pw);
  const pts = [];
  const n = 26;
  for (let i = 0; i <= n; i++) pts.push(new THREE.Vector2(bellR(i / n), (i / n) * bellLen));
  const bell = prep(new THREE.LatheGeometry(pts, 40));
  {
    const p = bell.attributes.position;
    const part = new Float32Array(p.count);
    if (vac) for (let i = 0; i < p.count; i += 3) {
      const ym = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
      part.fill(ym < bellLen * 0.68 ? 1 : 0, i, i + 3);
    }
    bell.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  }
  parts.push(bell);
  // thin rolled exit lip
  const lip = new THREE.TorusGeometry(exitR + 0.01, vac ? 0.028 : 0.022, 6, 48);
  lip.rotateX(Math.PI / 2);
  lip.translate(0, 0.01, 0);
  parts.push(tag(lip, vac ? 1 : 0));
  if (vac) {
    // RVac extension stiffener rings
    for (const [f, t] of [[0.36, 0.025], [0.12, 0.022]]) {
      const tr = new THREE.TorusGeometry(bellR(f) + t * 0.6, t, 6, 40);
      tr.rotateX(Math.PI / 2); tr.translate(0, bellLen * f, 0);
      parts.push(tag(tr, 1));
    }
  }
  // chamber + powerhead as one smooth lathe (throat -> chamber -> injector dome -> pump housings)
  const y0 = bellLen;
  const prof = [
    [throatR, y0], [0.26, y0 + 0.12], [0.31, y0 + 0.28], [0.31, y0 + 0.5], [0.36, y0 + 0.58],
    [0.44, y0 + 0.66], [0.47, y0 + 0.8], [0.46, y0 + 0.98], [0.4, y0 + 1.1], [0.26, y0 + 1.18], [0.001, y0 + 1.22],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  parts.push(tag(new THREE.LatheGeometry(prof, 24), 0));
  // the two turbopumps (fuel / ox) as smooth capsules hugging the powerhead
  for (const sx of [1, -1]) {
    const tp = new THREE.CapsuleGeometry(0.17, 0.42, 4, 12);
    tp.translate(sx * 0.45, y0 + 0.86, 0);
    parts.push(tag(tp, 0));
  }
  return mergeGeometries(parts);
}

export function engineLayoutBooster() {
  const list = [];
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 + Math.PI / 2; list.push([0.78 * Math.cos(a), 0.78 * Math.sin(a), 0]); }
  for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2 + 0.31; list.push([2.3 * Math.cos(a), 2.3 * Math.sin(a), 1]); }
  for (let k = 0; k < 20; k++) { const a = (k / 20) * Math.PI * 2; list.push([3.78 * Math.cos(a), 3.78 * Math.sin(a), 2]); }
  return list;
}

function engineCluster(layout, geoFor, mat, rotFor = () => 0) {
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
      // turn each engine so its turbopumps sit tangentially (varies the look)
      const m = new THREE.Matrix4().makeRotationY(rotFor(e) + k * 0.7).setPosition(e[0], e[4] ?? 0, e[1]);
      mesh.setMatrixAt(k, m);
    });
    mesh.castShadow = true;
    mesh.userData.indices = list.map(([, i]) => i);
    mesh.userData.glow = g.getAttribute('aGlow');
    meshes.push(mesh);
  }
  return meshes;
}
const glowSetter = (engines) => (levels) => {
  for (const m of engines) {
    const a = m.userData.glow;
    m.userData.indices.forEach((idx, k) => { a.array[k] = levels[idx]; });
    a.needsUpdate = true;
  }
};

// ---------------------------------------------------------------- grid fin
// Super Heavy V3 grid fin: large welded steel lattice waffle (~1.5x the V1/V2 area),
// flow passes along Y. Local frame: +X radially outward, Z tangential, Y along the stage.
// The rudder fin's internal grid is canted so the air passes through at an angle.
function gridFinGeometry(rudder = false) {
  const parts = [];
  const lattice = [];
  const span = 3.7, width = 4.7, depth = 1.05, bar = 0.09, x0 = 0.6;
  const box = (x, z, sx, sy, sz) => { const b = new THREE.BoxGeometry(sx, sy, sz); b.translate(x, 0, z); parts.push(b); };
  // heavy outer frame
  box(x0 + span / 2, -width / 2, span, depth, 0.3);
  box(x0 + span / 2, width / 2, span, depth, 0.3);
  box(x0 + span, 0, 0.3, depth, width + 0.3);
  box(x0 + 0.14, 0, 0.3, depth * 1.05, width + 0.3);
  // diagonal lattice
  const nb = 8;
  const pitch = (span + width) / (2 * nb);
  const zmin = -width / 2 + 0.12, zmax = width / 2 - 0.12, xmin = x0 + 0.28, xmax = x0 + span - 0.12;
  for (let i = -nb * 2; i <= nb * 2; i++) {
    for (const s of [-1, 1]) {
      const c = i * pitch;
      const pts = [];
      for (const z of [zmin, zmax]) { const x = c + x0 + span / 2 + s * z; if (x >= xmin && x <= xmax) pts.push([x, z]); }
      for (const x of [xmin, xmax]) { const z = s * (x - x0 - span / 2 - c); if (z > zmin && z < zmax) pts.push([x, z]); }
      if (pts.length < 2) continue;
      const [a, b] = pts;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.15) continue;
      const g = new THREE.BoxGeometry(bar, depth * 0.92, len);
      g.rotateY(Math.atan2(b[0] - a[0], b[1] - a[1]));
      g.translate((a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2);
      lattice.push(g);
    }
  }
  const lat = merge(lattice);
  if (rudder) lat.applyMatrix4(new THREE.Matrix4().makeShear(0, 0, 0, 0.36, 0, 0)); // z += 0.36 * y
  parts.push(lat);
  // root hub & shaft into the tank wall
  const hub = new THREE.CylinderGeometry(0.4, 0.4, 0.6, 16);
  hub.rotateZ(Math.PI / 2);
  hub.translate(0.32, 0, 0);
  parts.push(hub);
  const hub2 = new THREE.BoxGeometry(0.38, depth * 1.1, 1.5);
  hub2.translate(x0 + 0.05, 0, 0);
  parts.push(hub2);
  return merge(parts);
}

// ---------------------------------------------------------------- booster
export function createBooster() {
  const g = new THREE.Group();
  g.name = 'booster';
  const steel = boosterSteelMaterial();
  steel.userData.uniforms.uFrostTop.value = 62.5;
  const shieldMat = heatShieldMaterial('bShield', [[3, 0.78, Math.PI / 2], [10, 2.3, 0.31], [20, 3.78, 0]]);
  const finMat = gridFinMaterial();

  // ---- steel: barrel + attachments merged into one mesh
  const sParts = [];
  const body = new THREE.CylinderGeometry(R, R, BARREL_TOP - SKIRT_Y0, 160, 6, true);
  body.translate(0, (BARREL_TOP + SKIRT_Y0) / 2, 0);
  sParts.push(body);
  // four chines on the LOX tank: long triangular strakes, blunt at the bottom, tapering
  // at the top. V3: taller & closer together on the raceway (-Z) side, shorter and
  // spread wider on the rudder-fin (+Z) side.
  const chineProf = [[-0.62, -0.06], [-0.2, 0.36], [0.0, 0.42], [0.2, 0.36], [0.62, -0.06]];
  for (const [deg, y1] of [[-55, 31], [-125, 31], [28, 25], [152, 25]]) {
    const a = (deg * Math.PI) / 180;
    const y0 = 4.6;
    sParts.push(loft(a, chineProf, [y0, y0 + 0.3, ...range(y0 + 0.9, y1, 16)], (y) => {
      const kb = Math.min(1, (y - y0) / 0.3 + 0.2);
      const kt = Math.pow(Math.max(0, Math.min(1, (y1 - y) / 11)), 0.8);
      return [Math.max(0.3, kt) * kb, kt * kb];
    }));
  }
  // main raceway (leeward, -Z) + secondary conduits
  const raceProf = [[-0.4, -0.05], [-0.36, 0.2], [-0.3, 0.28], [0.3, 0.28], [0.36, 0.2], [0.4, -0.05]];
  const taper = (y0, y1, l) => (y) => { const k = Math.min(1, (y - y0) / l, (y1 - y) / l); return [1, Math.max(0.02, k)]; };
  sParts.push(loft(-Math.PI / 2, raceProf, [2.4, ...range(3.4, 66.0, 12), 67.4], taper(2.4, 67.4, 1.0)));
  const condProf = range(0, Math.PI, 6).map((t) => [-Math.cos(t) * 0.13, Math.sin(t) * 0.16 - 0.03]);
  sParts.push(loft(-Math.PI / 2 + 0.2, condProf, [3.5, ...range(4.5, 60, 6), 61], taper(3.5, 61, 0.6)));
  sParts.push(loft(-Math.PI / 2 - 0.19, condProf, [5.0, ...range(6, 40, 4), 41], taper(5, 41, 0.6)));
  // 20 hold-down clamp fittings on the aft skirt between the outer engines
  for (let k = 0; k < 20; k++) {
    const a = ((k + 0.5) / 20) * TAU;
    const hb = roundedBox(0.22, 0.8, 0.42, 0.05);
    hb.rotateY(Math.PI / 2);
    sParts.push(prep(hb, radialMatrix(a, R + 0.08, SKIRT_Y0 + 0.45)));
  }
  // grid fin bases (actuators are inside the tank on V3: only low fairings outside);
  // the two catch fins carry the lift/catch hardpoints on top of their bases
  for (const [a, catchFin] of FIN_LAYOUT) {
    const hsg = roundedBox(1.9, 2.4, 0.42, 0.16); // x tangential, y up, z radial
    hsg.rotateY(Math.PI / 2);
    sParts.push(prep(hsg, radialMatrix(a, R + 0.1, FIN_Y + 0.1)));
    if (catchFin) {
      const pin = roundedBox(1.3, 0.5, 1.15, 0.1);
      pin.rotateY(Math.PI / 2);
      sParts.push(prep(pin, radialMatrix(a, R + 0.5, FIN_Y + 1.25)));
    }
  }
  const steelMesh = new THREE.Mesh(merge(sParts), steel);
  g.add(steelMesh);

  // ---- grid fins: 3 in a T (two catch fins at +-X, a rudder fin on the windward side)
  const finGeo = gridFinGeometry(false);
  const rudGeo = gridFinGeometry(true);
  const fins = merge(FIN_LAYOUT.map(([a, catchFin]) => prep(catchFin ? finGeo : rudGeo, radialMatrix(a, R + 0.1, FIN_Y))));
  g.add(new THREE.Mesh(fins, finMat));

  // ---- aft: thrust-section heat shield (V3: no individual engine shrouds), skirt interior
  const floor = new THREE.CircleGeometry(R - 0.02, 96);
  floor.rotateX(Math.PI / 2);
  floor.translate(0, FLOOR_Y, 0);
  const skirtIn = new THREE.CylinderGeometry(R - 0.03, R - 0.03, FLOOR_Y - SKIRT_Y0, 96, 1, true);
  skirtIn.translate(0, (FLOOR_Y + SKIRT_Y0) / 2, 0);
  g.add(new THREE.Mesh(merge([floor, skirtIn]), shieldMat));

  // ---- integrated hot-staging section (V3): open N1-style truss above the forward
  // dome; the ship's exhaust hits the dome and escapes through the truss openings.
  const ringMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xa3a09c, metalness: 0.9, roughness: 0.45, side: THREE.DoubleSide }), {
    key: 'hsr3',
    fragHead: 'uniform float uVentGlow;',
    fragMap: /* glsl */ `
      {
        float rad = length(vObj.xz);
        float dome = step(rad, 4.42) * step(vObj.y, ${(TRUSS_Y0 + 0.9).toFixed(2)});
        float n = fbm3(vObj * vec3(1.6, 4.0, 1.6), 3);
        vec3 c = diffuseColor.rgb * (0.75 + 0.35 * n);
        float top = smoothstep(${TRUSS_Y0.toFixed(2)}, ${BOOSTER_LEN.toFixed(2)}, vObj.y);
        c = mix(c, c * vec3(0.95, 0.86, 0.74), 0.2 + 0.3 * top);
        c = mix(c, vec3(0.1, 0.09, 0.08), smoothstep(0.52, 0.78, n + top * 0.15) * 0.6);
        // forward dome blast shield: scorched, dark
        c = mix(c, vec3(0.07, 0.065, 0.06) * (0.6 + 0.9 * n), dome);
        diffuseColor.rgb = c;
      }`,
    fragEmissive: /* glsl */ `
      {
        float rad2 = length(vObj.xz);
        float dome2 = step(rad2, 4.42) * step(vObj.y, ${(TRUSS_Y0 + 0.9).toFixed(2)});
        float hot = 0.6 + 0.8 * fbm3(vObj * 2.5, 2);
        // incandescent dome and glowing gas lighting the inner faces of the truss
        totalEmissiveRadiance += vec3(1.0, 0.55, 0.25) * uVentGlow * 400.0 * hot * (dome2 + 0.08 * (1.0 - dome2));
      }`,
  }, { uVentGlow: { value: 0 } });
  const rParts = [];
  const band = (y0, y1, r0 = R, r1 = R - 0.22) => {
    const o = new THREE.CylinderGeometry(r0, r0, y1 - y0, 160, 1, true); o.translate(0, (y0 + y1) / 2, 0); rParts.push(o);
    const i = new THREE.CylinderGeometry(r1, r1, y1 - y0, 96, 1, true); i.translate(0, (y0 + y1) / 2, 0); rParts.push(i);
    for (const [y, up] of [[y0, false], [y1, true]]) {
      const an = new THREE.RingGeometry(r1, r0, 160, 1);
      an.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
      an.translate(0, y, 0);
      rParts.push(an);
    }
  };
  const TB = TRUSS_Y0 + 0.32, TT = BOOSTER_LEN - 0.3;
  band(TRUSS_Y0, TB);
  band(TT, BOOSTER_LEN);
  // Warren truss: 18 bays of round tubes
  const NB = 18, tubeR = 0.13, rT = R - 0.13;
  const node = (ang, y) => new THREE.Vector3(Math.cos(ang) * rT, y, Math.sin(ang) * rT);
  const tube = (A, B, r = tubeR) => {
    const d = B.clone().sub(A);
    const c = new THREE.CylinderGeometry(r, r, d.length() + 0.1, 10, 1, true);
    c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
    c.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
    rParts.push(c);
  };
  for (let k = 0; k < NB; k++) {
    const a0 = (k / NB) * TAU + 0.12, a1 = ((k + 0.5) / NB) * TAU + 0.12, a2 = ((k + 1) / NB) * TAU + 0.12;
    tube(node(a0, TB), node(a1, TT));
    tube(node(a1, TT), node(a2, TB));
    // gusset plates at the nodes
    for (const [aa, yy] of [[a0, TB + 0.12], [a1, TT - 0.12]]) {
      const gp = new THREE.BoxGeometry(0.2, 0.3, 0.46);
      rParts.push(prep(gp, radialMatrix(aa, rT, yy)));
    }
  }
  // three hot-staging clamp posts (between the ship's RVacs)
  for (const deg of [90, 210, 330]) {
    const a = (deg * Math.PI) / 180;
    const post = roundedBox(0.34, TT - TB, 0.5, 0.06);
    post.rotateY(Math.PI / 2);
    rParts.push(prep(post, radialMatrix(a, R - 0.2, (TB + TT) / 2)));
  }
  // forward dome (blast shield) inside the truss
  const domeGeo = new THREE.SphereGeometry(R - 0.05, 64, 12, 0, TAU, 0, Math.PI / 2);
  domeGeo.scale(1, 0.72 / (R - 0.05), 1);
  domeGeo.translate(0, TRUSS_Y0, 0);
  rParts.push(domeGeo);
  const ring = new THREE.Mesh(merge(rParts), ringMat);
  g.add(ring);

  // ---- engines (33 Raptor 3)
  const layout = engineLayoutBooster().map(([x, z]) => [x, z, 0, 'sl', 0]);
  const engMat = engineMaterial();
  const engines = engineCluster(layout, () => raptorGeometry({ exitR: 0.65, bellLen: 1.7 }), engMat);
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
    setGlow: glowSetter(engines),
  };
}

// ---------------------------------------------------------------- ship
function flapShape(pts) {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}
// Extrude a flap planform lying in the plane z = zc, thickness tapering toward the tip.
function flapGeometry(outline, zc, thick, hingeX, span, tipScale = 0.5) {
  const b = Math.min(0.12, thick * 0.3);
  const g = new THREE.ExtrudeGeometry(flapShape(outline), { depth: thick - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 3, curveSegments: 1 });
  g.translate(0, 0, -(thick - 2 * b) / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const f = Math.min(1, Math.max(0, (Math.abs(p.getX(i)) - Math.abs(hingeX(p.getY(i)))) / span));
    p.setZ(i, p.getZ(i) * (1 - (1 - tipScale) * f) + zc);
  }
  g.computeVertexNormals();
  return g;
}

export function createShip() {
  const g = new THREE.Group();
  g.name = 'ship';
  const tiles = shipBodyMaterial();
  const flapMat = flapMaterial({ uHeat: tiles.userData.uniforms.uHeat });
  const shieldMat = heatShieldMaterial('sShield', [[3, 1.05, Math.PI / 2], [3, 3.0, -Math.PI / 2]]);
  const dark = darkMetal('sdark2', 0x242322, 0.5);

  // ---- body: barrel + blunted ogive nose (with meridian arc attributes for the tile map)
  const barrel = new THREE.CylinderGeometry(R, R, NOSE[0].y, 160, 8, true);
  barrel.translate(0, NOSE[0].y / 2, 0);
  const nose = new THREE.LatheGeometry(NOSE.map((p) => new THREE.Vector2(Math.max(p.r, 0), p.y)), 160);
  const bParts = [barrel, nose];
  // leeward raceway running up to the nose
  const RACE_A = -Math.PI / 2 - 0.7;
  const raceProf = [[-0.3, -0.05], [-0.27, 0.16], [-0.22, 0.22], [0.22, 0.22], [0.27, 0.16], [0.3, -0.05]];
  bParts.push(loft(RACE_A, raceProf, [0.6, ...range(1.5, 36, 6), ...range(37, 41.5, 5), 42.5], (y) => {
    const k = Math.min(1, (y - 0.6) / 0.9, (42.5 - y) / 1.2);
    return [1, Math.max(0.02, k)];
  }, (y) => shipR(y)));
  const bodyGeo = merge(bParts);
  {
    const p = bodyGeo.attributes.position;
    const arc = new Float32Array(p.count), slope = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) { const [s, sl] = shipArc(p.getY(i)); arc[i] = s; slope[i] = sl; }
    bodyGeo.setAttribute('aArc', new THREE.BufferAttribute(arc, 1));
    bodyGeo.setAttribute('aSlope', new THREE.BufferAttribute(slope, 1));
  }
  g.add(new THREE.Mesh(bodyGeo, tiles));

  // ---- flaps (tiles on windward faces, bare steel leeward)
  // Each moving flap hangs under a pivot whose local +Y is the hinge axis and whose
  // local +X points outboard; positive pivot.rotation.y folds the flap toward leeward (-Z).
  const fParts = []; // static fairings (ship frame)
  const flaps = {};
  const addFlap = (name, geo, A, B, out = new THREE.Vector3(Math.sign(A.x), 0, 0)) => {
    // A, B: hinge end points (ship frame); local X outboard (perpendicular to the hinge),
    // local Y along the hinge, local Z = X x Y chosen to face windward (+Z side)
    let Y = B.clone().sub(A).normalize();
    const X = out.clone().addScaledVector(Y, -out.dot(Y)).normalize();
    let Zl = X.clone().cross(Y);
    if (Zl.z < 0) { Y.negate(); Zl.negate(); }
    const frame = new THREE.Matrix4().makeBasis(X, Y, Zl).setPosition(A);
    const hinge = new THREE.Object3D();
    hinge.matrixAutoUpdate = false;
    hinge.matrix.copy(frame);
    const pivot = new THREE.Object3D();
    pivot.name = name;
    const local = restAttrs(geo);
    local.applyMatrix4(frame.clone().invert());
    const mesh = new THREE.Mesh(local, flapMat);
    pivot.add(mesh);
    hinge.add(pivot);
    g.add(hinge);
    flaps[name] = pivot;
  };
  for (const side of [-1, 1]) {
    const LR = side < 0 ? 'L' : 'R';
    // aft flaps: large trapezoids on the engine bay / LOX tank, plane just windward of the sides
    const zA = 0.3;
    const hA = Math.sqrt(R * R - zA * zA) - 0.15;
    const aftOutline = [[hA, 1.3], [hA + 4.0, 1.3], [hA + 4.0, 6.4], [hA + 0.35, 12.7], [hA, 12.9]].map(([x, y]) => [side * x, y]);
    addFlap('aft' + LR, flapGeometry(aftOutline, zA, 0.78, () => hA, 4.0, 0.45),
      new THREE.Vector3(side * hA, 1.3, zA), new THREE.Vector3(side * hA, 12.9, zA));
    // hinge fairing along the aft flap root (leeward side), and its top cap
    const hf = teardrop(12.4, 0.5, 0.06, 16);
    hf.scale(1, 1, 1.35);
    hf.translate(side * (R - 0.12), 0.9, zA - 0.28);
    fParts.push(hf);
    const cap = teardrop(2.2, 0.5, 0.35, 16);
    cap.scale(0.85, 1, 1.15);
    cap.translate(side * (hA + 0.02), 11.9, zA);
    fParts.push(cap);

    // forward flaps (Block 2/3): smaller, thinner, more pointed, higher on the nose and
    // moved leeward (~140 deg apart); hinge along the ogive meridian at azimuth +-110 deg
    const phi = side * ((180 - 70) * Math.PI) / 180; // ship azimuth from windward
    const yb = 40.4, yt = 46.9;
    const sp = (y, dr = -0.1) => { const r = shipR(y) + dr; return new THREE.Vector3(Math.sin(phi) * r, y, Math.cos(phi) * r); };
    const A = sp(yb), B = sp(yt);
    const d = B.clone().sub(A).normalize();
    const out = new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi));
    const X = out.clone().addScaledVector(d, -out.dot(d)).normalize();
    const L = A.distanceTo(B);
    const span = 2.9;
    // planform in (u outboard, v along hinge)
    const uv = [[0, 0], [span, 0.35], [span * 0.9, 1.5], [0.35, L - 0.2], [0, L]];
    const fshape = flapShape(uv);
    const thick = 0.42, bv = 0.1;
    const fg = new THREE.ExtrudeGeometry(fshape, { depth: thick - 2 * bv, bevelEnabled: true, bevelThickness: bv, bevelSize: bv, bevelSegments: 3, curveSegments: 1 });
    fg.translate(0, 0, -(thick - 2 * bv) / 2);
    {
      const p = fg.attributes.position;
      for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) * (1 - 0.5 * Math.min(1, Math.max(0, p.getX(i) / span))));
    }
    const Zl = X.clone().cross(d);
    fg.applyMatrix4(new THREE.Matrix4().makeBasis(X, d, Zl).setPosition(A));
    fg.computeVertexNormals();
    addFlap('fwd' + LR, fg, A, B, out);
    // slim hinge fairing along the root on the leeward side of the flap
    const fh = teardrop(L + 0.8, 0.3, 0.1, 14);
    fh.scale(1, 1, 1.3);
    const lee = Zl.z > 0 ? Zl.clone().negate() : Zl.clone();
    const A2 = sp(yb - 0.5, -0.12).addScaledVector(lee, 0.2), B2 = sp(yt + 0.3, -0.12).addScaledVector(lee, 0.2);
    fh.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B2.clone().sub(A2).normalize()));
    fh.translate(A2.x, A2.y, A2.z);
    fParts.push(fh);
  }
  g.add(new THREE.Mesh(mergeGeometries(fParts.map((x) => (x.attributes.aTile ? x : restAttrs(x)))), flapMat));

  // ---- aft: heat shield floor, skirt interior, QD plate
  const floor = new THREE.CircleGeometry(R - 0.02, 96);
  floor.rotateX(Math.PI / 2);
  floor.translate(0, 0.9, 0);
  const skirtIn = new THREE.CylinderGeometry(R - 0.03, R - 0.03, 0.9, 96, 1, true);
  skirtIn.translate(0, 0.45, 0);
  g.add(new THREE.Mesh(merge([floor, skirtIn]), shieldMat));
  const qd = roundedBox(1.5, 2.1, 0.22, 0.12);
  qd.rotateY(Math.PI / 2);
  const QD_A = Math.PI / 2 - 0.35; // ship azimuth +0.35 rad from windward centre
  const qdParts = [prep(qd, radialMatrix(QD_A, R + 0.02, 3.3))];
  for (const dy of [-0.55, 0, 0.55]) {
    const port = new THREE.CylinderGeometry(0.16, 0.16, 0.12, 14);
    port.rotateZ(Math.PI / 2);
    qdParts.push(prep(port, radialMatrix(QD_A, R + 0.16, 3.3 + dy)));
  }
  g.add(new THREE.Mesh(merge(qdParts), dark));

  // ---- engines: 3 sea-level (centre) + 3 vacuum (outer, big bells)
  const layout = [];
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 + Math.PI / 2; layout.push([1.05 * Math.cos(a), 1.05 * Math.sin(a), 0, 'sl', -1.0]); }
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 - Math.PI / 2; layout.push([3.0 * Math.cos(a), 3.0 * Math.sin(a), 1, 'vac', -1.6]); }
  const engMat = engineMaterial();
  const engines = engineCluster(layout, (t) => (t === 'vac' ? raptorGeometry({ exitR: 1.15, bellLen: 2.5, throatR: 0.22, vac: true }) : raptorGeometry({ exitR: 0.65, bellLen: 1.7 })), engMat);
  engines.forEach((m) => g.add(m));

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return {
    group: g,
    materials: { tiles, flaps: flapMat },
    flaps,
    engines,
    layout,
    setGlow: glowSetter(engines),
  };
}
