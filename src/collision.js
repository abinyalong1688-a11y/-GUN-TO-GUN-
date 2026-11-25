// collision.js — shared circle-vs-collider push-out.
// Supports the legacy flat AABB shape and the rotated-box (OBB) shape written by world.addBox.
//
// Rotation convention: world.addBox builds the mesh with `mesh.rotation.y = ry`, and three.js
// R_y(ry) maps local → world as
//     wx = lx·cos(ry) + lz·sin(ry)
//     wz = −lx·sin(ry) + lz·cos(ry)
// so the world → local inverse used below (and in server/los.js) is
//     lx = dx·cos(ry) − dz·sin(ry)
//     lz = dx·sin(ry) + dz·cos(ry)
// Using the forward matrix instead mirrored the footprint about the box's diagonal: invisible
// walls on one side of every rotated container and walk-through geometry on the other.

/* Footprint test used by support/headroom queries. Uses the true OBB when available so a
   player can never stand on the empty corner of a rotated box's bounding AABB. */
export function circleOverlapsCollider(px, pz, r, c) {
  if (c.ry && c.w && c.d) {
    const co = Math.cos(c.ry), si = Math.sin(c.ry);
    const dx = px - c.x, dz = pz - c.z;
    const lx = dx * co - dz * si, lz = dx * si + dz * co;
    const qx = Math.max(-c.w / 2, Math.min(c.w / 2, lx));
    const qz = Math.max(-c.d / 2, Math.min(c.d / 2, lz));
    return (lx - qx) ** 2 + (lz - qz) ** 2 < r * r;
  }
  const cx = Math.max(c.minX, Math.min(px, c.maxX));
  const cz = Math.max(c.minZ, Math.min(pz, c.maxZ));
  return (px - cx) ** 2 + (pz - cz) ** 2 < r * r;
}

export function pushCircleOut(pos, r, c) {
  // Rotated box path: work in the box's local frame so corners are not solid.
  if (c.ry && c.w && c.d) {
    const co = Math.cos(c.ry), si = Math.sin(c.ry);
    const dx = pos.x - c.x, dz = pos.z - c.z;
    let lx = dx * co - dz * si;          // world -> local (inverse rotation)
    let lz = dx * si + dz * co;
    const hx = c.w / 2, hz = c.d / 2;
    const qx = Math.max(-hx, Math.min(hx, lx));
    const qz = Math.max(-hz, Math.min(hz, lz));
    let ox = lx - qx, oz = lz - qz;
    const d2 = ox * ox + oz * oz;
    if (d2 >= r * r) return false;
    if (d2 < 1e-8) {
      // Centre inside the box: pop out along the shallowest local face.
      const l = hx - lx, rr = hx + lx, b = hz - lz, t = hz + lz;
      const m = Math.min(l, rr, b, t);
      if (m === rr) { lx = hx + r; lz = qz; }
      else if (m === l) { lx = -hx - r; lz = qz; }
      else if (m === b) { lx = qx; lz = -hz - r; }
      else { lx = qx; lz = hz + r; }
    } else {
      const d = Math.sqrt(d2), k = (r - d) / d;
      lx += ox * k; lz += oz * k;
    }
    pos.x = c.x + lx * co + lz * si;     // local -> world
    pos.z = c.z - lx * si + lz * co;
    return true;
  }

  // Legacy AABB path (unchanged behaviour).
  const cx = Math.max(c.minX, Math.min(pos.x, c.maxX));
  const cz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
  const dx = pos.x - cx, dz = pos.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return false;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2), push = (r - d) / d;
    pos.x += dx * push; pos.z += dz * push;
  } else {
    const l = pos.x - c.minX, rr = c.maxX - pos.x;
    const t = pos.z - c.minZ, b = c.maxZ - pos.z;
    const m = Math.min(l, rr, t, b);
    // Prefer +X on ties, matching the original bot behaviour and its unit test.
    if (m === rr) pos.x = c.maxX + r;
    else if (m === l) pos.x = c.minX - r;
    else if (m === b) pos.z = c.maxZ + r;
    else pos.z = c.minZ - r;
  }
  return true;
}
