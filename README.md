# GUN TO GUN

A browser 3D FPS — faction combat · four maps · 8 realistic weapons · real physics (gravity / jumping / crouching / recoil ballistics) · male & female operatives · 3v3 squad-AI deathmatch · endless waves. Plays from a link, no install.

Designed and developed end-to-end as an original project: every system — rendering, physics, weapons, characters, AI, audio, UI — is implemented in-house.

## Play

**Play online: https://abinyalong1688-a11y.github.io/-GUN-TO-GUN-/**

**Play online: https://abinyalong1688-a11y.github.io/-GUN-TO-GUN-/** — the page reaches the menu after a ~1.1 MB download; the two character models (0.85 MB) stream in behind it while a static loading screen shows the squad.

Offline / from disk: **`npm run build:single`**, then double-click `dist-single/gun-to-gun.html` (one self-contained file, no server needed).

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

Latest four-map clipping/collision audit: [`docs/MAP-CLIPPING-AUDIT.md`](docs/MAP-CLIPPING-AUDIT.md).

## Movement Physics

- Constant gravitational acceleration + integrated jump impulse (jump height ≈ 1.16 m): hop onto crates, climb crate stacks to reach container tops
- Natural falls off edges, precise landings on crate tops while falling, 0.32 m auto step-up
- Reduced air control (real inertia), smooth crouch transitions, terminal velocity

## Game Modes

- **Endless Waves (solo, vs AI)**: defend the outpost alone against three drone classes with detailed silhouettes — WASP (kamikaze) / REAPER (roaming shooter) / WARDEN (heavy: glowing sensor windows, core guard rings, wing plates / claw feet / gun shields, rotor hubs, breathing red-core pulse). Red-core crits ×2.5
- **6-Player Deathmatch (3v3, vs AI)**: you + 2 same-faction AI teammates vs 3 enemy AI. Nova fires controlled bursts, Rogue sprays. 3-minute matches; first to 25 kills ends it early, otherwise the higher kill count wins. Killfeed, TAB scoreboard and respawns — a human death counts on the board and credits the killing bot
- **King of the Hill (3v3, vs AI)**: the same 3v3 squads contest a control point (radius 8 m, marked by a ground ring and a light pillar — cyan when NOVA holds it, orange for ROGUE). **1 point per second of holding it** (+2 while contested); first to **200** wins, otherwise the higher score when the 4-minute clock runs out. Kills are only K/D here. The hill is placed per map on the most open ground near the centre (`pickHill` in `src/modes.js`), so the whole capture zone is walkable
- **Fun Brawl (3v3, vs AI)**: a prank-score arena — kills pay 2, every prop hit pays 1, first to **40** wins. Four hand-modelled props (keys 4–7, built in `src/funProps.js`): **banana** peel (slip: controls cut, momentum slides on), **horseshoe magnet** (6 m field yanks the primary as a weapon crate, 3 s no-fire), **spring** pad (launch), **water bomb** (puddle slows to 35% for 3 s). Bots throw props too; supply boxes refill them. The results screen shows a **per-category scoring breakdown** (kills / banana / magnet / spring / water with a re-summed total — `funApplyScore` in `src/funItems.js`), so you can see whether you won by shooting or by pranking
- **Friends 5v5 (online only)**: room-code lobbies with the same behavior-tree AI filling empty slots (9 AI + player in solo training). Fixed sides A=NOVA / B=ROGUE, snapshot interpolation for remote players, server-authoritative hits/score and a 5-minute room timer. Requires the Worker room service (`/rooms`). The other modes all stay offline
  - Note: online rooms need the Worker room service (`/rooms`); every other mode runs entirely in the browser

## Squad Command Layer (v1.13)

`src/botai/` + `src/squadAI.js` add a commander **above** the per-bot brains. The brains keep doing what they did (perception, aiming, firing, fight footwork, cover, local avoidance); the commander decides *where the squad should be* and hands each local bot an order — move to (x, z) and look at (x, z), or hold a spot facing an entrance:

- **Nav grid** — the whole arena baked into a 0.5 m walkable grid with clearance (A*, line of sight, smoothing). Also the fallback router for a bot whose own 10 m planner finds no way out of a spawn pocket.
- **Tactical map** — cover points, attack lanes (main / flank / lurk with danger / length / exposure scoring), hill entrances and defensive positions derived from the grid.
- **Influence map** — each team's fire coverage plus a decaying death heat; feeds lane scoring and path cost.
- **Squad director** — per team and per phase (attack / defend / escort): lane choice, role assignment by persona (entry / support / flank / lurk / bait, anchor / rotator), timed execution, lane swap after repeated deaths on one lane, crossfire triggers, a Bayesian "which entrance are they coming from" with rotations, gather-then-push retakes, and trade orders for the teammate nearest a kill.
- **Learning** — in-match: a Thompson bandit over attack/defence plans, an opponent route model, and a per-bot engagement tuner. Across matches (offline / solo training only): plan statistics and a bounded difficulty controller (0.8–1.25× on reaction / aim / pause) that pulls the human's win rate toward 50 %. Online rooms get tactics only.

