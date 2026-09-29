// Shared GLSL snippets: hashing/noise, atmosphere scattering, aerial perspective.

export const NOISE = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float fbm2(vec2 p, int oct) {
  float a = 0.5, s = 0.0;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * vnoise2(p); p = r * p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
float fbm3(vec3 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vnoise3(p); p = p * 2.02 + vec3(11.3, 7.1, 3.7); a *= 0.5; }
  return s;
}
`;

// Physically based single scattering atmosphere (Rayleigh + Mie + ozone).
// Units: metres. Radiance is relative to a sun "irradiance" of SUN_I.
export const ATMOS = /* glsl */ `
#define PLANET_R 6371000.0
#define ATMOS_R 6471000.0
#define SUN_I 22.0
const vec3 BETA_R = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const vec3 BETA_OZ = vec3(0.650e-6, 1.881e-6, 0.085e-6);
uniform float uMieBeta;   // ~ 2.1e-5 (clean) .. 6e-5 (hazy coastal)
uniform float uMieH;      // ~ 1200 m
#define MIE_G 0.78
#define MS_K 0.06

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e20, -1e20);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
float phaseRayleigh(float mu) { return 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu); }
float phaseMie(float mu, float g) {
  float gg = g * g;
  return 3.0 / (8.0 * 3.14159265) * ((1.0 - gg) * (1.0 + mu * mu)) / ((2.0 + gg) * pow(1.0 + gg - 2.0 * g * mu, 1.5));
}
vec3 densities(float h) {
  float oz = max(0.0, 1.0 - abs(h - 25000.0) / 15000.0);
  return vec3(exp(-h / 8000.0), exp(-h / uMieH), oz);
}
vec3 extinction(vec3 od) { return BETA_R * od.x + uMieBeta * 1.11 * od.y + BETA_OZ * od.z; }

// optical depth toward the sun (8-step midpoint rule); baked into uTransLUT by sky.js
vec3 sunOpticalDepth(vec3 p, vec3 sunDir) {
  vec2 ta = raySphere(p, sunDir, ATMOS_R);
  float seg = ta.y / 8.0;
  vec3 od = vec3(0.0);
  for (int j = 0; j < 8; j++) {
    vec3 q = p + sunDir * seg * (float(j) + 0.5);
    od += densities(length(q) - PLANET_R) * seg;
  }
  return od;
}
// LUT parameterisation: sqrt(altitude / 100 km), sun cosine with sqrt spacing (dense near the horizon)
#define TRANS_LUT vec2(128.0, 512.0)
vec2 transLutCoord(float h, float mu) {
  return vec2(sqrt(clamp(h / (ATMOS_R - PLANET_R), 0.0, 1.0)), 0.5 + 0.5 * sign(mu) * sqrt(abs(mu)));
}
#ifdef TRANS_LUT_BAKE
  vec3 sunTransmittance(vec3 p, vec3 sunDir) { return exp(-extinction(sunOpticalDepth(p, sunDir))); }
#else
  uniform sampler2D uTransLUT;
  vec3 sunTransmittance(vec3 p, vec3 sunDir) {
    vec2 tp = raySphere(p, sunDir, PLANET_R - 200.0);
    if (tp.x > 0.0) return vec3(0.0);
    float r = length(p);
    vec2 c = transLutCoord(r - PLANET_R, dot(p, sunDir) / r);
    return exp(-extinction(textureLod(uTransLUT, (c * (TRANS_LUT - 1.0) + 0.5) / TRANS_LUT, 0.0).xyz));
  }
#endif

