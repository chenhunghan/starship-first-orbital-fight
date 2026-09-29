// GLSL snippets for the procedural Starship / Super Heavy materials (used only by vehicle.js).

// Common helpers: anti-aliased lines, derivative bump mapping, stainless skin, frost.
export const VCOMMON = /* glsl */ `
// Box-filtered line of half width hw at distance d, pixel footprint fw (all metres).
// Keeps the line's energy constant when it gets thinner than a pixel -> no shimmer.
float lineAA(float d, float hw, float fw) {
  float W = max(hw, fw);
  return (1.0 - smoothstep(W - fw * 0.5, W + fw * 0.5, d)) * (hw / W);
}
// Screen-space derivative bump mapping (Mikkelsen) with a height in metres.
vec3 bumpN(vec3 n, float h, float fd) {
  vec3 p = -vViewPosition;
  vec3 sx = dFdx(p), sy = dFdy(p);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * fd;
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 g = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - g);
}
// ---- 304L stainless skin: 1.83 m rings, 3 sheets per ring, welds, heat tint, quilting
float skWeld, skHaz, skPanel, skH, skRing, skRF;
void steelSkin(vec3 p, float rad, float fwM) {
  float ang = atan(p.x, p.z);
  const float rH = 1.83;
  float rIdx = floor(p.y / rH);
  float rF = fract(p.y / rH);
  float dW = min(rF, 1.0 - rF) * rH;
  float off = hash11(rIdx * 1.37 + 0.5);
  float su = (ang / 6.28318 + 0.5 + off) * 3.0;
  float fs = fract(su);
  float dV = min(fs, 1.0 - fs) * 6.28318 * rad / 3.0;
  skWeld = max(lineAA(dW, 0.011, fwM), lineAA(dV, 0.009, fwM));
  skHaz = max(lineAA(dW, 0.05, fwM), lineAA(dV, 0.04, fwM));
  skPanel = hash12(vec2(rIdx, mod(floor(su), 3.0)));
  skRing = rIdx; skRF = rF;
  float near = 1.0 - smoothstep(0.004, 0.02, fwM);
  float bead = exp(-dW * dW / 0.00015) + exp(-dV * dV / 0.0001);
  skH = 0.0012 * bead * near
      + 0.0025 * sin(rF * 3.14159)
      + 0.010 * (vnoise3(p * vec3(0.8, 1.25, 0.8)) - 0.5)
      + 0.003 * (vnoise3(p * vec3(2.6, 0.7, 2.6) + 5.0) - 0.5) * (1.0 - smoothstep(0.02, 0.1, fwM));
}
vec3 steelColor(vec3 base) {
  vec3 c = base * (0.93 + 0.1 * skPanel);
  // heat-affected zone next to the welds: faint straw/bronze tint, bead slightly darker
  c = mix(c, c * vec3(1.02, 0.9, 0.74), skHaz * 0.55);
  c = mix(c, vec3(0.36, 0.34, 0.32), skWeld * 0.65);
  return c;
}
// frost/ice: near-total coverage when fully loaded, with vertical drips/streaks,
// per-ring banding and bare patches; thins out as zone drops
float frostMask(vec3 p, float zone, float ring) {
  if (zone <= 0.001) return 0.0;
  float n1 = fbm3(p * vec3(0.5, 0.1, 0.5), 4);
  float st = vnoise3(p * vec3(4.0, 0.25, 4.0));
  float n2 = vnoise3(p * vec3(6.0, 1.6, 6.0));
  float ringB = (hash11(ring * 3.1 + 1.0) - 0.5) * 0.1;
  float t = n1 + 0.14 * n2 + 0.22 * st + ringB;
  float thr = 0.84 - 0.42 * zone;
  return smoothstep(thr - 0.1, thr + 0.08, t);
}
vec3 frostColor(vec3 p) {
  float a = vnoise3(p * vec3(4.0, 9.0, 4.0));
  float b = vnoise3(p * vec3(0.9, 0.2, 0.9));
  // melt-water runs: thin darker vertical streaks
  float r = smoothstep(0.72, 0.9, vnoise3(p * vec3(7.0, 0.18, 7.0)));
  vec3 c = mix(vec3(0.72, 0.76, 0.82), vec3(0.86, 0.89, 0.93), a) * (0.9 + 0.14 * b);
  return c * (1.0 - 0.3 * r);
}
// incandescent tile colour for a normalised temperature t (0 = cold, 1 = ~1400 C)
vec3 heatGlow(float t) {
  t = clamp(t, 0.0, 1.3);
  vec3 c = mix(vec3(0.45, 0.02, 0.0), vec3(1.0, 0.28, 0.03), smoothstep(0.05, 0.55, t));
  c = mix(c, vec3(1.0, 0.72, 0.35), smoothstep(0.55, 0.95, t));
  c = mix(c, vec3(1.0, 0.93, 0.8), smoothstep(0.95, 1.3, t));
  return c * (0.15 + 60.0 * t * t * t * t);
}
`;

