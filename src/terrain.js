import * as THREE from 'three';
import { patchMaterial, shared } from './shared.js';

// Procedural Boca Chica: Gulf coast, beach & dunes, tidal flats with pools,
// South Bay lagoon, Rio Grande mouth, Brazos Santiago Pass & South Padre Island.
// Coordinates: x = east, z = south, pad at the origin. One unit = 1 m.

export const SURFACE_GLSL = /* glsl */ `
uniform float uOpen, uDeluge;
float shoreX(float z) {
  return 640.0 + 28.0 * sin(z * 0.0009 + 0.4) + 12.0 * sin(z * 0.0031) + max(0.0, -z - 8600.0) * 0.06;
}
float boxSDF(vec2 p, vec2 c, vec2 h) { vec2 d = abs(p - c) - h; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float ellip(vec2 p, vec2 c, vec2 r) { return length((p - c) / r) - 1.0; }

// returns x: water mask, y: ocean (waves), z: foam, w: surface class id encoded
struct Surf { float water; float ocean; float foam; vec3 albedo; float rough; float wet; float padSoot; };

Surf surface(vec2 p, float dist) {
  Surf s;
  float sx = shoreX(p.y);
  float dx = p.x - sx;
  float lod = clamp(dist / 2500.0, 0.0, 1.0);
  float n1 = fbm2(p * 0.0011, 5);
  float n2 = fbm2(p * 0.0042 + 7.0, 5 - int(lod * 2.0));
  float n3 = fbm2(p * 0.021 + 3.0, 4);
  float n4 = vnoise2(p * 0.12);

  // ---- water bodies (signed: >0 means water)
  float swash = 6.0 * sin(p.y * 0.05 + uTime * 0.6) * 0.5 + (n3 - 0.5) * 10.0;
  float ocean = smoothstep(-1.0, 1.5, dx - swash - 8.0);
  float pass = step(abs(p.y + 8250.0 + 120.0 * sin(p.x * 0.0012)), 260.0) * step(p.x, sx + 50.0);
  float madre = step(p.y, -8480.0) * step(p.x, sx - 850.0 - 200.0 * n1);
  float southBay = step(ellip(p, vec2(-2700.0, -4300.0), vec2(2500.0, 1900.0)) + (n1 - 0.5) * 0.9, 0.0);
  float riverY = 3500.0 + 260.0 * sin(p.x * 0.0011) + 120.0 * sin(p.x * 0.0041);
  float river = step(abs(p.y - riverY), 70.0 + 30.0 * n2) * step(p.x, sx);
  float fgPond = step(ellip(p, vec2(-2400.0, 900.0), vec2(1300.0, 430.0)) + (n2 - 0.5) * 0.8, 0.0);
  float nearPond = step(ellip(p, vec2(-700.0, 900.0), vec2(380.0, 260.0)) + (n2 - 0.5) * 1.3, 0.0);

  // tidal flats: pools, mud, vegetation
  float flats = smoothstep(-300.0, -420.0, dx) * (1.0 - step(p.y, -8000.0));
  float pf = n2 + 0.38 * (n1 - 0.5) + 0.12 * (n3 - 0.5);
  float pools = smoothstep(0.585, 0.6, pf) * flats;
  float mud = smoothstep(0.48, 0.56, pf) * flats;

  // pad complex (kept dry)
  float apron = boxSDF(p, vec2(10.0, -10.0), vec2(135.0, 150.0));
  float tankPad = boxSDF(p, vec2(-250.0, 110.0), vec2(95.0, 75.0));
  float gravel = min(boxSDF(p, vec2(-40.0, 40.0), vec2(170.0, 130.0)), boxSDF(p, vec2(150.0, -10.0), vec2(90.0, 90.0))) + (n3 - 0.5) * 70.0 + (n2 - 0.5) * 60.0;
  float dryZone = step(gravel, 40.0);

  // meandering tidal channels threading through the flats
  vec2 wq = p * 0.0011 + vec2(fbm2(p * 0.0007 + 11.0, 3), fbm2(p * 0.0007 + 23.0, 3)) * 1.6;
  float ridge = abs(fbm2(wq, 5) - 0.5);
  float chW = mix(0.012, 0.03, fbm2(p * 0.0005 + 5.0, 2));
  float channels = smoothstep(chW, chW * 0.55, ridge) * smoothstep(-380.0, -900.0, dx) * (1.0 - step(p.y, -8000.0));
  float ridge2 = abs(fbm2(wq * 3.1 + 7.7, 4) - 0.5);
  channels = max(channels, smoothstep(0.012, 0.006, ridge2) * flats * 0.9);
  float lw = max(max(max(pass, madre), max(southBay, river)), max(max(fgPond, nearPond), max(pools, channels)));
  lw *= 1.0 - dryZone;
  s.ocean = max(ocean, pass * step(-200.0, dx));
  s.water = max(lw, s.ocean);

  // ---- land albedo
  vec3 veg = mix(vec3(0.075, 0.09, 0.045), vec3(0.16, 0.14, 0.085), smoothstep(0.3, 0.7, n3));
  veg = mix(veg, vec3(0.2, 0.17, 0.11), smoothstep(0.55, 0.75, n2) * 0.6);
  veg = mix(veg, vec3(0.06, 0.08, 0.035), smoothstep(0.4, 0.8, n4) * (1.0 - lod));
  vec3 mudC = mix(vec3(0.24, 0.2, 0.15), vec3(0.34, 0.29, 0.22), n3);
  vec3 sand = mix(vec3(0.46, 0.41, 0.32), vec3(0.56, 0.5, 0.4), n3);
  vec3 wetSand = vec3(0.24, 0.21, 0.17);
  vec3 col = veg;
  float rough = 0.95;
  float wet = 0.0;
  col = mix(col, mudC, mud);
  wet = max(wet, mud * smoothstep(0.54, 0.6, pf) * 0.8);
  // salt-flat crust in the flats' higher ground
  col = mix(col, vec3(0.4, 0.36, 0.3), smoothstep(0.6, 0.78, n1) * flats * (1.0 - mud) * 0.7);

  // dunes & beach
  float dune = smoothstep(-300.0, -200.0, dx) * (1.0 - smoothstep(-90.0, -60.0, dx));
  col = mix(col, mix(sand, veg * 1.3, smoothstep(0.45, 0.6, n2 + n4 * 0.2)), dune);
  float beach = smoothstep(-90.0, -60.0, dx);
  float wetBand = smoothstep(-32.0, -10.0, dx - swash);
  col = mix(col, mix(sand, wetSand, wetBand), beach);
  wet = max(wet, wetBand * beach);

  // gravel / caliche around the launch site
  col = mix(col, mix(vec3(0.27, 0.25, 0.22), vec3(0.34, 0.32, 0.28), n4), dryZone * (1.0 - beach));
  // concrete apron & tank farm pad with slab joints
  float conc = step(apron, 0.0) + step(tankPad, 0.0);
  vec2 slab = abs(fract(p / 12.0) - 0.5);
  float joint = smoothstep(0.485, 0.495, max(slab.x, slab.y)) * (1.0 - lod);
  vec3 concC = mix(vec3(0.44, 0.43, 0.4), vec3(0.52, 0.51, 0.48), n4) * (1.0 - joint * 0.35);
  col = mix(col, concC, clamp(conc, 0.0, 1.0));
  rough = mix(rough, 0.8, clamp(conc, 0.0, 1.0));
  // scorching around the launch mount
  float rP = length(p);
  s.padSoot = smoothstep(90.0, 20.0, rP + (n3 - 0.5) * 30.0);
  col = mix(col, vec3(0.05, 0.045, 0.04), s.padSoot * 0.85);
  // flame deflector steel plate
  float plate = step(boxSDF(p, vec2(0.0), vec2(16.0)), 0.0);
  col = mix(col, vec3(0.12, 0.11, 0.1), plate);
  wet = max(wet, plate * 0.6 + s.padSoot * 0.3);

  // Highway 4 and site roads
  float roadZ = 250.0 + 40.0 * sin(p.x * 0.0006);
  float road = step(abs(p.y - roadZ), 5.0) * step(p.x, sx - 80.0);
  float access = step(abs(p.x + 60.0), 4.0) * step(p.y, roadZ) * step(0.0, p.y);
  float beachRoad = step(abs(p.x - (sx - 120.0)), 4.0) * step(p.y, roadZ) * step(-3000.0, p.y);
  float anyRoad = max(max(road, access), beachRoad);
  col = mix(col, vec3(0.045, 0.045, 0.045), anyRoad);
  rough = mix(rough, 0.7, anyRoad);

  // South Padre Island town (north of the pass)
  float town = step(p.y, -9200.0) * step(p.y, -9200.0) * step(sx - 780.0, p.x) * step(p.x, sx - 90.0);
  vec2 blk = fract(p / vec2(70.0, 55.0));
  float roof = step(0.18, blk.x) * step(0.2, blk.y);
  vec3 townC = mix(vec3(0.08, 0.08, 0.075), mix(vec3(0.3, 0.29, 0.27), vec3(0.45, 0.42, 0.38), hash12(floor(p / vec2(70.0, 55.0)))), roof);
  col = mix(col, townC, town * (1.0 - beach));

  s.foam = s.ocean * smoothstep(90.0, 0.0, dx) * smoothstep(0.35, 0.9, sin((dx + uTime * 3.0) * 0.18 + n3 * 5.0) * 0.5 + 0.5 + (n4 - 0.5) * 0.6);
  s.foam += s.ocean * smoothstep(14.0, 0.0, abs(dx - swash - 8.0)) * 0.8;
  s.foam = clamp(s.foam, 0.0, 1.0);
  // deluge water sheet spreading around the launch mount
  float sheet = uDeluge * smoothstep(62.0 + 25.0 * n3, 30.0, rP) * smoothstep(20.0, 26.0, rP);
  col = mix(col, vec3(0.82, 0.84, 0.85) * (0.75 + 0.3 * n4), sheet * smoothstep(0.35, 0.65, n4 + n3 * 0.4));
  wet = max(wet, sheet);
  s.albedo = col;
  s.rough = rough;
  s.wet = wet;
  if (uOpen > 0.5) {
    // open ocean far from any coast (splashdown zone)
    s.water = 1.0; s.ocean = 1.0; s.foam = 0.0; s.wet = 0.0; s.padSoot = 0.0;
    s.albedo = vec3(0.01, 0.03, 0.045);
  }
  return s;
}
`;