The layer is explicit glue, not monkey-patching: `main.js` calls `squad.update()` before the bots think and reports kills / shots; `botBrain.actPatrol` follows an order only from the idle branch, so combat always outranks it. Each brain owns a private copy of its parameter set (the presets are shared and read-only). A safety net around `update()` means a bug in the layer can never halt a frame; after repeated failures it falls back to the brains' own patrol. `?botai=0` switches it off. Under `?debug=1` the console object `__squadAI` exposes `.debug()`.

## Bot Combat AI (v1.11)

The deathmatch bots are driven by layered systems that replace the old "nearest enemy → shoot" if-chain, on top of the navigation stack (velocity-level separation + RVO, wall slide, stuck escape, local-grid A*):

- **Perception** (`src/botPerception.js`) — view cone + view range + line-of-sight ray, 360° close-proximity awareness, smoke occlusion, gunfire hearing and damage alerts, and a `memoryTime`-bounded memory of the last seen/heard position. Unseen enemies never leak their live position, velocity or health: memory only refreshes on an actual sighting or a fresh sound/damage cue.
- **Behavior tree** (`src/botBehaviorTree.js` + `src/botBrain.js`) — Selector / Sequence / Parallel / Condition / Action nodes. Priority order: finish a reload → break contact to cover when hurt → engage (aim control and footwork run in a Parallel) → search the last known position → patrol the objective. Includes strafing, flanking, engagement bands, tactical reloads and cover selection. Bots check the firing line: a teammate (or the allied player) in the way makes them hold fire and sidestep until the line clears.
- **Aim & cover** (`src/botCombat.js`) — target priority (visible > remembered; closer, wounded, threatening and already-tracked targets score higher), ballistic lead, a range/motion/settle/smoke accuracy model, and scored cover spots that respect `coverBias` / `preferCoverDist`.
- **Self-evolution** (`src/botEvolution.js` + `scripts/evolve-bots.mjs`) — an offline genetic algorithm tunes tactical doctrine (aggression / cover / flank / strafe / stand-off / retreat) against the normal doctrine in a deterministic duel model. `npm run evolve` regenerates `src/botTuning.js`; the winning genome is clamped into `PARAM_RANGES` and merged into the hard preset.

Difficulty (`easy` / `normal` / `hard`, persisted as `botDifficulty`) controls reaction time, aim settling, accuracy, view cone/range, memory, hearing, aggression, cover/flank bias, burst discipline and damage. `?e2e=1` asserts perception memory, target priority, hearing, firing-line blocking and difficulty ordering.

## Scoreboards

`TAB` opens a mode-aware board while playing:

- **Deathmatch** — 6-player team table (operator / faction / kills / deaths), player row highlighted, sorted by kills then deaths; the top HUD shows team kills and the match timer. A bot killing the player is credited to the killer, the player's death row and the killfeed, so the table and the 25-kill win check stay accurate.
- **KOTH** — the same team table plus live capture points for NOVA/ROGUE and capture progress; the HUD adds the control-point bar and score.
- **Waves** — a compact run-status panel (wave / remaining hostiles / score / kills) instead of the PvP table.

A board left open by a held TAB is cleared on pause, next match, menu return, match end and by the results screen, so it cannot leak into another mode. The DM/KOTH end screens also render the full 6-player final table.

## Sponsorship Placements

Three self-illuminated **double-sided** billboards (brand face / large URL face — AbinStudio · AI short-drama production · app.agents100.com), present on all four maps and shootable with persistent bullet holes; sponsor info also appears at the bottom of the main menu.

## Architecture

