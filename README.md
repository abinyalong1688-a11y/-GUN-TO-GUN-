# GUN TO GUN

A single-file 3D FPS web game — faction combat · four maps · 7 realistic weapons · real physics (gravity / jumping / crouching / recoil ballistics) · male & female operatives · 3v3 AI deathmatch · endless waves.

Designed and developed end-to-end as an original project: every system — rendering, physics, weapons, characters, AI, audio, UI — is implemented in-house and bundled into one self-contained HTML file.

## Play

**Play online: https://abinyalong1688-a11y.github.io/-GUN-TO-GUN-/**

Or **double-click [`dist/gun-to-gun.html`](dist/gun-to-gun.html)** (~0.8 MB, zero external requests, fully playable offline).

| Key | Action |
|---|---|
| W A S D | Move (Shift to sprint) |
| Space | Jump (gravity / landing physics — hop onto crates, stack-climb to container tops) |
| Ctrl | Crouch (lower profile, slower movement, tighter spread) |
| Mouse | Aim (left click to fire) · cursor hidden while aiming (pointer lock), restored whenever a click is needed (menus / pause) · ±89° pitch |
| Right click | Aim down sights (ADS) · high-magnification scope on AUG / Longbow / SG 553 (scope overlay + zoom-compensated sensitivity) · heavy knife stab |
| R | Reload |
| 1 / 2 / 3 | Switch weapons: **tap 1 repeatedly to cycle all 4 primaries** / Desert Eagle / combat knife (mouse wheel cycles all 6) |
| TAB | Scoreboard (deathmatch) |
| ESC | Pause |

> **Interface language**: visitors from China automatically get the Chinese UI; everyone else gets the full English UI (synchronous first-frame detection + async IP probe with dual-endpoint fallback; offline or failed probes fall back to Chinese). Force a language for testing with `?ipcc=US` / `?ipcc=CN`.

## Characters

- **Callsign login**: enter a nickname, shown in the killfeed and scoreboard
- **Frost · Nova Operator** (female): model-grade physique · ponytail that swings with the gait · refined facial features · tactical headset, 115 HP
- **Raven · Rogue Mercenary** (male): rugged and sharp · V-shaped broad shoulders / narrow waist · rolled-sleeve red jacket · clean short hair, +12% move speed / +25% reload speed
- Both factions are mixed-gender squads (Nova: Frost / Snowwolf / Swift / Thunder; Rogue: Raven / Fox / Vulture / Viper); first-person view shows gun-holding arms with tactical gloves

### v1.9 — rigged-model character pipeline (AI-ready bodies, procedural fallback)

- **GLB character pipeline**: rigged humanoid models (male 1.80 m / female 1.75 m) load from data URLs embedded in the single file — orientation / scale / ground contact normalised at load, bone names resolved by keyword aliasing (Tripo / Mixamo / custom rigs all work), `SkeletonUtils` instancing with per-instance material clones (hit flash and corpse fade stay independent). The original procedural builder remains the permanent fallback (`?model=proc` forces it; any load failure auto-falls back with zero regression)
- **Procedural rig animation**: walk cycle with knee bend + ankle compensation stacked on each rig's bind-pose baseline (restE), idle weight shift, locomotion forward lean, rifle turn inertia, two-stage death (stagger → collapse)
- **Material quality**: neutral three-channel canvas maps (cloth weave / armour panels / leather / skin pores) tinted per operator palette; headgear auto-scales to the rig head radius
- **Per-map IBL**: the live sky shader is baked to a PMREM on every map switch — metals and outfits reflect real scene colours (sunset orange / aurora green / dock neon / lava glow); each map adds a rim backlight (cool blue / aurora green / neon cyan / lava orange) that lifts character silhouettes
- **Asset pipeline**: `assets_raw/` (originals) → `scripts/compress_characters.mjs` (dedup + weld + vertex reorder + EXT_meshopt_compression, **no quantization on skinned meshes**) → `assets/characters/` (embedded); ~57 % smaller with lossless bone transforms and vertex colours

## Weapons

7 weapons with real ballistic physics; all 4 faction primaries are carried at once and switchable in-game.

- **Primaries**
  - Nova: **M4A4** (31 dmg, stable) / **AUG** (30 dmg, 2.5× scope) / **Longbow** (115 dmg, one-shot kill, 4.7× deep scope, bolt-action) / **MP5** (26 dmg, 800 RPM SMG)
  - Rogue: **AK-47** (36 dmg, heavy recoil) / **SG 553** (32 dmg, 2.2× scope) / **Longbow** / **MP5**
  - Switching: **tap 1 to cycle the 4 primaries** (from pistol/knife, 1 returns to the last primary); mouse wheel cycles all 6; the menu selection sets the starting weapon
