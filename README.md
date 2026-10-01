# Starship — Orbital Flight Test (three.js)

A procedural, physically based, real-time recreation of a SpaceX **Starship / Super Heavy** flight test, modelled on **Flight 14** (28 Sep 2026, the first orbital flight, Block 3 vehicles). It runs from the countdown at Starbase to a dawn splashdown in the North Pacific:

- Water-deluged liftoff with a staggered start of 33 Raptor 3 engines.
- Max-Q, hot staging, then the booster's boostback and landing burn to a soft splashdown in the Gulf.
- SECO onto a suborbital path, then an orbit-insertion burn into a ~260 × 280 km orbit.
- The Starlink V3 deployment window, then the deorbit burn.
- Plasma re-entry and the belly-flop.
- The flip and landing burn, then a tail-first splashdown, tip-over and fireball.

**Live:** https://chenhunghan.github.io/starship-first-orbital-fight/

Everything is generated from code. The project has **no external assets**: no textures, models, HDRIs or audio files. The only runtime dependency is [three.js](https://threejs.org).

### Mission timeline (simulated vs. Flight 14)

| Event | Simulation | Flight 14 (reported) |
| --- | --- | --- |
| Liftoff | T+0:00 | 07:48:59 CDT |
| MECO / hot staging | T+2:22 | T+2:20 – 2:31 |
| Booster soft splashdown (Gulf) | T+7:09 | ≈ T+7 |
| SECO | T+7:16 | T+8:11 |
| Orbit insertion burn (1 Raptor) | T+26:16 → 260 × 282 km | T+25:17 → 262 × 277 km |
| Deorbit burn | T+2:12:18 | T+2:12:18 |
| Splashdown (dawn) | T+3:07 | T+3:08:30 |

Almost all of these times come out of the physics and guidance rather than being scripted. The exceptions are the deorbit time and the start of the Starlink deploy window, which follow the published schedule.

## What's simulated

### Flight physics (`src/physics.js`)
- The trajectory is integrated in 2D in an Earth-centred inertial frame, with inverse-square gravity (μ = 3.986×10¹⁴) and Earth's rotation.
- The atmosphere follows the US Standard Atmosphere 1976 (temperature, pressure, density and speed of sound). Drag uses a Mach-dependent drag coefficient.
- Raptor thrust depends on ambient pressure (`F = F_vac − p_a·A_e`), and mass flow is `F_vac / (Isp·g₀)`. Engines spool up and down, and the ignition is staggered (centre → inner ring → outer ring).
- Guidance:
  - The booster rises vertically to clear the tower, then pitches over and flies a gravity turn. It throttles down for max-Q and limits acceleration late in the burn.
  - MECO happens once the landing propellant reserve is reached. Then come hot staging, a flip, a boostback burn with 31 engines and a suicide-burn landing (11 → 5 → 3 engines) to a soft splashdown offshore.
  - The ship's closed-loop ascent guidance targets SECO on a "passively safe" suborbital trajectory. At apogee it relights one engine to insert into orbit, and later performs a retrograde deorbit burn.
- Re-entry uses a Newtonian lifting-body model of the belly-first ship, with its angle of attack decreasing through the hypersonic phase. It is followed by the subsonic belly-flop, then the flip and a 3-engine landing burn.
- Stagnation heating (~√ρ·v³) drives the plasma sheath, the ionised wake and the glow of the heat-shield tiles.
- The scene origin hops along the ground track, so the ship can be followed around the planet with float precision intact. The local sun direction follows Earth's rotation and the vehicle's position, so the splashdown happens at dawn.

### Rendering
- **Sky:** a single-scattering Rayleigh + Mie + ozone atmosphere with an approximation of multiple scattering. It works from sea level to space, where you see a black sky and the atmospheric limb. Cirrus and contrails are drawn in the sky pass.
- **Clouds:** ray-marched volumetric cumulus built from a procedural 3D Perlin-Worley noise texture. They use Beer-powder lighting and a dual-lobe phase function, cast shadows on the ground, and are occluded by scene depth.
- **Smoke and steam:** about 16k CPU-simulated particles, moved by an incompressible air-flow solver around the pad (`src/fluid.js`).
  - The solver is "stable fluids" on a 64 × 32 × 64 staggered (MAC) grid with 25 m cells. Each step does semi-Lagrangian advection, vorticity confinement and a red-black SOR pressure projection, with a solid ground and open sides and top. It runs only inside an active box that grows with the cloud, in a Web Worker, and is integrated with larger steps when the main thread is busy or the time is warped.
  - The particles and the air are two-way coupled. Every particle carries a share of the ~22 t/s exhaust mass flow. In each cell, the air and the particles relax toward their common momentum-weighted velocity. This turns the exhaust leaving the deluge plate into a radial wall jet that rolls up at its front, pushes the surrounding air and draws in a return flow. The particles in turn follow the resolved air velocity, plus sub-grid eddies.
  - The exhaust leaves through the six gaps between the mount legs, with turbulent bursts that come and go over a few seconds. The bursts grow into separate towers.
  - Buoyancy: hot steam is light (it is hot, and water vapour is 18 g/mol against 29 g/mol for air). Its buoyancy is diluted with height by entrainment (Morton–Taylor–Turner plume theory), which caps the towers. Droplet-laden deluge mist is denser than air and spreads along the ground as a gravity current.
  - The wind profile is a sea-breeze boundary layer that veers into the westerlies aloft. It has a jet near 11 km and shear layers that twist the ascent trail.
  - Ascent trail: a faint condensation column in the humid marine layer. Above ~8 km, where the air is colder than −40 °C (the Schmidt–Appleman criterion), it becomes a dense, persistent ice contrail. The trail spreads by turbulent diffusion (r² = r₀² + 2Kt).
  - Particles are lit through a density grid, which gives self-shadowing. The engine plume acts as a line light for the orange under-lighting.
  - Sprites are sorted back to front and split around the plume, with soft-particle depth fade.
- **Engine plumes:** each engine has its own near-field jet with Mach diamonds, plus a ray-marched merged plume. The plume grows with altitude as the exhaust becomes more underexpanded.
- **Water:** planar reflections (sky, clouds, rocket, smoke) with Fresnel, GGX sun glint and waves.
- **Aerial perspective** is applied consistently to every material.
- **Starbase:**
  - Coast, beach, dunes, tidal flats, South Bay, the Rio Grande, Brazos Santiago Pass and South Padre Island.
  - The launch tower with chopsticks and the QD arm, the six-legged launch mount with a steel deluge plate, the tank farm and the build site.
- **Vehicle:**
  - Stainless steel with weld rings, panel variation and cryogenic frost.
  - Hexagonal heat-shield tiles on the windward side, flaps, grid fins, chines and the vented hot-staging ring.
  - Engine bells that glow while firing.
- **Post-processing:** HDR, bloom, ACES tone mapping, camera-style white balance, grain and vignette.
- **Performance:** the quality preset defaults to Ultra on every device. An adaptive quality governor targets 30 fps by scaling render resolution (and ray-march steps at the lower levels, down to 48 %), never exceeding the chosen preset. The smoke volume is splatted in a single instanced draw into slice atlases, the cloud weather field and sun transmittance are baked, and a depth prepass feeds the volumetric passes.
- **Audio:** procedural rumble, roar and crackle. Sound arrives with the real propagation delay (343 m/s) and loses high frequencies over distance.

## Controls

| Input | Action |
| --- | --- |
| Drag / right-drag / scroll | Orbit / pan / zoom |
| `1`–`8` | Cameras: drone, long lens, lagoon, chase plane, pad cam, onboard (booster engine cam / ship flap cam), tracker, free orbit |
| Lens slider | Focal length, 12–2400 mm |
| `Space` / `R` | Pause / restart |
| Timeline dots | Jump to a flight event (auto time-warp skips the quiet coast and orbit phases) |
| `H` | Hide the UI |

You can also set the sun position (morning or evening launch), exposure and render quality from the control panel.

URL parameters: `?q=low|medium|high|ultra` (default `ultra`), `?cam=telephoto`, `?t=120` (seek to that time), `?autostart`, `?pause` (pause after seeking), `?nogov` (disable the adaptive resolution governor), `?prof` / `?prof=sync` / `?prof=cpu` (per-pass timings via `window.__prof.report()`).

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
npm run sim      # print the flight profile from the physics model
node tools/fluidbench.js 40   # headless check of the pad air-flow solver (timing, divergence, spread)
```

The site deploys to GitHub Pages through `.github/workflows/deploy.yml` on every push to `main`.

## License

MIT © Hung-Han (Henry) Chen. This is a fan project and is not affiliated with SpaceX.
