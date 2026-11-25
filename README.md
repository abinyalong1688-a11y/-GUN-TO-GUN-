# GUN TO GUN

A single-file 3D FPS web game — faction combat · four maps · 8 realistic weapons · real physics (gravity / jumping / crouching / recoil ballistics) · male & female operatives · 4v4 behavior-tree AI deathmatch · endless waves.

Designed and developed end-to-end as an original project: every system — rendering, physics, weapons, characters, AI, audio, UI — is implemented in-house and bundled into one self-contained HTML file.

## Play

**Play online: https://abinyalong1688-a11y.github.io/-GUN-TO-GUN-/**

Or **double-click [`dist/gun-to-gun.html`](dist/gun-to-gun.html)** (~3.1 MB / 1.6 MB gzipped, zero external requests, fully playable offline).

| Key | Action |
|---|---|
| W A S D | Move (Shift to sprint) |
| Space | Jump (gravity / landing physics — hop onto crates, stack-climb to container tops) |
| Ctrl | Crouch (lower profile, slower movement, tighter spread) |
| Mouse | Aim (left click to fire) · cursor hidden while aiming (pointer lock), restored whenever a click is needed (menus / pause) · ±89° pitch |
| Right click | Aim down sights (ADS) · high-magnification scope on AUG / Longbow / SG 553 (scope overlay + zoom-compensated sensitivity) |
| R | Reload |
| 1 / 2 / 3 | Switch weapons: **tap 1 repeatedly to cycle all 4 primaries** / Desert Eagle / UMP-45 backup SMG (mouse wheel cycles all 6) |
| TAB | Scoreboard (deathmatch / KOTH / waves run status) |
| ESC | Pause |

> **Interface language**: visitors from China automatically get the Chinese UI; everyone else gets the full English UI (synchronous first-frame detection + async IP probe with dual-endpoint fallback; offline or failed probes fall back to Chinese). Force a language for testing with `?ipcc=US` / `?ipcc=CN`.

## Characters

- **Callsign login**: enter a nickname, shown in the killfeed and scoreboard
- **Frost · Nova Operator** (female): model-grade physique · ponytail that swings with the gait · refined facial features · tactical headset, 115 HP
- **Raven · Rogue Mercenary** (male): rugged and sharp · V-shaped broad shoulders / narrow waist · rolled-sleeve red jacket · clean short hair, +12% move speed / +25% reload speed
- Both factions are mixed-gender squads — one male + one female each (Nova: Frost / Snowwolf; Rogue: Raven / Fox); first-person view shows gun-holding arms with tactical gloves

### v1.9 — rigged-model character pipeline (rigged bodies, procedural fallback)

- **GLB character pipeline**: four shared rigged humanoid models (male 1.80 m / female 1.75 m) load from data URLs embedded in the single file — orientation / scale / ground contact normalised at load, bone names resolved by keyword aliasing (any standard humanoid naming scheme works), `SkeletonUtils` instancing with per-instance material clones (hit flash and corpse fade stay independent). The 8 operators draw from two **cross-shared gender pools** (each of the 4 rigs is used once per faction), so all four operators on a team have a distinct silhouette; baked headgear is shared. The original procedural builder remains the permanent fallback (`?model=proc` forces it; any load failure auto-falls back with zero regression)
- **Faction identity**: `FACTION_PALETTES` gives every Nova operator blue-grey and every Rogue operator dark red for `jacket / armour / cloth / accent`. `accent` is emissive (armbands, lens glints, headset stripes), so teams read at a distance and in bust portraits. `skin`, `hair` and `addExtrasGLTF` attachments keep per-operator identity. Camos blend the team colour toward a neutral pattern instead of replacing it — a desert-camo Nova still reads as Nova.
- **Procedural rig animation**: walk cycle with knee bend + ankle compensation stacked on each rig's bind-pose baseline (restE), idle weight shift, locomotion forward lean, rifle turn inertia, two-stage death (stagger → collapse)
- **Material quality**: neutral three-channel canvas maps (cloth weave / armour panels / leather / skin pores) tinted per faction palette; headgear auto-scales to the rig head radius
- **Per-map IBL**: the live sky shader is baked to a PMREM on every map switch — metals and outfits reflect real scene colours (sunset orange / aurora green / dock neon / lava glow); each map adds a rim backlight (cool blue / aurora green / neon cyan / lava orange) that lifts character silhouettes
- **Asset pipeline**: `assets_raw/` (originals) → `scripts/compress_characters.mjs` (dedup + weld + vertex reorder + EXT_meshopt_compression, **no quantization on skinned meshes**) → `assets/characters/`; ~57 % smaller with lossless bone transforms and vertex colours. `build.mjs` embeds only the 4 shared rigs; the other 4 stay in the repo so the 8-rig build can be restored by changing `SHARED_MODELS` + `MODEL_MAP`

