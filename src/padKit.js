import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from './shared.js';

// Shared building blocks for the launch site: instanced beam builder, member
// profiles and the procedural (shader-only) materials.

export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _q = new THREE.Quaternion(), _up = V(0, 1, 0), _basis = new THREE.Matrix4();

// ------------------------------------------------------------ profiles
export const GEO = {};
GEO.box = new THREE.BoxGeometry(1, 1, 1);
// wide-flange I-beam, unit length along Y; x = flange width, z = depth (web)
GEO.ibeam = (() => {
  const f = 0.15, web = 0.12;
  const a = new THREE.BoxGeometry(1, 1, f).translate(0, 0, 0.5 - f / 2);
  const b = new THREE.BoxGeometry(1, 1, f).translate(0, 0, -0.5 + f / 2);
  const c = new THREE.BoxGeometry(web, 1, 1 - 2 * f);
  return mergeGeometries([a, b, c]);
})();
// channel / angle section for light members
GEO.angle = (() => {
  const t = 0.2;
  const a = new THREE.BoxGeometry(1, 1, t).translate(0, 0, 0.5 - t / 2);
  const b = new THREE.BoxGeometry(t, 1, 1).translate(0.5 - t / 2, 0, 0);
  return mergeGeometries([a, b]);
})();
GEO.cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1, false);
GEO.cylLo = new THREE.CylinderGeometry(0.5, 0.5, 1, 7, 1, true);

// ------------------------------------------------------------ builders
export class BeamBuilder {
  constructor() { this.list = []; }
  // member from a to b with section w x d. `side` sets the local x axis
  // (flange width direction); defaults to something stable.
  beam(a, b, w, d = w, side = null) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.divideScalar(len);
    let s = side;
    if (!s) s = Math.abs(dir.y) > 0.95 ? V(1, 0, 0) : V(-dir.z, 0, dir.x);
    const x = s.clone().addScaledVector(dir, -s.dot(dir));
    if (x.lengthSq() < 1e-8) _q.setFromUnitVectors(_up, dir);
    else {
      x.normalize();
      const z = new THREE.Vector3().crossVectors(x, dir);
      _basis.makeBasis(x, dir, z);
      _q.setFromRotationMatrix(_basis);
    }
    const c = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    this.list.push(new THREE.Matrix4().compose(c, _q.clone(), V(w, len, d)));
  }
  block(c, sx, sy, sz, rotY = 0) {
    _q.setFromAxisAngle(_up, rotY);
    this.list.push(new THREE.Matrix4().compose(c.clone(), _q.clone(), V(sx, sy, sz)));
  }
  // oriented box: centre, size, quaternion
  obox(c, sx, sy, sz, q) { this.list.push(new THREE.Matrix4().compose(c.clone(), q.clone(), V(sx, sy, sz))); }
  build(material, geo = GEO.box, shadow = true) {
    const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, this.list.length));
    this.list.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.count = this.list.length;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

// ------------------------------------------------------------ materials
const VHEAD = /* glsl */ `varying float vInst; varying vec3 vLoc;`;
const VBEGIN = /* glsl */ `
  vInst = 0.0; vLoc = position;
  #ifdef USE_INSTANCING
    vInst = float(gl_InstanceID);
    vLoc = position * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  #endif`;

const FHEAD = /* glsl */ `
  varying float vInst; varying vec3 vLoc;
  // exhaust soot / heat around the launch mount (world space)
  float padSoot(vec3 p, vec3 wn) {
    float r = length(p.xz);
    vec3 toAx = -vec3(p.x, 0.0, p.z) / max(r, 1e-3);
    float facing = clamp(dot(wn, toAx), 0.0, 1.0);
    float down = clamp(-wn.y, 0.0, 1.0);
    float n = fbm3(p * vec3(0.22, 0.45, 0.22), 3);
    float n2 = fbm3(p * vec3(0.9, 0.25, 0.9), 2);
    // blast flowing outward over the plate and up the plume-facing surfaces
    float ground = smoothstep(34.0, 8.0, r + (n - 0.5) * 16.0) * smoothstep(9.0 + 9.0 * n, 0.3, p.y);
    ground *= 0.2 + 0.8 * max(facing, down);
    // inside of the table opening & its underside: heavily blackened
    float table = smoothstep(9.5, 5.2, r) * step(p.y, 21.0) * (0.5 + 0.5 * max(facing, down));
    float under = smoothstep(12.0, 7.0, r) * down * step(p.y, 21.0);
    float s = max(ground * 0.6, max(table, under * 0.8));
    return clamp(s * (0.6 + 0.8 * n) * (0.75 + 0.5 * n2), 0.0, 1.0);
  }
  float vStreak(vec3 p, float f) {
    return fbm3(vec3(p.x * f + p.z * f * 0.8, p.y * 0.09, p.z * f - p.x * f * 0.3), 3);
  }
  vec3 worldN(vec3 nv) { return normalize((vec4(nv, 0.0) * viewMatrix).xyz); }
`;