function terrainGeometry() {
  // polar grid: fine near the pad, exponentially coarser out to 220 km
  const radii = [0];
  let r = 4;
  while (r < 220000) { radii.push(r); r = r < 600 ? r + 8 : r * 1.045; }
  const seg = 320;
  const pos = [], idx = [];
  for (let i = 0; i < radii.length; i++) {
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * radii[i], 0, Math.sin(a) * radii[i]);
    }
  }
  for (let i = 0; i < radii.length - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j, b = i * seg + ((j + 1) % seg), c = (i + 1) * seg + j, d = (i + 1) * seg + ((j + 1) % seg);
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 230000);
  return g;
}

export function createTerrain() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const uniforms = { uReflStrength: { value: 1 }, uOpen: { value: 0 }, uDeluge: { value: 0 } };
  patchMaterial(
    mat,
    {
      key: 'terrain',
      vertexHead: 'varying vec2 vFlat;',
      vertexBegin: /* glsl */ `
        vFlat = (modelMatrix * vec4(transformed, 1.0)).xz;
        transformed.y -= dot(vFlat, vFlat) / (2.0 * 6371000.0);`,
      fragHead: /* glsl */ `
        varying vec2 vFlat;
        uniform sampler2D uReflection;
        uniform mat4 uReflMatrix;
        uniform vec3 uSunColor, uSkyAmb, uFlamePos, uFlameColor;
        uniform float uReflStrength;
        ${SURFACE_GLSL}
        Surf S;
        vec3 wN;`,
      fragMap: /* glsl */ `
        float camDist = length(vWorld - cameraPosition);
        S = surface(vFlat, camDist);
        diffuseColor.rgb = mix(S.albedo, vec3(0.75), S.foam);
      `,
      fragRough: /* glsl */ `roughnessFactor = mix(S.rough, 0.35, S.wet);`,
      fragNormal: /* glsl */ `
        {
          // micro relief for land, waves / ripples for water
          float e = 0.6;
          vec2 q = vFlat;
          float amp = mix(0.0, 1.0, 1.0 - clamp(camDist / 1500.0, 0.0, 1.0));
          float h0 = fbm2(q * 0.35, 3), hx = fbm2((q + vec2(e, 0.0)) * 0.35, 3), hz = fbm2((q + vec2(0.0, e)) * 0.35, 3);
          vec3 nl = normalize(vec3(-(hx - h0) * 0.9 * amp, 1.0, -(hz - h0) * 0.9 * amp));
          // water normal
          float t = uTime;
          vec2 w1 = q * vec2(0.045, 0.02) + vec2(t * 0.09, t * 0.02);
          vec2 w2 = q * vec2(0.13, 0.19) - vec2(t * 0.05, t * 0.12);
          float oceanAmp = mix(0.06, 0.32, S.ocean);
          float fade = 1.0 / (1.0 + camDist / 1200.0);
          float a0 = vnoise2(w1) + 0.5 * vnoise2(w2);
          float ax = vnoise2(w1 + vec2(0.045, 0.0) * 1.5) + 0.5 * vnoise2(w2 + vec2(0.13, 0.0) * 1.5);
          float az = vnoise2(w1 + vec2(0.0, 0.02) * 1.5) + 0.5 * vnoise2(w2 + vec2(0.0, 0.19) * 1.5);
          vec3 nw = normalize(vec3(-(ax - a0) * oceanAmp * 6.0 * fade, 1.0, -(az - a0) * oceanAmp * 6.0 * fade));
          wN = normalize(mix(nl, nw, S.water));
          normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
        }
      `,
      fragOut: /* glsl */ `
        if (S.water > 0.001) {
          vec3 V = normalize(cameraPosition - vWorld);
          float cosT = max(dot(wN, V), 0.0);
          float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
          vec4 rc = uReflMatrix * vec4(vWorld, 1.0);
          vec2 ruv = rc.xy / rc.w + wN.xz * mix(0.03, 0.06, S.ocean) / (1.0 + camDist * 0.0004);
          vec3 refl = texture2D(uReflection, clamp(ruv, 0.001, 0.999)).rgb;
          vec3 body = mix(vec3(0.03, 0.03, 0.02), vec3(0.006, 0.025, 0.035), max(S.ocean, 0.5)) * (uSkyAmb + uSunColor * max(uSunDir.y, 0.0) * 0.3);
          // flame light scattering in the water body near the pad
          vec3 toF = uFlamePos - vWorld;
          body += uFlameColor * 0.02 / (dot(toF, toF) + 400.0) * (1.0 - F);
          // sun glint (GGX)
          vec3 H = normalize(uSunDir + V);
          float nh = max(dot(wN, H), 0.0);
          float a2 = mix(0.004, 0.02, S.ocean);
          float d = nh * nh * (a2 - 1.0) + 1.0;
          float D = a2 / (3.14159 * d * d);
          vec3 glint = uSunColor * D * F * max(dot(wN, uSunDir), 0.0) * 0.25;
          vec3 wcol = body * (1.0 - F) + refl * F * uReflStrength + glint;
          gl_FragColor.rgb = mix(gl_FragColor.rgb, wcol, S.water * (1.0 - S.foam));
        } else if (S.wet > 0.01) {
          vec3 V = normalize(cameraPosition - vWorld);
          float F = 0.02 + 0.98 * pow(1.0 - max(dot(wN, V), 0.0), 5.0);
          vec4 rc = uReflMatrix * vec4(vWorld, 1.0);
          vec3 refl = texture2D(uReflection, clamp(rc.xy / rc.w + wN.xz * 0.05, 0.001, 0.999)).rgb;
          gl_FragColor.rgb += refl * F * S.wet * 0.6;
        }
      `,
    },
    uniforms
  );
  const mesh = new THREE.Mesh(terrainGeometry(), mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  mesh.userData.uniforms = uniforms;
  return mesh;
}
