# Starship — Orbital Flight Test (three.js)

A procedural, physically based, real-time recreation of a SpaceX **Starship / Super Heavy** orbital flight test from Starbase, Texas. It covers the countdown, the staggered 33-Raptor ignition on a water-deluged launch mount, liftoff, max-Q, hot staging, the booster's flip, boostback and landing burn over the Gulf, and the ship's climb to SECO.

**Live:** https://chenhunghan.github.io/starship-first-orbital-fight/

Everything is generated from code. The project has **no external assets**: no textures, models, HDRIs or audio files. The only runtime dependency is [three.js](https://threejs.org).

## What's simulated

### Flight physics (`src/physics.js`)
- The trajectory is integrated in 2D in an Earth-centred inertial frame, with inverse-square gravity (μ = 3.986×10¹⁴) and Earth's rotation.
- The atmosphere follows the US Standard Atmosphere 1976 (temperature, pressure, density and speed of sound). Drag uses a Mach-dependent drag coefficient.
- Raptor thrust depends on ambient pressure (`F = F_vac − p_a·A_e`), and mass flow is `F_vac / (Isp·g₀)`. Engines spool up and down, and the ignition is staggered (centre → inner ring → outer ring).
- Guidance:
  - The booster rises vertically to clear the tower, then pitches over and flies a gravity turn. It throttles down for max-Q and limits acceleration late in the burn.
  - MECO happens once the landing propellant reserve is reached, followed by hot staging, a flip and a boostback burn.
  - The booster computes a suicide-burn ignition point, flies the 13 → 3 engine landing burn and splashes down about 5 km offshore.
  - The ship uses closed-loop ascent guidance up to SECO.
- The simulated timeline (≈ max-Q at T+55 s, MECO at T+2:40 at ~65 km and ~5,900 km/h, SECO at ~150 km and ~26,000 km/h) is close to the real flight tests.

### Rendering
- **Sky:** a single-scattering Rayleigh + Mie + ozone atmosphere with an approximation of multiple scattering. It works from sea level to space, where you see a black sky and the atmospheric limb. Cirrus and contrails are drawn in the sky pass.
- **Clouds:** ray-marched volumetric cumulus built from a procedural 3D Perlin-Worley noise texture. They use Beer-powder lighting and a dual-lobe phase function, cast shadows on the ground, and are occluded by scene depth.
- **Smoke and steam:** about 16k CPU-simulated particles.
  - Exhaust jets decelerate by entraining ambient air.
  - Buoyancy comes from a two-component temperature model (hot core plus warm steam).
  - Divergence-free turbulence, ground spreading and wind shape the clouds.
  - Particles are lit through a density grid, which gives self-shadowing and the orange under-lighting from the engine fire.
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
- **Audio:** procedural rumble, roar and crackle. Sound arrives with the real propagation delay (343 m/s) and loses high frequencies over distance.

## Controls

| Input | Action |
| --- | --- |
| Drag / right-drag / scroll | Orbit / pan / zoom |
| `1`–`8` | Cameras: drone, long lens, lagoon, chase plane, pad cam, onboard, tracker, free orbit |
| Lens slider | Focal length, 12–2400 mm |
| `Space` / `R` | Pause / restart |
| Timeline dots | Jump to a flight event |
| `H` | Hide the UI |

You can also set the sun position (morning or evening launch), exposure and render quality from the control panel.

URL parameters: `?q=low|medium|high|ultra`, `?cam=telephoto`, `?t=120` (seek to that time), `?autostart`.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
npm run sim      # print the flight profile from the physics model
```

The site deploys to GitHub Pages through `.github/workflows/deploy.yml` on every push to `main`.

## License

MIT © Hung-Han (Henry) Chen. This is a fan project and is not affiliated with SpaceX.
