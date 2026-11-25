// los.js — server-side line-of-sight, pure (no three.js), Node-testable.
//
// The client bakes every LOS-blocking static into one of two vertical primitives:
//   box  = [0, cx, cz, hw, hd, ry, y0, y1]   (rotated box: centre XZ, half-width, half-depth, yaw, bottom, top)
//   cyl  = [1, cx, cz, r, y0, y1]            (vertical cylinder: centre XZ, radius, bottom, top)
//
// A shot is blocked iff the 3D segment (origin → target) pierces any primitive:
// first an exact 2D test in the XZ plane (segment vs rotated rect / circle), then a
// vertical Y-slab test over the same overlap interval. This matches the client's own
// raycast closely enough that legitimate hits are not falsely rejected, while wall
// shots are caught regardless of what the client claims.

const EPS = 1e-9;

// --- vertical slab: t-interval where the ray's Y lies inside [y0, y1] ---
function yInterval(oy, ty, y0, y1) {
  if (oy < y0 && ty < y0) return null;
  if (oy > y1 && ty > y1) return null;
  const dy = ty - oy;
  let a = 0, b = 1;
  if (Math.abs(dy) > EPS) {
    a = (y0 - oy) / dy;
    b = (y1 - oy) / dy;
    if (a > b) { const t = a; a = b; b = t; }
  }
  a = Math.max(0, a); b = Math.min(1, b);
  return a > b ? null : [a, b];
}

// --- 2D segment vs axis-aligned rect ---
function segAABB2D(ox, oz, dx, dz, minX, maxX, minZ, maxZ) {
  let t0 = 0, t1 = 1;
  if (Math.abs(dx) < EPS) {
    if (ox < minX || ox > maxX) return null;
  } else {
    let a = (minX - ox) / dx, b = (maxX - ox) / dx;
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  if (Math.abs(dz) < EPS) {
    if (oz < minZ || oz > maxZ) return null;
  } else {
    let a = (minZ - oz) / dz, b = (maxZ - oz) / dz;
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

// --- 2D segment vs rotated rect (box local frame) ---
// Must use the same convention as collision.js and the rendered mesh: for rotation.y = +ry,
// world → local is  lx = dx·cos − dz·sin ,  lz = dx·sin + dz·cos.
function segRect2D(ox, oz, tx, tz, cx, cz, hw, hd, ry) {
  const c = Math.cos(ry), s = Math.sin(ry);
  const ox2 = (ox - cx) * c - (oz - cz) * s;
  const oz2 = (ox - cx) * s + (oz - cz) * c;
  const tx2 = (tx - cx) * c - (tz - cz) * s;
  const tz2 = (tx - cx) * s + (tz - cz) * c;
  return segAABB2D(ox2, oz2, tx2 - ox2, tz2 - oz2, -hw, hw, -hd, hd);
}

// --- 2D segment vs circle ---
function segCircle2D(ox, oz, tx, tz, cx, cz, r) {
  const dx = tx - ox, dz = tz - oz;
  const fx = ox - cx, fz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < EPS) return (fx * fx + fz * fz <= r * r) ? [0, 1] : null;
  const b = 2 * (fx * dx + fz * dz);
  const cc = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t0 = (-b - sq) / (2 * a), t1 = (-b + sq) / (2 * a);
  t0 = Math.max(0, t0); t1 = Math.min(1, t1);
  return t0 > t1 ? null : [t0, t1];
}

export function losBlocked(geo, ox, oy, oz, tx, ty, tz) {
  if (!geo) return false;
  for (let i = 0; i < geo.length; i++) {
    const g = geo[i];
    const isBox = g[0] === 0;
    const xzI = isBox
      ? segRect2D(ox, oz, tx, tz, g[1], g[2], g[3], g[4], g[5])
      : segCircle2D(ox, oz, tx, tz, g[1], g[2], g[3]);
    if (!xzI) continue;
    const y0 = isBox ? g[6] : g[4];
    const y1 = isBox ? g[7] : g[5];
    const yI = yInterval(oy, ty, y0, y1);
    if (!yI) continue;
    if (Math.max(xzI[0], yI[0]) <= Math.min(xzI[1], yI[1])) return true;
  }
  return false;
}

/* Cheap deterministic hash so the DO can detect a client that uploads a different map
   than the one already trusted (a tampered geometry upload). Not cryptographic. */
export function hashGeo(geo) {
  let h = 5381;
  for (const g of geo) {
    for (const v of g) {
      const n = Math.round(v * 1000);       // 1 mm resolution — kills float drift between browsers
      h = ((h << 5) + h + n) & 0x7fffffff;
    }
    h = ((h << 5) + h + 7) & 0x7fffffff;
  }
  return h;
}