## Weapons

8 weapons with real ballistic physics; all 4 faction primaries are carried at once and switchable in-game.

- **Primaries**
  - Nova: **M4A4** (31 dmg, stable) / **AUG** (30 dmg, 2.5× scope) / **Longbow** (115 dmg, one-shot kill, 4.7× deep scope, bolt-action) / **MP5** (26 dmg, 800 RPM SMG)
  - Rogue: **AK-47** (36 dmg, heavy recoil) / **SG 553** (32 dmg, 2.2× scope) / **Longbow** / **MP5**
  - Switching: **tap 1 to cycle the 4 primaries** (from pistol/SMG, 1 returns to the last primary); mouse wheel cycles all 6; the menu selection sets the starting weapon
- **Sidearm**: Desert Eagle .50 AE (53 dmg, 7 rounds, semi-auto trigger — one click, one shot)
- **Backup SMG**: UMP-45 .45 ACP (34 dmg, 600 RPM, 25 rounds, full-auto) — the third slot replaced the melee knife in v1.10; a two-handed viewmodel with a straight magazine and a folding stock
- **Weapon weight affects movement**: the Longbow is the slowest, the pistol the lightest; the backup SMG sits between the rifles and the pistol; applied instantly on every switch
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
- **8-Player Deathmatch (4v4)**: you + 3 same-faction AI teammates vs 4 enemy AI. Nova fires controlled bursts, Rogue sprays. 3-minute matches; first to 25 kills ends it early, otherwise the higher kill count wins. Killfeed, TAB scoreboard and respawns — a human death counts on the board and credits the killing bot
- **Friends 5v5 (online)**: room-code lobbies with the same behavior-tree AI filling empty slots (9 AI + player in solo training). Fixed sides A=NOVA / B=ROGUE, snapshot interpolation for remote players, server-authoritative hits/score and a 5-minute room timer. Requires the Worker room service (`/rooms`); offline/solo training still fills a full AI 5v5 locally
  - Note: true networked multiplayer requires a persistent server, which conflicts with the "single file, offline-playable" goal — deathmatch delivers the same arena experience with AI combatants

## Bot Combat AI (v1.11)

The deathmatch bots are driven by layered systems that replace the old "nearest enemy → shoot" if-chain, on top of the navigation stack (velocity-level separation + RVO, wall slide, stuck escape, local-grid A*):

- **Perception** (`src/botPerception.js`) — view cone + view range + line-of-sight ray, 360° close-proximity awareness, smoke occlusion, gunfire hearing and damage alerts, and a `memoryTime`-bounded memory of the last seen/heard position. Unseen enemies never leak their live position, velocity or health: memory only refreshes on an actual sighting or a fresh sound/damage cue.
- **Behavior tree** (`src/botBehaviorTree.js` + `src/botBrain.js`) — Selector / Sequence / Parallel / Condition / Action nodes. Priority order: finish a reload → break contact to cover when hurt → engage (aim control and footwork run in a Parallel) → search the last known position → patrol the objective. Includes strafing, flanking, engagement bands, tactical reloads and cover selection. Bots check the firing line: a teammate (or the allied player) in the way makes them hold fire and sidestep until the line clears.
- **Aim & cover** (`src/botCombat.js`) — target priority (visible > remembered; closer, wounded, threatening and already-tracked targets score higher), ballistic lead, a range/motion/settle/smoke accuracy model, and scored cover spots that respect `coverBias` / `preferCoverDist`.
- **Self-evolution** (`src/botEvolution.js` + `scripts/evolve-bots.mjs`) — an offline genetic algorithm tunes tactical doctrine (aggression / cover / flank / strafe / stand-off / retreat) against the normal doctrine in a deterministic duel model. `npm run evolve` regenerates `src/botTuning.js`; the winning genome is clamped into `PARAM_RANGES` and merged into the hard preset.

Difficulty (`easy` / `normal` / `hard`, persisted as `botDifficulty`) controls reaction time, aim settling, accuracy, view cone/range, memory, hearing, aggression, cover/flank bias, burst discipline and damage. `?e2e=1` asserts perception memory, target priority, hearing, firing-line blocking and difficulty ordering.

## Scoreboards

`TAB` opens a mode-aware board while playing:

- **Deathmatch** — 8-player team table (operator / faction / kills / deaths), player row highlighted, sorted by kills then deaths; the top HUD shows team kills and the match timer. A bot killing the player is credited to the killer, the player's death row and the killfeed, so the table and the 25-kill win check stay accurate.
- **KOTH** — the same team table plus live capture points for NOVA/ROGUE and capture progress; the HUD adds the control-point bar and score.
- **Waves** — a compact run-status panel (wave / remaining hostiles / score / kills) instead of the PvP table.

