// Unified four-map placement validator requested by the clipping audit.
// Run: npm run test:map-validate
import * as THREE from 'three';
import { pathToFileURL } from 'node:url';
import { buildWorld, MAPS } from '../src/world.js';
import { circleOverlapsCollider } from '../src/collision.js';
import { pickHill, KOTH_RADIUS } from '../src/modes.js';
import { coverPointsFor, isPointClear } from '../src/botCombat.js';

const TH = .02;
const MAP_KEYS = Object.keys(MAPS);

function stubAssets() {
  const mat = new THREE.MeshBasicMaterial(), tex = new THREE.Texture();
  return {
    mats: new Proxy({}, { get: () => mat }),
    ground: new Proxy({}, { get: () => mat }),
    containers: new Proxy({}, { get: () => mat }),
    tex: new Proxy({}, { get: () => tex }),
  };
}

function build(key) { return buildWorld(new THREE.Scene(), stubAssets(), 'high', key); }

function meshList(world) {
  const out = [];
  world.group.updateMatrixWorld(true);
  world.group.traverse(o => {
    if (!o.isMesh || o === world.sky || o === world.ground) return;
    const box = new THREE.Box3().setFromObject(o), center = box.getCenter(new THREE.Vector3());
    if (Math.hypot(center.x, center.z) > 58 || box.min.y > 16) return;
    out.push({ mesh: o, name: o.name || o.geometry.type, box, center });
  });
  return out;
}

function byName(list, name) { return list.filter(m => m.name === name); }
function overlapXZ(a, b) {
  return Math.max(0, Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x)) *
         Math.max(0, Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z));
}
function colliderBox(c) {
  return new THREE.Box3(
    new THREE.Vector3(c.minX, c.bottom ?? 0, c.minZ),
    new THREE.Vector3(c.maxX, c.top, c.maxZ));
}
function matchCollider(world, m) {
  let best = null, score = 1e9;
  for (const c of world.colliders) {
    const cx = (c.minX + c.maxX) / 2, cz = (c.minZ + c.maxZ) / 2;
    const s = Math.hypot(m.center.x - cx, m.center.z - cz) + Math.abs(m.box.max.y - c.top) * 4;
    if (s < score) { score = s; best = c; }
  }
  return score < .35 ? best : null;
}
function issue(out, map, category, object, pos, detail) {
  out.push({ map, category, object, pos: pos.map(v => +v.toFixed(3)), detail });
}
function near(a, b, eps = TH) { return Math.abs(a - b) <= eps; }

function checkOverlap(world, map, out) {
  const cs = world.colliders;
  for (let i = 0; i < cs.length; i++) for (let j = 0; j < i; j++) {
    const a = cs[i], b = cs[j];
    const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const oy = Math.min(a.top, b.top) - Math.max(a.bottom ?? 0, b.bottom ?? 0);
    const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
    if (ox > TH && oy > TH && oz > TH) issue(out, map, '穿模',
      `collider #${i} × #${j}`,
      [(a.minX + a.maxX) / 2, (a.top + (a.bottom ?? 0)) / 2, (a.minZ + a.maxZ) / 2],
      `overlap ${ox.toFixed(3)}×${oy.toFixed(3)}×${oz.toFixed(3)} m; other centre ` +
      `${((b.minX + b.maxX) / 2).toFixed(2)},${((b.minZ + b.maxZ) / 2).toFixed(2)}`);
  }
}

function checkFloating(world, map, meshes, out) {
  const grounded = /^(world-box-|supply-barrel|basalt-column|street-lamp-pole|signal-mast|radar-pole|floodlight-pole|neon-sign-pole|watchtower-platform|watchtower-cab|trapper-hut-roof|basalt-arch-pillar|mid-basalt-arch-pillar|northern-gate-pillar)/;
  for (const m of meshes) {
    if (m.mesh.userData.visualOnly || !grounded.test(m.name) || m.name === 'command-tent-roof') continue;
    const bottom = m.box.min.y;
    if (bottom <= .1) continue;
    const supported = world.colliders.some(c => {
      if (c.top < bottom - .06 || c.top > bottom + .5) return false;
      return overlapXZ(m.box, colliderBox(c)) > .02;
    });
    if (!supported) issue(out, map, '悬浮', m.name, m.center.toArray(),
      `bottom ${bottom.toFixed(3)} m has no supporting collider top within 0.5 m`);
  }
}