- **Sidearm**: Desert Eagle .50 AE (53 dmg, 7 rounds, semi-auto trigger — one click, one shot)
- **Melee**: tactical combat knife (left-click slash 40 / right-click heavy stab 65, no ammo)
- **Weapon weight affects movement**: the Longbow is the slowest, the knife the fastest; applied instantly on every switch
- **Recoil patterns**: deterministic climb + horizontal drift while firing, resets on release — spray control is a learnable skill
- **Ballistics**: jumping wrecks accuracy, crouching tightens spread, movement increases dispersion, headshots ×2, red-core crits ×2.5
- ADS sensitivity is automatically compensated by the zoom ratio

## Maps

Four hand-built arenas, each a distinct scene with its own layout, sky, lighting and atmosphere:

- **Desert Outpost** — sunset sand outpost (the original layout, preserved)
- **Glacier Lake** — aurora night: a diagonal glacial ice ridge, a fractured ice maze, a half-sunken wreck and an open iceberg plain
- **Neon Docklands** — rain night: two container walls forming a canyon street with staggered crossings, neon signage, floodlight masts, a gantry crane and a dark skyline
- **Volcano Caldera** — ember: a snaking lava river forded by two rock bridges (one under a basalt arch), basalt column fields and the glowing volcano cone on the horizon

## Movement Physics

- Constant gravitational acceleration + integrated jump impulse (jump height ≈ 1.16 m): hop onto crates, climb crate stacks to reach container tops
- Natural falls off edges, precise landings on crate tops while falling, 0.32 m auto step-up
- Reduced air control (real inertia), smooth crouch transitions, terminal velocity

## Game Modes

- **Endless Waves**: defend the outpost against three drone classes with detailed silhouettes — WASP (kamikaze) / REAPER (roaming shooter) / WARDEN (heavy: glowing sensor windows, core guard rings, wing plates / claw feet / gun shields, rotor hubs, breathing red-core pulse). Red-core crits ×2.5
- **6-Player Deathmatch (3v3)**: you + 2 same-faction AI teammates vs 3 enemy AI. Nova fires controlled bursts, Rogue sprays. First to 25 kills wins, with killfeed, TAB scoreboard and respawns
  - Note: true networked multiplayer requires a persistent server, which conflicts with the "single file, offline-playable" goal — deathmatch delivers the same arena experience with AI combatants

## Sponsorship Placements

Three self-illuminated **double-sided** billboards (brand face / large URL face — AbinStudio · AI short-drama production · app.agents100.com), present on all four maps and shootable with persistent bullet holes; sponsor info also appears at the bottom of the main menu.

## Architecture

```
src/
  assets.js   Materials — 1024px procedural Canvas PBR textures (sand / snow / basalt / ice / wet asphalt) + normal maps + weapon wood / faction fabrics + neon signage + billboard art; zero image files
  world.js    Scene — parametric sky shaders (sunset / aurora night / rain night / ember) + four distinct per-map layouts + lighting / fog / ambient particles
  weapon.js   Weapons — three-slot loadout viewmodels + first-person arms (tactical gloves) + semi-auto trigger + slash animations + recoil / ADS / reload / shell ejection
  heroes.js   Characters — realistic 3D faction operatives (lathe-surface torsos, facial features, hair physics, faction outfits) and 3v3 AI
  enemies.js  Enemies — three drone classes (sensor windows / guard rings / detail parts) + AI + projectiles + occlusion checks
  player.js   Player — movement / circle-vs-AABB collision / health / regeneration
  waves.js    Gameplay — wave scheduling / spawn throttling / supplies
  effects.js  FX — GPU point particles + dual-layer tracers (white-hot core / weapon-tinted halo / muzzle tip glow, parameterized per weapon) + hit flashes + normal-aligned bullet decals + fireballs / shock rings / debris
  audio.js    Audio — every sound effect synthesized live via WebAudio (including the Desert Eagle's heavy report and knife swings); zero audio files
  ui.js       UI — login menu / four-state interface / killfeed / scoreboard (Nova vs Rogue) / weapon bar
  main.js     Main loop — state machine + raycast hits (statics / drones / character spheres) + knife melee checks + Bloom / ACES
build.mjs     esbuild bundle into a single HTML file
```