// Returns inscattered radiance along ray, and transmittance in .w of out param
vec3 atmosphere(vec3 ro, vec3 rd, vec3 sunDir, float tMaxIn, out vec3 transmit, int steps) {
  vec2 ta = raySphere(ro, rd, ATMOS_R);
  transmit = vec3(1.0);
  if (ta.x > ta.y || ta.y < 0.0) return vec3(0.0);
  vec2 tp = raySphere(ro, rd, PLANET_R);
  float t0 = max(ta.x, 0.0);
  float t1 = ta.y;
  if (tp.x > 0.0) t1 = min(t1, tp.x);
  t1 = min(t1, tMaxIn);
  float seg = (t1 - t0) / float(steps);
  float mu = dot(rd, sunDir);
  float pr = phaseRayleigh(mu), pm = phaseMie(mu, MIE_G);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0), sumMs = vec3(0.0);
  vec3 od = vec3(0.0);
  float L = t1 - t0;
  float fs = float(steps);
  for (int i = 0; i < 32; i++) {
    if (i >= steps) break;
    // quadratic step distribution: dense near the viewer where most light is scattered
    float a0 = float(i) / fs, a1 = (float(i) + 1.0) / fs;
    float ta = L * a0 * a0, tb = L * a1 * a1;
    seg = tb - ta;
    vec3 p = ro + rd * (t0 + 0.5 * (ta + tb));
    float h = length(p) - PLANET_R;
    vec3 dens = densities(h) * seg;
    od += dens;
    vec3 tSun = sunTransmittance(p, sunDir);
    vec3 att = exp(-extinction(od)) * tSun;
    sumR += att * dens.x;
    sumM += att * dens.y;
    // multiple scattering source: roughly isotropic, fed by the whole sky rather than the direct sun
    sumMs += exp(-extinction(od)) * (dens.x * BETA_R + dens.y * uMieBeta * 0.5) * mix(vec3(1.0), tSun, 0.5);
  }
  transmit = exp(-extinction(od));
  vec3 ms = sumMs * MS_K * clamp(sunDir.y + 0.12, 0.0, 1.2);
  return SUN_I * (sumR * BETA_R * pr + sumM * uMieBeta * pm + ms);
}
`;

// Aerial perspective for scene geometry. Uses analytic optical depth of
// exponential Rayleigh/Mie profiles along a straight ray (flat-earth), with an
// inscatter colour computed from the sun colour at low altitude.
export const AERIAL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uAerialSun;     // sun irradiance reaching the lower atmosphere
uniform vec3 uAerialAmb;     // sky ambient for multiple scattering
uniform float uAerialMie;    // mie beta
uniform float uAerialMieH;
uniform float uAerialScale;  // artistic multiplier (1 = physical)
uniform vec3 uHorizon[16];   // sky radiance just above the horizon, by azimuth
vec3 horizonColor(vec3 rd) {
  float a = (atan(rd.z, rd.x) / 6.2831853 + 0.5) * 16.0;
  int i0 = int(floor(a)) % 16;
  int i1 = (i0 + 1) % 16;
  return mix(uHorizon[i0], uHorizon[i1], fract(a));
}

float odExp(float h0, float dy, float L, float H) {
  float e0 = exp(-max(h0, 0.0) / H);
  if (abs(dy) < 1e-4) return L * e0;
  float k = L * dy / H;
  return H * e0 * (1.0 - exp(-k)) / dy;
}
vec3 aerialTransmit;
vec3 aerialT(vec3 wp, vec3 camPos) {
  vec3 d = wp - camPos;
  float L = length(d) * uAerialScale;
  vec3 rd = d / max(length(d), 1e-3);
  float odR = odExp(camPos.y, rd.y, L, 8000.0);
  float odM = odExp(camPos.y, rd.y, L, uAerialMieH);
  return exp(-(vec3(5.802e-6, 13.558e-6, 33.1e-6) * odR + vec3(uAerialMie * 1.11 * odM)));
}
vec3 applyAerial(vec3 col, vec3 wp, vec3 camPos) {
  vec3 d = wp - camPos;
  float L = length(d);
  vec3 rd = d / max(L, 1e-3);
  L *= uAerialScale;
  float odR = odExp(camPos.y, rd.y, L, 8000.0);
  float odM = odExp(camPos.y, rd.y, L, uAerialMieH);
  const vec3 bR = vec3(5.802e-6, 13.558e-6, 33.1e-6);
  vec3 tauR = bR * odR;
  vec3 tauM = vec3(uAerialMie * odM);
  vec3 tau = tauR + tauM * 1.11;
  vec3 T = exp(-tau);
  aerialTransmit = T;
  float mu = dot(rd, uSunDir);
  float pR = 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu);
  float g = 0.78, gg = g * g;
  float pM = 3.0 / (8.0 * 3.14159265) * ((1.0 - gg) * (1.0 + mu * mu)) / ((2.0 + gg) * pow(1.0 + gg - 2.0 * g * mu, 1.5));
  vec3 scatter = (tauR * pR + tauM * pM) / max(tau, vec3(1e-9));
  vec3 phys = uAerialSun * scatter + uAerialAmb * 0.25;
  // far away the air-light converges to the actual horizon sky colour
  vec3 ins = mix(horizonColor(rd), phys, clamp(-rd.y * 1.5, 0.0, 1.0)) * (1.0 - T);
  return col * T + ins;
}
`;

export const CLOUD_WEATHER = /* glsl */ `
#define CB 1050.0
#define CT 4200.0
#define WEATHER_Q 9.0
uniform float uCoverage, uCloudTime;
uniform sampler2D uWeather;
vec2 windOff() { return vec2(-3.2, -2.4) * uCloudTime * 0.6; }
float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
// smooth part of the weather field (baked into uWeather over |q| < WEATHER_Q):
// x = cumulus octaves 0-2 + clusters, y = cloud-top field
vec2 weatherBase(vec2 q) {
  float big = fbm2(q * 0.35 + 1.3, 3);                 // cloud streets / clusters (~30 km)
  return vec2(fbm2(q * 2.2, 3) * 0.75 + big * 0.45, fbm2(q * 1.3 + 3.0, 3));
}
// coverage & cloud-top height from a 2D weather field
vec2 weather(vec2 p) {
  vec2 q = (p - windOff()) * 0.00011;
  vec2 uv = q * (0.5 / WEATHER_Q) + 0.5;
  vec2 b = abs(uv.x - 0.5) < 0.499 && abs(uv.y - 0.5) < 0.499 ? textureLod(uWeather, uv, 0.0).xy : weatherBase(q);
  // individual cumulus (~2-4 km): the finest octave of fbm2(q * 2.2, 4) stays analytic
  vec2 p3 = q * 2.2;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 3; i++) p3 = r * p3 * 2.03 + 17.1;
  float c = b.x + 0.75 * 0.0625 * vnoise2(p3);
  float cov = clamp((c - (1.18 - uCoverage)) * 4.5, 0.0, 1.0);
  // keep the sky directly above the pad clear-ish
  cov *= smoothstep(1800.0, 5200.0, length(p));
  float top = mix(0.18, 1.0, smoothstep(0.45, 0.85, b.y)) * (0.5 + 0.5 * cov);
  return vec2(cov, top);
}

// fraction of direct sunlight blocked by the cloud field above a point
float cloudShadow(vec3 wp) {
  vec3 sd = uSunDir;
  if (sd.y < 0.02) return 1.0;
  float t = (CB + 900.0 - wp.y) / sd.y;
  if (t < 0.0) return 1.0;
  vec2 w = weather(wp.xz + sd.xz * t);
  return 1.0 - 0.82 * smoothstep(0.05, 0.6, w.x);
}
`;