function padMaterial(params, key, body, extra = {}) {
  const m = new THREE.MeshStandardMaterial(params);
  return patchMaterial(m, {
    key: 'pad-' + key,
    vertexHead: VHEAD,
    vertexBegin: VBEGIN,
    fragHead: FHEAD + (extra.fragHead || ''),
    fragNormal: extra.fragNormal,
    fragEmissive: `{ vec3 wn = worldN(normal); vec3 P = vWorld; ${body} }`,
  });
}

export function createMaterials() {
  const M = {};

  // Dark-grey painted structural steel of the tower (weathered, rust-streaked)
  M.tower = padMaterial({ color: 0x4d4b49, roughness: 0.7, metalness: 0.3 }, 'tower', /* glsl */ `
    float iv = hash11(vInst * 1.37 + 3.1);
    float sec = hash11(floor(P.y / 15.0) + 7.0);
    vec3 c = diffuseColor.rgb * (0.78 + 0.22 * iv + 0.18 * sec);
    float blot = fbm3(P * 0.45, 3);
    c *= 0.85 + 0.3 * blot;
    // rust bleeding down from joints & up-facing flanges
    float st = vStreak(P, 1.9);
    float rust = smoothstep(0.52, 0.78, st) * 0.55 + smoothstep(0.4, 0.9, wn.y) * smoothstep(0.45, 0.7, blot) * 0.6;
    rust *= 0.6 + 0.8 * iv;
    c = mix(c, vec3(0.2, 0.085, 0.035), clamp(rust, 0.0, 0.8));
    // paint chipping / lighter primer on edges of members
    float soot = padSoot(P, wn);
    c = mix(c, vec3(0.025, 0.022, 0.02), soot * 0.8);
    diffuseColor.rgb = c;
    roughnessFactor = clamp(0.62 + 0.25 * blot - rust * 0.1, 0.3, 0.95);
    metalnessFactor = mix(0.35, 0.1, rust);
  `);

  // Weathered hot-dip galvanized steel: stairs, grating, rails, pipe racks
  M.galv = padMaterial({ color: 0x9c9e9c, roughness: 0.5, metalness: 0.45 }, 'galv', /* glsl */ `
    float sp = vnoise3(P * 7.0);
    float blot = fbm3(P * 0.6 + vInst * 0.13, 3);
    vec3 c = diffuseColor.rgb * (0.75 + 0.2 * sp + 0.3 * blot);
    float white = smoothstep(0.6, 0.85, fbm3(P * 1.7, 2));
    c = mix(c, vec3(0.62, 0.62, 0.6), white * 0.4);
    float rust = smoothstep(0.62, 0.85, vStreak(P, 2.5)) * 0.4;
    c = mix(c, vec3(0.22, 0.1, 0.05), rust);
    float soot = padSoot(P, wn);
    c = mix(c, vec3(0.03), soot * 0.85);
    diffuseColor.rgb = c;
    roughnessFactor = 0.38 + 0.35 * blot + white * 0.2;
    metalnessFactor = mix(0.5, 0.2, max(white, rust));
  `);

  // Concrete (OLM legs, foundations) with form lines, streaks & soot
  M.conc = padMaterial({ color: 0xaaa69e, roughness: 0.9, metalness: 0.0 }, 'conc', /* glsl */ `
    float n1 = fbm3(P * 0.5, 3);
    float n2 = vnoise3(P * 5.0);
    float big = fbm3(P * 0.08 + 5.0, 2);
    vec3 c = diffuseColor.rgb * (0.78 + 0.3 * n1 + 0.08 * n2) * (0.85 + 0.3 * big);
    // warm/cool tint of different pours
    c *= mix(vec3(1.03, 1.0, 0.95), vec3(0.95, 0.98, 1.02), smoothstep(0.35, 0.65, big));
    float vert = step(abs(wn.y), 0.6);
    float lift = abs(fract(P.y / 1.52) - 0.5);
    c *= 1.0 - 0.1 * smoothstep(0.47, 0.5, lift) * vert;
    // run-off streaks and damp foot
    float st = smoothstep(0.45, 0.8, vStreak(P, 1.1));
    c *= 1.0 - 0.28 * st * vert;
    c = mix(c, vec3(0.26, 0.15, 0.08), smoothstep(0.7, 0.9, vStreak(P + 11.0, 1.6)) * 0.3 * vert);
    c *= 1.0 - 0.25 * smoothstep(2.5, 0.0, P.y) * (0.5 + 0.5 * n1);
    // chipped edges read lighter
    float soot = padSoot(P, wn);
    c = mix(c, vec3(0.035, 0.032, 0.03), soot * 0.85);
    diffuseColor.rgb = c;
    roughnessFactor = 0.85 + 0.1 * n2 - soot * 0.15;
  `, {
    fragNormal: /* glsl */ `
      {
        vec3 q = vWorld * 3.0;
        float e = 0.08;
        float h0 = vnoise3(q);
        vec3 gr = vec3(vnoise3(q + vec3(e, 0.0, 0.0)) - h0, vnoise3(q + vec3(0.0, e, 0.0)) - h0, vnoise3(q + vec3(0.0, 0.0, e)) - h0) / e;
        normal = normalize(normal - (viewMatrix * vec4(gr * 0.035, 0.0)).xyz);
      }`,
  });

  // Launch-table steel: light grey, heat-tinted and sooted near the opening
  const OLM_BODY = /* glsl */ `
    float iv = hash11(vInst * 2.1 + 0.3);
    float blot = fbm3(P * 0.5, 3);
    vec3 c = diffuseColor.rgb * (0.82 + 0.18 * iv + 0.25 * blot);
    float r = length(P.xz);
    // heat tint (straw / blue) near the engines
    float heat = smoothstep(8.5, 5.0, r) * smoothstep(14.0, 18.0, P.y);
    c = mix(c, mix(vec3(0.3, 0.2, 0.1), vec3(0.08, 0.09, 0.13), blot), heat * 0.6);
    float rust = smoothstep(0.58, 0.82, vStreak(P, 1.6)) * 0.35 + smoothstep(0.65, 0.9, blot) * 0.2;
    c = mix(c, vec3(0.26, 0.12, 0.05), rust);
    float soot = padSoot(P, wn);
    c = mix(c, vec3(0.03, 0.028, 0.026), soot);
    diffuseColor.rgb = c;
    roughnessFactor = 0.5 + 0.3 * blot + soot * 0.2;
    metalnessFactor = mix(0.45, 0.1, max(soot, rust));
  `;
  M.olm = padMaterial({ color: 0x9a9892, roughness: 0.55, metalness: 0.45 }, 'olm', OLM_BODY);
  M.olm2 = padMaterial({ color: 0x9a9892, roughness: 0.55, metalness: 0.45, side: THREE.DoubleSide }, 'olm2', OLM_BODY);

  // Water-cooled steel deflector plate ("upside-down shower head")
  M.plate = padMaterial({ color: 0x3a3632, roughness: 0.3, metalness: 0.6 }, 'plate', /* glsl */ `
    float blot = fbm3(P * 0.3, 4);
    vec3 c = diffuseColor.rgb * (0.7 + 0.5 * blot);
    float rs = smoothstep(0.4, 0.72, fbm3(P * 0.9 + 3.0, 3));
    c = mix(c, vec3(0.3, 0.13, 0.05), rs * 0.85);
    // nozzle holes on a staggered grid (top surface)
    vec2 g = P.xz / 0.75;
    g.x += 0.5 * mod(floor(g.y), 2.0);
    vec2 f = fract(g) - 0.5;
    float fw = fwidth(g.x) * 1.5;
    float hole = (1.0 - smoothstep(0.1 - fw, 0.14 + fw, length(f))) * step(0.7, wn.y) * (1.0 - smoothstep(0.2, 0.5, fw));
    c = mix(c, vec3(0.01), hole * 0.9);
    // seams between plate segments
    vec2 s = abs(fract(P.xz / 4.0) - 0.5);
    c *= 1.0 - 0.4 * smoothstep(0.485, 0.5, max(s.x, s.y));
    float soot = padSoot(P, wn);
    c = mix(c, vec3(0.02), soot * 0.5);
    diffuseColor.rgb = c;
    float wet = smoothstep(0.35, 0.6, fbm3(P * 0.15, 2));
    roughnessFactor = mix(0.6 + 0.2 * rs, 0.28, wet);
    metalnessFactor = mix(0.35, 0.1, rs);
  `);

  // Corrugated / ribbed cladding sheet (tower base shielding, buildings)
  M.clad = padMaterial({ color: 0x77766f, roughness: 0.55, metalness: 0.55 }, 'clad', /* glsl */ `
    float blot = fbm3(P * 0.35, 3);
    vec3 c = diffuseColor.rgb * (0.8 + 0.35 * blot);
    float st = smoothstep(0.5, 0.8, vStreak(P, 1.2));
    c = mix(c, vec3(0.22, 0.12, 0.06), st * 0.4);
    // panel joints
    float pj = smoothstep(0.48, 0.5, abs(fract(P.y / 3.0) - 0.5));
    c *= 1.0 - 0.35 * pj;
    float soot = padSoot(P, wn);
    c = mix(c, vec3(0.03), soot * 0.85);
    diffuseColor.rgb = c;
    roughnessFactor = 0.45 + 0.3 * blot;
  `, {
    fragNormal: /* glsl */ `
      {
        vec3 wn0 = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
        vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), wn0) + 1e-4);
        float u = dot(vWorld, t) * 6.2831 / 0.25;
        float k = step(abs(wn0.y), 0.6) * 0.35;
        normal = normalize(normal + (viewMatrix * vec4(t * cos(u) * k, 0.0)).xyz);
      }`,
  });

  // Stainless-steel GSE tanks (welded rings)
  M.tank = padMaterial({ color: 0xc9c9c7, roughness: 0.3, metalness: 1.0 }, 'tank', /* glsl */ `
    float ringF = fract(P.y / 1.83);
    float weld = 1.0 - smoothstep(0.0, 0.02 + fwidth(P.y) * 0.6, abs(ringF - 0.5) * 1.83 - 0.88);
    float sheet = hash12(vec2(floor(P.y / 1.83), floor(atan(vLoc.z, vLoc.x) * 0.9549) + vInst));
    vec3 c = diffuseColor.rgb * (0.88 + 0.14 * sheet);
    c = mix(c, vec3(0.42, 0.4, 0.37), weld * 0.7);
    float st = smoothstep(0.5, 0.85, vStreak(P, 0.9));
    c = mix(c, vec3(0.35, 0.3, 0.24), st * 0.3);
    diffuseColor.rgb = c;
    roughnessFactor = 0.22 + 0.2 * sheet + st * 0.15 + weld * 0.2;
  `);

  // White-painted tanks & insulated pipes
  M.white = padMaterial({ color: 0xd4d3cd, roughness: 0.6, metalness: 0.05 }, 'white', /* glsl */ `
    float blot = fbm3(P * 0.4, 3);
    vec3 c = diffuseColor.rgb * (0.85 + 0.2 * blot);
    c = mix(c, vec3(0.4, 0.3, 0.2), smoothstep(0.55, 0.85, vStreak(P, 1.3)) * 0.35);
    float soot = padSoot(P, wn);
    c = mix(c, vec3(0.05), soot * 0.8);
    diffuseColor.rgb = c;
  `);

  // plain buildings (legacy look)
  M.bldg = padMaterial({ color: 0x9a9892, roughness: 0.7, metalness: 0.2 }, 'bldg', /* glsl */ `
    float n = fbm3(P * vec3(0.35, 0.08, 0.35), 3);
    diffuseColor.rgb *= 0.8 + 0.4 * n;
  `);

  // red aviation obstruction lights
  M.light = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.35, 0.15) });
  return M;
}

// ------------------------------------------------------------ geometry utils
// Box tapering from (bw, bd) at y=0 to (tw, td) at y=h, top shifted by (sx, sz).
export function taperedBox(bw, bd, tw, td, h, sx = 0, sz = 0) {
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const top = p.getY(i) > 0;
    p.setXYZ(i, p.getX(i) * (top ? tw : bw) + (top ? sx : 0), top ? h : 0, p.getZ(i) * (top ? td : bd) + (top ? sz : 0));
  }
  g.computeVertexNormals();
  return g;
}

// Solid of revolution of a closed polyline profile [[r, y], ...] with flat
// (per-segment) normals; traverse the profile counter-clockwise in the (r, y)
// plane (normals point to the right of the direction of travel).
export function latheFlat(profile, segments = 64) {
  const parts = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, y0] = profile[i], [r1, y1] = profile[i + 1];
    const pts = [new THREE.Vector2(r0, y0), new THREE.Vector2(r1, y1)];
    const g = new THREE.LatheGeometry(pts, segments);
    parts.push(g.index ? g.toNonIndexed() : g);
  }
  const m = mergeGeometries(parts);
  return m;
}

export { mergeGeometries };