A board left open by a held TAB is cleared on pause, next match, menu return, match end and by the results screen, so it cannot leak into another mode. The DM/KOTH end screens also render the full 8-player final table.

## Sponsorship Placements

Three self-illuminated **double-sided** billboards (brand face / large URL face — AbinStudio · AI short-drama production · app.agents100.com), present on all four maps and shootable with persistent bullet holes; sponsor info also appears at the bottom of the main menu.

## Architecture

```
src/
  assets.js   Materials — 1024px procedural Canvas PBR textures (sand / snow / basalt / ice / wet asphalt) + normal maps + weapon wood / faction fabrics + neon signage + billboard art; zero image files
  world.js    Scene — parametric sky shaders (sunset / aurora night / rain night / ember) + four distinct per-map layouts + lighting / fog / ambient particles + a 2 m spatial grid over the static colliders (`SpatialGrid` / `ColliderGrid`)
  weapon.js   Weapons — three-slot loadout viewmodels + first-person arms (tactical gloves) + semi-auto / full-auto triggers + recoil / ADS / reload / shell ejection
  attach.js   Attachment integrity — connected-island check that every weapon part is welded to the gun body (unit test + ?e2e=1)
  heroes.js   Characters — realistic 3D faction operatives (lathe-surface torsos, facial features, hair physics, faction outfits) and 4v4 AI, incl. the bot navigation stack (velocity-level separation + simplified RVO, normal-projection wall slide, stuck escape, local-grid A* + corner routing, squad fan-out)
  botPerception.js  Bot senses — view cone / range / LOS / smoke / hearing / damage alerts / bounded memory
  botBehaviorTree.js  Behavior-tree core — Selector / Sequence / Parallel / Condition / Action / decorators
  botBrain.js  Bot brain — target selection, aim lead, engagement footwork, reload / retreat / search / patrol tree
  botCombat.js  Combat maths — target scoring, accuracy model, firing-line block, cover point generation and selection
  botConfig.js  Difficulty presets, faction weapon styles, parameter bounds and the tuned-genome merge
  botEvolution.js  Offline genetic algorithm — deterministic duel model + fitness + selection/crossover/mutation
  enemies.js  Enemies — three drone classes (sensor windows / guard rings / detail parts) + AI + projectiles + occlusion checks
  player.js   Player — movement / circle-vs-AABB collision / health / regeneration
  waves.js    Gameplay — wave scheduling / spawn throttling / supplies
  effects.js  FX — GPU point particles + dual-layer tracers (white-hot core / weapon-tinted halo / muzzle tip glow, parameterized per weapon) + hit flashes + normal-aligned bullet decals + fireballs / shock rings / debris
  audio.js    Audio — every sound effect synthesized live via WebAudio (including the Desert Eagle's heavy report); zero audio files
  ui.js       UI — login menu / four-state interface / killfeed / mode-aware scoreboard (DM / KOTH / waves) / weapon bar
  main.js     Main loop — state machine + raycast hits (statics / drones / character spheres) + Bloom / ACES
build.mjs     esbuild bundle into a single HTML file
```

## Build / Test

```bash
npm install        # three@0.170.0 + esbuild
npm run build      # produces dist/gun-to-gun.html
npm test           # unit tests (node --test): utils / weapons / attachment / physics / waves / bot AI / navigation / evolution / online protocol & rooms (202 tests)
npm run test:e2e   # headless Chrome/Edge integration suite (?e2e=1), 76 assertions
npm run evolve     # regenerate the GA-tuned bot doctrine (src/botTuning.js)
npm run serve      # local server http://127.0.0.1:8137/ (testing only)
npm run server:dev # local Worker room service (wrangler dev), for online 5v5 testing
```

> The online build bakes the room endpoint via `GTG_SERVER=wss://<host> npm run build` (same-origin `/rooms` for `game.agents100.com`). `npm run test:e2e` needs Chrome or Edge; it starts its own static server and private browser profile.

Built-in verification hooks:

- `?shot=menu|combat|dm|over` — jump straight into a state for screenshot review
- `?selftest=1` — weapon self-test (primary hit-kill + Desert Eagle semi-auto + UMP-45 full-auto burst); results in the debug bar and console
- `?e2e=1` — **system integration test**: 76 end-to-end assertions (loading / ADS / recoil ballistics / gravity / landing / crouch / weapons / attachment integrity / crits / XSS / 360° look / **bot perception & memory** / **target priority** / **hearing** / **firing-line blocking** / **difficulty presets** / **DM / KOTH / waves scoreboards** / **player-death scoring** / **online 5v5 AI fill, sides and loopback networking**); results in `window.__e2e` and the debug bar; deterministic, reproducible in background tabs
- `?perf=1` — hitch monitor: slow-frame (>25 ms) count and max frame time reported to console periodically
- `?ipcc=US` / `?ipcc=CN` — force the interface language (default: auto by IP — English overseas / Chinese in China; silent fallback on probe failure)