// Voronoi of row-quantised hexagonal tiles on a body of revolution.
// s: meridian arc length (m), ang: azimuth (0 = windward), rad: local radius,
// slope: d(rad)/ds. Rows keep an integer tile count so the pattern closes and
// stays undistorted on the tapering nose (like the real tile map).
export const TILE_GLSL = /* glsl */ `
const float TP = 0.25;
const float TH = TP * 0.8660254;
vec2 tcId; vec2 tcCenter; float tcEdge; vec2 tcRel;
void tileCells(float s, float ang, float rad, float slope) {
  float j0 = floor(s / TH + 0.5);
  vec2 q[6]; vec2 ids[6]; vec2 ctr[6];
  for (int dj = -1; dj <= 1; dj++) {
    float j = j0 + float(dj);
    float sRow = j * TH;
    float radRow = max(rad + slope * (sRow - s), 0.02);
    float N = max(floor(6.28318 * radRow / TP + 0.5), 3.0);
    float off = mod(j, 2.0) * 0.5 + (N < 100.0 ? hash11(j) : 0.0);
    float u = (ang / 6.28318 + 0.5) * N - off;
    float k = floor(u);
    float k2 = k + (fract(u) > 0.5 ? 1.0 : -1.0);
    for (int c = 0; c < 2; c++) {
      float kk = c == 0 ? k : k2;
      float ac = ((kk + 0.5 + off) / N - 0.5) * 6.28318;
      float dA = ang - ac;
      dA -= 6.28318 * floor(dA / 6.28318 + 0.5);
      int idx = (dj + 1) * 2 + c;
      q[idx] = vec2(-dA * rad, sRow - s);
      ids[idx] = vec2(mod(kk, N), j);
      ctr[idx] = vec2(ac, sRow);
    }
  }
  int b = 0; float bd = 1e9;
  for (int i = 0; i < 6; i++) { float d = dot(q[i], q[i]); if (d < bd) { bd = d; b = i; } }
  float e = 1e9;
  for (int i = 0; i < 6; i++) {
    if (i == b) continue;
    vec2 dq = q[i] - q[b];
    float L = length(dq);
    if (L < 1e-4) continue;
    e = min(e, (dot(q[i], q[i]) - bd) / (2.0 * L));
  }
  tcId = ids[b]; tcCenter = ctr[b]; tcEdge = e; tcRel = -q[b];
}
// Regular pointy-top hex grid in a plane (flaps). Returns cell id; edge distance in tcEdge.
vec2 hexPlane(vec2 p) {
  const vec2 rr = vec2(TP, TP * 1.7320508);
  vec2 h = rr * 0.5;
  vec2 a = mod(p, rr) - h;
  vec2 b = mod(p - h, rr) - h;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  vec2 ap = abs(gv);
  float d = max(dot(ap, vec2(0.5, 0.8660254)), ap.x);
  tcEdge = TP * 0.5 - d;
  tcRel = gv;
  return floor((p - gv) / h + 0.5);
}
// Shading of one tile given its id, edge distance and pixel footprint.
float tlV, tlGap;
vec3 tileColor(vec2 id, float edge, float fwM) {
  tlV = hash12(id + 7.0);
  float v2 = hash12(id * 1.7 + 3.1);
  vec3 c = vec3(0.026 + 0.014 * tlV) * vec3(1.0, 0.98, 0.95);
  // a few lighter replacement tiles and brownish ones
  c = mix(c, vec3(0.075, 0.072, 0.068), step(0.99, v2));
  c = mix(c, vec3(0.05, 0.04, 0.032), step(0.965, v2) * step(v2, 0.985));
  c = mix(c, vec3(0.16, 0.155, 0.15), step(0.9993, tlV));
  float g = lineAA(edge, 0.007, fwM);
  float avg = 4.0 * 0.007 / TP;
  tlGap = mix(g, avg, smoothstep(0.18, 0.45, fwM / TP));
  return mix(c, vec3(0.008), tlGap * 0.85);
}
`;