function checkStacking(world, map, meshes, out) {
  const boxes = meshes.filter(m => m.name.startsWith('world-box-') && m.mesh.userData.assemblyRole !== 'rail')
    .map(m => ({ ...m, c: matchCollider(world, m) })).filter(m => m.c);
  for (let i = 0; i < boxes.length; i++) for (let j = 0; j < i; j++) {
    let upper = boxes[i], lower = boxes[j];
    if (upper.box.min.y < lower.box.min.y) [upper, lower] = [lower, upper];
    const gap = upper.box.min.y - lower.box.max.y;
    if (Math.abs(gap) > .06 || upper.box.max.y - lower.box.max.y < .3 || upper.box.max.y - lower.box.max.y > 3) continue;
    const ox = Math.min(upper.box.max.x, lower.box.max.x) - Math.max(upper.box.min.x, lower.box.min.x);
    const oz = Math.min(upper.box.max.z, lower.box.max.z) - Math.max(upper.box.min.z, lower.box.min.z);
    if (ox <= .02 || oz <= .02) continue;
    const upperArea = (upper.box.max.x - upper.box.min.x) * (upper.box.max.z - upper.box.min.z);
    const ratio = ox * oz / upperArea;
    const overX = Math.max(0, lower.box.min.x - upper.box.min.x, upper.box.max.x - lower.box.max.x);
    const overZ = Math.max(0, lower.box.min.z - upper.box.min.z, upper.box.max.z - lower.box.max.z);
    const limitX = Math.min(.4, (lower.box.max.x - lower.box.min.x) * .2);
    const limitZ = Math.min(.4, (lower.box.max.z - lower.box.min.z) * .2);
    const centreIn = upper.center.x >= lower.box.min.x && upper.center.x <= lower.box.max.x &&
                     upper.center.z >= lower.box.min.z && upper.center.z <= lower.box.max.z;
    const sizeX = (upper.box.max.x - upper.box.min.x) / (lower.box.max.x - lower.box.min.x);
    const sizeZ = (upper.box.max.z - upper.box.min.z) / (lower.box.max.z - lower.box.min.z);
    if (ratio < .7 - 1e-6 || overX > limitX + TH || overZ > limitZ + TH || !centreIn || sizeX > 1.1 + 1e-6 || sizeZ > 1.1 + 1e-6) {
      issue(out, map, '叠放越界', `${upper.name} on ${lower.name}`, upper.center.toArray(),
        `overlap ${(ratio * 100).toFixed(1)}% (<70%), overhang ${overX.toFixed(3)}/${overZ.toFixed(3)} m ` +
        `(limit ${limitX.toFixed(3)}/${limitZ.toFixed(3)}), centreIn=${centreIn}, sizeRatio=${sizeX.toFixed(3)}/${sizeZ.toFixed(3)}`);
    }
  }
}

function contact(out, map, label, lowers, upper, { centre = false, tol = TH } = {}) {
  if (!lowers.length || !upper) return;
  const lowerY = Math.max(...lowers.map(m => m.box.max.y));
  const upperY = upper.box.min.y;
  if (!near(lowerY, upperY, tol)) issue(out, map, '装配错位', label, upper.center.toArray(),
    `lower top ${lowerY.toFixed(3)} ≠ upper bottom ${upperY.toFixed(3)}`);
  if (centre) {
    const x = lowers.reduce((s, m) => s + m.center.x, 0) / lowers.length;
    const z = lowers.reduce((s, m) => s + m.center.z, 0) / lowers.length;
    if (Math.hypot(upper.center.x - x, upper.center.z - z) > .05) issue(out, map, '装配错位', label, upper.center.toArray(),
      `upper centre ${upper.center.x.toFixed(2)},${upper.center.z.toFixed(2)} ≠ support midpoint ${x.toFixed(2)},${z.toFixed(2)}`);
  }
}