```
src/
  assets.js   Materials — 1024px procedural Canvas PBR textures (sand / snow / basalt / ice / wet asphalt) + normal maps + weapon wood / faction fabrics + neon signage + billboard art; zero image files
  world.js    Scene — parametric sky shaders (sunset / aurora night / rain night / ember) + four distinct per-map layouts + lighting / fog / ambient particles + a 2 m spatial grid over the static colliders (`SpatialGrid` / `ColliderGrid`)
  weapon.js   Weapons — three-slot loadout viewmodels + first-person arms (tactical gloves) + semi-auto / full-auto triggers + recoil / ADS / reload / shell ejection
  attach.js   Attachment integrity — connected-island check that every weapon part is welded to the gun body (unit test + ?e2e=1)
  heroes.js   Characters — realistic 3D faction operatives (lathe-surface torsos, facial features, hair physics, faction outfits) and 3v3 AI, incl. the bot navigation stack (velocity-level separation + simplified RVO, normal-projection wall slide, stuck escape, local-grid A* + corner routing, squad fan-out)
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
npm run build          # web build → dist/: gun-to-gun.html (~1.1 MB) + assets/characters/{female1,male1}.glb + manifest + icons
npm run build:single   # one self-contained page → dist-single/gun-to-gun.html (double-click, file://)
npm run bake:portraits # re-render the operator thumbnails baked into the bundle (after a look change)
npm test           # unit tests (node --test): utils / weapons / attachment / physics / waves / bot AI / navigation / evolution / KOTH rules / squad AI / online protocol & rooms (254 tests)
npm run test:e2e   # headless Chrome/Edge integration suite (?e2e=1), 82 assertions
npm run evolve     # regenerate the GA-tuned bot doctrine (src/botTuning.js)
npm run test:load   # slow-link loading check (60 KB/s): loading screen, menu, model switch (append -- --gpu for real boot numbers)
npm run serve      # local server http://127.0.0.1:8137/ (testing only)
npm run server:dev # local Worker room service (wrangler dev), for online 5v5 testing
```

> The online build bakes the room endpoint via `GTG_SERVER=wss://<host> npm run build` (same-origin `/rooms` for `game.agents100.com`). `npm run test:e2e` needs Chrome or Edge; it starts its own static server and private browser profile.

Built-in verification hooks:

- `?shot=menu|combat|dm|over` — jump straight into a state for screenshot review
- `?selftest=1` — weapon self-test (primary hit-kill + Desert Eagle semi-auto + UMP-45 full-auto burst); results in the debug bar and console
- `?e2e=1` — **system integration test**: 82 end-to-end assertions (loading / ADS / recoil ballistics / gravity / landing / crouch / weapons / attachment integrity / crits / XSS / 360° look / **bot perception & memory** / **target priority** / **hearing** / **firing-line blocking** / **difficulty presets** / **DM / KOTH / waves scoreboards** / **KOTH first blood, pacing and hill placement** / **squad orders, whole-map routing, empty-route latch** / **text contrast on every screen** / **player-death scoring** / **online 5v5 AI fill, sides and loopback net**); result on `window.__e2e`
- `?debug=1` — exposes `__GTG_DEBUG__` (the game), `__squadAI` and `__modelAssets` for the console
- `?perf=1` — hitch monitor: slow-frame (>25 ms) count and max frame time reported to console periodically
- `?ipcc=US` / `?ipcc=CN` — force the interface language (default: auto by IP — English overseas / Chinese in China; silent fallback on probe failure)

## Deployment & Loading

When hosting in the cloud, **upload the whole `dist/` folder**: `gun-to-gun.html` + `assets/characters/*.glb` + `manifest.webmanifest` + icons. The character models are separate files in the web build (they are fetched right after the menu is up); uploading only the HTML leaves the game on its procedural characters.

- **Loading, step by step** (measured at 60 KB/s on a slow link, `npm run test:load`): the first bytes already paint a static loading screen with the eight operator faces (baked thumbnails ride in the HTML, no JS needed) → after the ~1.1 MB program download the menu appears with the same faces → the two rigs (0.85 MB) finish and the cards / characters switch to the live models. Before v1.13 the whole 3.3 MB page — 2 MB of it base64 models — had to arrive before anything ran.
- **No offline worker**: the service worker was removed; revisits rely on the host's normal HTTP cache. Returning visitors may still have the old worker registered, so the page unregisters it once and drops its cache.
- **Language detection**: the hosted version detects the UI language from the client IP (English overseas / Chinese in China). This is the only optional external call — it fails silently and never affects the game itself.
- **Single-file build**: `npm run build:single` embeds the rigs after the bundle (inert `<script>` tags read on demand) for play from `file://`; it makes no separate requests at all.


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
- [x] Squad command layer: nav grid, tactical map, influence map, plans / roles / rotations / retakes, per-bot parameter isolation, whole-map routing fallback
- [x] Mode-aware scoreboards: DM/KOTH team tables with live HUD scores, waves run panel, player deaths credited to the killing bot, stale boards cleared on transitions
- [x] Production hardening: nickname XSS escaping, dirty-storage fallbacks, context-loss recovery, exception circuit breaker, zero-allocation hot paths, map-switch disposal
- [x] Zero console errors; web build ~1.1 MB page + 0.85 MB character rigs loaded after the menu, two shared rigs (one male, one female); single-file build available (`build:single`); static loading screen with operator faces; no install