## Build / Test

```bash
npm install        # three@0.170.0 + esbuild
npm run build      # produces dist/gun-to-gun.html
npm test           # unit tests (node --test): utils / weapon stats / movement physics / wave scheduling
npm run serve      # local server http://127.0.0.1:8137/ (testing only)
```

Built-in verification hooks:

- `?shot=menu|combat|dm|over` — jump straight into a state for screenshot review
- `?selftest=1` — weapon self-test (primary hit-kill + Desert Eagle semi-auto + knife melee); results in the debug bar and console
- `?e2e=1` — **system integration test**: 12 end-to-end assertions (loading / ADS / recoil ballistics / gravity jump / crate-top landing / crouch / weight-based speed / **4-primary same-slot cycling** / crits / XSS protection / 360° look); results in `window.__e2e` and the debug bar; deterministic, reproducible in background tabs
- `?perf=1` — hitch monitor: slow-frame (>25 ms) count and max frame time reported to console periodically
- `?ipcc=US` / `?ipcc=CN` — force the interface language (default: auto by IP — English overseas / Chinese in China; silent fallback on probe failure)

## Cloud Deployment & Offline Mode

When hosting in the cloud, **upload the `dist/` trio together**: `gun-to-gun.html` + `sw.js` + `manifest.webmanifest`.

- **Offline mode (PWA)**: a built-in Service Worker caches the game on the first online visit, so it **reopens from cache with no network** (navigation is network-first for updates, falling back to cache when offline); also supports browser "install to desktop" for fullscreen play
- **Language detection**: the hosted version detects the UI language from the client IP (English overseas / Chinese in China). This is the only optional external call — it fails silently offline and never affects the game itself (the game body remains zero-external-request)
- Cross-origin probe requests are never cached; the SW cache is purged automatically by version number on updates

## Production Hardening

Security / stability / performance work done to a ship-ready standard:

| Category | Hardening |
|---|---|
| Security | All user-controlled strings (nicknames etc.) are HTML-escaped before entering killfeed / scoreboard / end-screen innerHTML (stored-XSS protection) |
| Security | The `window.__game` debug probe is exposed only under test hooks (`?shot=` / `?selftest` / `?e2e`) |
| Stability | All `localStorage` access goes through a safe wrapper (private mode / disabled storage never crashes; reads and writes have fallbacks) |
| Stability | Dirty-data guards on persisted values: sensitivity / volume / quality / character / map / mode / primary / best score — invalid values fall back to defaults |
| Stability | WebGL context loss (driver crash / GPU switch / sleep) → visible notice + automatic recovery reload |
| Stability | Main-loop exception circuit breaker: a bad frame no longer silently kills the rAF chain — it halts cleanly and prints the stack to the debug bar |
| Performance | Zero allocation in the firing hot path: `fire()` reuses a vector pool, ray-sphere tests reuse module-level vectors, floating score text reuses scratch vectors |
| Performance | Drone AI hot path uses vector pooling + **per-type shared geometry caching** (no spawn allocation spikes, no geometry leaks) |
| Performance | HUD hot-path DOM write deduplication (ammo / crosshair unchanged → no write) |
| Performance | Full resource disposal on map switch: geometries (incl. ambient Points) + per-map materials (sky shaders / bulbs / beacons / lava cracks / cooling towers) |
| Performance | Hitch monitor counters (`?perf=1`): slow-frame (>25 ms) ratio and max frame time |
| Hygiene | Dead code removed; version shown in the menu footer and console banner; `npm test` unit suite + `?e2e=1` integration suite |

## Feature Checklist

- [x] WASD / mouse / left-click fire / R reload / right-click ADS all functional
- [x] 3 enemy AI classes: move, attack, die
- [x] PBR materials + four lighting atmospheres + shadows + Bloom / ACES, no overexposure
- [x] Menu / combat / deathmatch / end-screen multi-state screenshot verification
- [x] Raycast hits + cover blocking + red-core crits + character headshots ×2 + knife melee
- [x] Three-slot weapon system: faction primaries / Desert Eagle (semi-auto) / knife (slash / stab)
- [x] Bullet decals conform to surfaces; explosions include fireball + shockwave + debris
- [x] Shaders precompiled — no freeze on first entry
- [x] Production hardening: nickname XSS escaping, dirty-storage fallbacks, context-loss recovery, exception circuit breaker, zero-allocation hot paths, map-switch disposal
- [x] Zero console errors; 0.63 MB ≤ 5 MB budget; zero external requests; playable offline