function checkAssemblies(map, meshes, out) {
  const one = n => byName(meshes, n)[0];
  const all = n => byName(meshes, n);
  contact(out, map, 'watchtower platform → cab', all('watchtower-platform'), one('watchtower-cab'), { centre: true });
  contact(out, map, 'watchtower cab → roof', all('watchtower-cab'), one('watchtower-roof'), { centre: true });
  contact(out, map, 'watchtower roof → antenna', all('watchtower-roof'), one('watchtower-antenna'), { centre: true });
  contact(out, map, 'watchtower antenna → beacon', all('watchtower-antenna'), one('watchtower-beacon'), { centre: true });
  // The detached trapper roof is now a ground prop beside the cabin, not an assembled top.
  contact(out, map, 'ice pillars → lintel', all('ice-arch-pillar'), one('ice-arch-lintel'), { centre: true });
  contact(out, map, 'south basalt pillars → lintel', all('basalt-arch-pillar'), one('basalt-arch-lintel'), { centre: true });
  contact(out, map, 'mid basalt pillars → lintel', all('mid-basalt-arch-pillar'), one('mid-basalt-arch-lintel'), { centre: true });
  contact(out, map, 'gantry legs → beam', all('gantry-leg'), one('gantry-beam'), { centre: true });
  if (one('gantry-beam') && one('gantry-trolley')) {
    const beam = one('gantry-beam'), trolley = one('gantry-trolley');
    if (!near(trolley.box.max.y, beam.box.min.y)) issue(out, map, '装配错位', 'gantry beam → trolley', trolley.center.toArray(),
      `trolley top ${trolley.box.max.y.toFixed(3)} ≠ beam bottom ${beam.box.min.y.toFixed(3)}`);
  }
  const foundation = one('command-tent-foundation'), roof = one('command-tent-roof');
  for (const post of all('command-tent-post')) {
    if (foundation && !near(post.box.min.y, foundation.box.max.y)) issue(out, map, '装配错位', 'tent foundation → post', post.center.toArray(),
      `post bottom ${post.box.min.y.toFixed(3)} ≠ foundation top ${foundation.box.max.y.toFixed(3)}`);
    if (roof && !near(post.box.max.y, roof.box.min.y)) issue(out, map, '装配错位', 'tent post → roof', post.center.toArray(),
      `post top ${post.box.max.y.toFixed(3)} ≠ roof bottom ${roof.box.min.y.toFixed(3)}`);
  }
  contact(out, map, 'radar pole → dish', all('radar-pole'), one('radar-dish'), { tol: .03 });
  contact(out, map, 'signal mast → beacon', all('signal-mast'), one('signal-beacon'));
  contact(out, map, 'floodlight pole → head', all('floodlight-pole'), one('floodlight-head'));
  if (one('floodlight-head')) for (const bulb of all('floodlight-bulb')) {
    if (!near(bulb.box.max.y, one('floodlight-head').box.min.y)) issue(out, map, '装配错位', 'floodlight head → bulb', bulb.center.toArray(),
      `bulb top ${bulb.box.max.y.toFixed(3)} ≠ head bottom ${one('floodlight-head').box.min.y.toFixed(3)}`);
  }
  for (const pole of all('street-lamp-pole')) {
    const head = meshes.filter(m => m.name === 'street-lamp-head' && Math.hypot(m.center.x - pole.center.x, m.center.z - pole.center.z) < 1)[0];
    const bulb = meshes.filter(m => m.name === 'street-lamp-bulb' && Math.hypot(m.center.x - pole.center.x, m.center.z - pole.center.z) < 1)[0];
    if (head && !near(head.box.min.y, pole.box.max.y)) issue(out, map, '装配错位', 'street lamp pole → head', head.center.toArray(),
      `head bottom ${head.box.min.y.toFixed(3)} ≠ pole top ${pole.box.max.y.toFixed(3)}`);
    if (head && bulb && !near(bulb.box.max.y, head.box.min.y)) issue(out, map, '装配错位', 'street lamp head → bulb', bulb.center.toArray(),
      `bulb top ${bulb.box.max.y.toFixed(3)} ≠ head bottom ${head.box.min.y.toFixed(3)}`);
  }
  const signPole = one('neon-sign-pole');
  const poleSign = meshes.find(m => m.name === 'neon-sign-back-face' && Math.hypot(m.center.x - signPole?.center.x, m.center.z - signPole?.center.z) < 1);
  if (signPole && poleSign && (poleSign.box.min.y > signPole.box.max.y || poleSign.box.max.y < signPole.box.min.y))
    issue(out, map, '装配错位', 'neon sign pole → panel', poleSign.center.toArray(), 'pole does not intersect panel vertical span');
}

function checkMounts(map, meshes, out) {
  for (const m of meshes) {
    const mount = m.mesh.userData.mount;
    if (!mount) continue;
    const target = mount.target, P = m.mesh.geometry.parameters;
    const n = new THREE.Vector3(0, 0, mount.face === '+z' ? 1 : -1).applyQuaternion(target.quaternion);
    const facePoint = target.position.clone().addScaledVector(n, target.geometry.parameters.depth / 2);
    const corners = [];
    for (const x of [-P.width / 2, P.width / 2]) for (const y of [-P.height / 2, P.height / 2]) {
      corners.push(new THREE.Vector3(x, y, -mount.plate / 2).applyMatrix4(m.mesh.matrixWorld));
    }
    const gaps = corners.map(p => p.clone().sub(facePoint).dot(n));
    const min = Math.min(...gaps), max = Math.max(...gaps);
    const backNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(m.mesh.quaternion);
    const facing = backNormal.dot(n); // +1: artwork side faces away from the container
    const parallel = Math.abs(facing);
    if (min < mount.wave - .002 || max > mount.wave + .012 || parallel < .999 || facing < .999) issue(out, map, '贴面间隙', m.name, m.center.toArray(),
      `corner gap ${min.toFixed(4)}..${max.toFixed(4)} m (target ${mount.wave.toFixed(3)}..${(mount.wave + .01).toFixed(3)}), facing=${facing.toFixed(4)}`);
  }
}