## Cloud Deployment & Offline Mode

When hosting in the cloud, **upload the `dist/` trio together**: `gun-to-gun.html` + `sw.js` + `manifest.webmanifest`.

- **Offline mode (PWA)**: a built-in Service Worker caches the game on the first online visit, so it **reopens instantly from cache with no network** (navigation is stale-while-revalidate: the cached copy is served immediately and a fresh copy is fetched in the background for the next visit); also supports browser "install to desktop" for fullscreen play
- **First-visit loading**: the HTML is ~3.1 MB (1.6 MB gzipped) and ~70 % of it is the four shared rigged character GLBs (v1.10 cut the gzipped payload by ~46 %). The main bundle is placed **before** that payload, so the menu becomes interactive after only ~270 KB of transfer; the models live in inert `<script type="application/octet-stream">` tags read on demand once parsing completes (procedural characters cover the gap). On the ~27 KB/s link measured from mainland China, full download drops from ~111 s to ~60 s while time-to-interactive stays unchanged.
- **Language detection**: the hosted version detects the UI language from the client IP (English overseas / Chinese in China). This is the only optional external call — it fails silently offline and never affects the game itself (the game body remains zero-external-request)
- Cross-origin probe requests are never cached; the SW cache is purged automatically by version number on updates. The SW pre-cache list must not contain `./` — `/dist/` has no index and returns 404 on GitHub Pages, which makes `caches.addAll()` reject the whole install

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
| Performance | Bot navigation is O(local density), not O(bots × colliders): a 2 m collider grid, one neighbour grid per frame, path planning on every third frame per bot, and 20 bots cost ~0.2 ms per frame of AI |
| Performance | Bot AI perception/behavior budget: 8-bot 90-second deathmatch soak measured **≈0.07–0.08 ms per bot per frame**, with sensing throttled to 7–14 Hz per bot and cover LOS limited to the best few candidates |
| Behaviour | Bot crowd control: no clustering / back-and-forth jitter on a shared target, no wall grinding — velocity-level separation + RVO, one position write per frame, wall slide along the contact normal, sideways stuck escape, local-grid A* around cover; right of way goes to the bot in a firing stance |
| Fairness | Bot perception is strictly bounded: view cone + range + LOS + `memoryTime`; unseen enemies never update remembered position, velocity or health (no wallhack memory) |
| Behaviour | Bots check the firing line and hold fire / sidestep while a living teammate or the allied player blocks the shot |
| Hygiene | Dead code removed; version shown in the menu footer and console banner; `npm test` unit suite + `?e2e=1` integration suite |

## Feature Checklist

- [x] WASD / mouse / left-click fire / R reload / right-click ADS all functional
- [x] 3 enemy AI classes: move, attack, die
- [x] PBR materials + four lighting atmospheres + shadows + Bloom / ACES, no overexposure
- [x] Menu / combat / deathmatch / end-screen multi-state screenshot verification
- [x] Raycast hits + cover blocking + red-core crits + character headshots ×2 + backup SMG full-auto
- [x] Attachment integrity: no floating weapon parts (scopes, butt plates, sights welded — unit + e2e check)
- [x] Three-slot weapon system: faction primaries / Desert Eagle (semi-auto) / UMP-45 backup SMG (full-auto)
- [x] Bullet decals conform to surfaces; explosions include fireball + shockwave + debris
- [x] Shaders precompiled — no freeze on first entry
- [x] Bot navigation: spread out on a shared target, slide along cover, route around boxes (23 unit scenarios in `tests/nav.test.mjs`)
- [x] Behavior-tree bot combat AI: view cone / LOS / smoke occlusion / gunfire hearing / damage alerts / bounded memory
- [x] Bot tactics: target priority, ballistic lead, strafe/flank, tactical reload, low-health cover retreat, last-known search, objective patrol, firing-line hold fire
- [x] Offline GA self-tuning of bot tactical doctrine (`npm run evolve`) with bounded parameters and a committed winning genome
- [x] Mode-aware scoreboards: DM/KOTH team tables with live HUD scores, waves run panel, player deaths credited to the killing bot, stale boards cleared on transitions
- [x] Production hardening: nickname XSS escaping, dirty-storage fallbacks, context-loss recovery, exception circuit breaker, zero-allocation hot paths, map-switch disposal
- [x] Zero console errors; single-file build ~3.1 MB (1.6 MB gzipped, 4 shared rigged GLBs); zero external requests; playable offline