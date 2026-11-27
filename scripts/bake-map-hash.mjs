// bake-map-hash.mjs — recompute the canonical LOS-geometry hash of every arena.
//
// The DO trusts a C.WORLD upload only when its hash matches MAP_HASHES in src/netProtocol.js,
// so that table has to be regenerated whenever a map layout (src/world.js) changes:
//
//   node scripts/bake-map-hash.mjs           # print the table
//   node scripts/bake-map-hash.mjs --write    # rewrite MAP_HASHES in src/netProtocol.js
//
// Run it from the repo root; it uses the same hashGeo() the Worker uses.
import * as THREE from 'three';
import {readFileSync, writeFileSync} from 'fs';
import {buildWorld} from '../src/world.js';
import {hashGeo} from '../server/los.js';

const MAPS = ['desert', 'snow', 'snowtown', 'ember'];

/* buildWorld only needs materials/textures to exist; it never samples them during the bake. */
function stubAssets() {
  const mk = () => new THREE.MeshBasicMaterial();
  return {
    mats: new Proxy({}, {get: mk}),
    ground: new Proxy({}, {get: mk}),
    containers: new Proxy({}, {get: mk}),
    tex: new Proxy({}, {get: () => new THREE.Texture()}),
  };
}

const assets = stubAssets();
const table = {};
for (const key of MAPS) {
  const w = buildWorld(new THREE.Scene(), assets, 'high', key);
  const again = buildWorld(new THREE.Scene(), assets, 'high', key);
  const h = hashGeo(w.losGeo);
  if (h !== hashGeo(again.losGeo)) {
    console.error(`✗ ${key}: hash is not deterministic — the map build depends on state`);
    process.exit(1);
  }
  table[key] = String(h);
  console.log(`${key.padEnd(9)} ${String(w.losGeo.length).padStart(3)} shapes  hash ${h}`);
}

if (process.argv.includes('--write')) {
  const path = 'src/netProtocol.js';
  const src = readFileSync(path, 'utf8');
  const body = MAPS.map(k => `  ${k}:${' '.repeat(Math.max(1, 9 - k.length))}'${table[k]}',`).join('\n');
  const pattern = /export const MAP_HASHES = \{[\s\S]*?\};/;
  if (!pattern.test(src)) {
    console.error('✗ could not find the MAP_HASHES block in src/netProtocol.js');
    process.exit(1);
  }
  const next = src.replace(pattern, `export const MAP_HASHES = {\n${body}\n};`);
  if (next === src) {
    console.log('✓ MAP_HASHES already current');
    process.exit(0);
  }
  writeFileSync(path, next);
  console.log('✓ MAP_HASHES updated in src/netProtocol.js — re-run the build');
} else {
  console.log('\nexport const MAP_HASHES = {');
  for (const k of MAPS) console.log(`  ${k}:'${table[k]}',`);
  console.log('};');
}