function checkSizes(world, map, meshes, out) {
  for (const m of meshes) {
    if (!m.mesh.userData.losBox) continue;
    const c = matchCollider(world, m);
    if (!c) { issue(out, map, '尺寸一致性', m.name, m.center.toArray(), 'no matching collider'); continue; }
    const P = m.mesh.geometry.parameters;
    if (!near(c.w, P.width, 1e-6) || !near(c.d, P.depth, 1e-6) || !near(c.ry || 0, m.mesh.rotation.y, 1e-6) ||
        !near(c.bottom ?? 0, m.box.min.y, 1e-6) || !near(c.top, m.box.max.y, 1e-6)) {
      issue(out, map, '尺寸一致性', m.name, m.center.toArray(),
        `mesh ${P.width}×${P.height}×${P.depth} ry${m.mesh.rotation.y.toFixed(3)} ≠ collider ${c.w}×${c.top - (c.bottom ?? 0)}×${c.d} ry${(c.ry || 0).toFixed(3)}`);
    }
  }
  const roof = byName(meshes, 'trapper-hut-roof')[0];
  if (roof) {
    const c = matchCollider(world, roof);
    const side = roof.mesh.geometry.parameters.radius * Math.SQRT2;
    if (!c || !near(c.w, side, 1e-6) || !near(c.d, side, 1e-6) || !near(c.bottom, roof.box.min.y, 1e-6) || !near(c.top, roof.box.max.y, 1e-6))
      issue(out, map, '尺寸一致性', roof.name, roof.center.toArray(), 'roof collider does not match its square base');
  }
}

function checkReachability(world, map, out) {
  for (const p of world.spawnPoints) {
    if (world.colliders.some(c => circleOverlapsCollider(p.x, p.z, .45, c)))
      issue(out, map, '可达性', 'spawn', p.toArray(), 'spawn overlaps static collider');
  }
  const spawns = [new THREE.Vector3(0, 0, 24), new THREE.Vector3(0, 0, -24)];
  const hill = pickHill(world.colliders, { radius: KOTH_RADIUS, spawns });
  if (hill.clearance < KOTH_RADIUS - .5) issue(out, map, '可达性', 'KOTH', [hill.x, 0, hill.z], `clearance ${hill.clearance.toFixed(3)} < 7.5`);
  const walk = world.colliders.filter(c => c.bottom == null || c.bottom < 1.8);
  for (const p of coverPointsFor(world)) {
    if (!isPointClear(p.x, p.z, walk, .46)) issue(out, map, '可达性', 'cover point', [p.x, 0, p.z], 'cover point is inside geometry');
  }
}

export function validateAll() {
  const issues = [], visualOnly = [], stats = [];
  for (const map of MAP_KEYS) {
    const world = build(map), meshes = meshList(world);
    checkOverlap(world, map, issues);
    checkFloating(world, map, meshes, issues);
    checkStacking(world, map, meshes, issues);
    checkAssemblies(map, meshes, issues);
    checkMounts(map, meshes, issues);
    checkSizes(world, map, meshes, issues);
    checkReachability(world, map, issues);
    for (const m of meshes) if (m.mesh.userData.visualOnly && !matchCollider(world, m))
      visualOnly.push({ map, object: m.name, pos: m.center.toArray().map(v => +v.toFixed(2)) });
    stats.push({ map, colliders: world.colliders.length, losStatics: world.losStatics.length, coverPoints: coverPointsFor(world).length });
  }
  return { issues, visualOnly, stats };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { issues, visualOnly, stats } = validateAll();
  console.table(stats);
  for (const map of MAP_KEYS) {
    const rows = issues.filter(x => x.map === map);
    console.log(`\n[${map}] ${rows.length} 不合格项`);
    if (rows.length) console.table(rows);
  }
  console.log(`\n视觉件（无独立 collider，已单独列出，不计不合格）: ${visualOnly.length}`);
  if (visualOnly.length) console.table(visualOnly);
  console.log(issues.length ? `\nFAIL: ${issues.length} 项` : '\nPASS: 0 不合格项');
  process.exitCode = issues.length ? 1 : 0;
}
