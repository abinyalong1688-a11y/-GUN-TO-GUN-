/*
 * Browser-console prop overlap detector for GUN TO GUN.
 *
 * Usage:
 *   1. Open the debug build: http://localhost:8138/?debug=1&map=desert
 *      (or any build loaded with ?debug=1, which exposes window.__GTG_DEBUG__).
 *   2. Paste this whole file into DevTools Console and press Enter.
 *   3. To scan all four maps, first run:  __GTG_AUDIT_ALL__ = true
 *      then paste again. The helper switches maps with ui.sel.map + startGame(),
 *      so do not use it during a live match.
 *
 * Threshold: a pair is reported when the intersection is deeper than 2 cm on
 * ALL THREE axes. Face contact / stacking (0 overlap) is allowed.
 * `obb` adds a cheap SAT refinement: addBox colliders carry their true w/d/ry,
 * so rotated long boxes can be flagged by AABB yet be visually clear.
 */
(() => {
  const TH = 0.02;
  const MAPS = ['desert', 'snow', 'snowtown', 'ember'];
  const findGame = () => window.__GTG_DEBUG__ || window.game || window.GTG || window.__game;
  const g = findGame();
  if (!g || !g.world || !g.world.colliders) {
    console.error('[AABB audit] No game found. Load the build with ?debug=1 and wait for the match to start.');
    return;
  }

  // 2D separating-axis test for the exact oriented footprints stored on addBox colliders.
  const obbOverlap = (a, b) => {
    const rect = c => {
      if (c.w && c.d && c.ry != null) {
        const co = Math.cos(c.ry), si = Math.sin(c.ry);
        return { x: c.x, z: c.z, ux: [co, -si], uz: [si, co], hw: c.w / 2, hd: c.d / 2 };
      }
      return {
        x: (c.minX + c.maxX) / 2, z: (c.minZ + c.maxZ) / 2,
        ux: [1, 0], uz: [0, 1],
        hw: (c.maxX - c.minX) / 2, hd: (c.maxZ - c.minZ) / 2,
      };
    };
    const A = rect(a), B = rect(b);
    for (const axis of [A.ux, A.uz, B.ux, B.uz]) {
      const proj = R => Math.abs(axis[0] * R.ux[0] + axis[1] * R.ux[1]) * R.hw +
                        Math.abs(axis[0] * R.uz[0] + axis[1] * R.uz[1]) * R.hd;
      const dist = Math.abs(axis[0] * (A.x - B.x) + axis[1] * (A.z - B.z));
      if (dist > proj(A) + proj(B) + 1e-6) return false; // separating axis exists
    }
    return true;
  };

  const audit = (label) => {
    const cols = g.world.colliders;
    const rows = [];
    for (let i = 0; i < cols.length; i++) for (let j = 0; j < i; j++) {
      const a = cols[i], b = cols[j];
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oy = Math.min(a.top, b.top) - Math.max(a.bottom ?? 0, b.bottom ?? 0);
      const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      if (!(ox > TH && oy > TH && oz > TH)) continue;
      const ca = [((a.minX + a.maxX) / 2).toFixed(2), ((a.minZ + a.maxZ) / 2).toFixed(2)];
      const cb = [((b.minX + b.maxX) / 2).toFixed(2), ((b.minZ + b.maxZ) / 2).toFixed(2)];
      rows.push({
        pair: `#${i} × #${j}`,
        centerA: ca.join(','), centerB: cb.join(','),
        overlapXYZ: `${ox.toFixed(3)} / ${oy.toFixed(3)} / ${oz.toFixed(3)}`,
        obb: oy > TH && obbOverlap(a, b) ? 'REAL' : 'aabb-only',
      });
    }
    const real = rows.filter(r => r.obb === 'REAL').length;
    console.log(`[AABB audit] ${label}: ${rows.length} >2cm pairs, ${real} true OBB intersections ` +
                `(${cols.length} colliders, ${g.world.losStatics.length} LOS statics)`);
    if (rows.length) console.table(rows);
    return { map: label, conflicts: rows.length, real, rows };
  };

  const results = [];
  if (window.__GTG_AUDIT_ALL__) {
    for (const key of MAPS) {
      g.ui.sel.map = key; g.ui.sel.mode = 'dm'; g.startGame();
      results.push(audit(key));
    }
  } else {
    results.push(audit(g.world.mapKey));
    console.info('[AABB audit] Set __GTG_AUDIT_ALL__ = true and paste again to scan all maps.');
  }
  window.__GTG_AABB_RESULT__ = results;
  return results;
})();
