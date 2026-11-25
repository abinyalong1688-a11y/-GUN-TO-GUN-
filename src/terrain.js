// terrain.js — single source of truth for the rendered ground height.
//
// Movement, collision, bot AI and every spawn use y = 0 as the walkable plane. The rendered
// ground used to undulate by ±0.5 m across that same area, so boots visibly sank into (or
// hovered above) the terrain — a pure art/collision mismatch, not a capsule problem. The
// playable disc is therefore geometrically flat; dunes fade in only beyond the arena boundary
// (the player is clamped to r = 56, bots to r = 52).
//
// Keep this module free of three.js: world.js and the tests share it; movement stays on y=0.

export const ARENA_FLAT_RADIUS = 58;      // one 3.27 m ground-mesh ring beyond the r=56 player bound
export const TERRAIN_BLEND_RADIUS = 72;   // full dune amplitude resumes here
const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* Same two-octave noise the old inline ground displacement used. */
function noise(x, z) {
  return Math.sin(x * 0.045) * Math.cos(z * 0.038) + Math.sin(x * 0.11 + z * 0.07) * 0.5;
}

/* Rendered ground height at world (x, z). Exactly 0 inside the arena. */
export function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  if (r <= ARENA_FLAT_RADIUS) return 0;
  const k = smoothstep(ARENA_FLAT_RADIUS, TERRAIN_BLEND_RADIUS, r);
  let h = noise(x, z) * 0.5;
  if (r > 64) h += Math.pow((r - 64) / 70, 1.6) * (5 + noise(x * 0.5 + 9, z * 0.5 - 4) * 4.5);
  return h * k;
}
