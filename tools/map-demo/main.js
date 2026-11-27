import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { A, initAssets } from '../../src/assets.js';
import { buildWorld, disposeWorld, MAPS } from '../../src/world.js';

const MAP_KEYS = Object.keys(MAPS);
const INFO = {
  desert: {
    label: '沙漠哨站', sub: 'Desert Outpost · Sunset',
    note: '重点看浅色掩体/木箱分离、沙袋双层支撑率、帐篷四柱承托、camo 平台栏杆落位及塔顶球与天线对齐。',
  },
  snow: {
    label: '冰川湖泊', sub: 'Glacier Lake · Aurora',
    note: '重点看斜冰脊间距、箱堆 18 cm 稳定错层，以及 trapper 小屋屋顶已移到舱体东侧地面。',
  },
  snowtown: {
    label: '霓虹码头', sub: 'Neon Docklands · Rain',
    note: '重点看三块霓虹牌贴集装箱局部面、箱堆 18 cm 错层、探照灯/路灯装配，以及龙门吊横梁与小车落位。',
  },
  ember: {
    label: '火山臼地', sub: 'Volcano Caldera',
    note: '重点看河岸石间距、玄武岩柱 collider，以及第二座玄武岩拱门横梁底部与柱顶的 0 间隙。',
  },
};
const EXPOSURE = { desert: 1.18, snow: 0.9, snowtown: 1.8, ember: 1.6 };
const FIXES = {
  desert: [
    [3.9, 5.5, '浅色掩体 z 5.2→5.5'],
    [3.11, 3.6, '顶层箱居中落在东侧底座'],
    [2.62, 4.05, '沙袋上层偏移 .9→.12 m'],
    [-2, -10.5, '帐篷增加四柱承托'],
    [-12.75, 0, 'camo 栏杆落在 tier2 顶面'],
    [18, -13, '塔顶球底 = 天线顶 9.9'],
    [10.03, 2.9, '油桶 x 10.1→10.03'],
    [8.45, -2, '灯杆 x 8→8.45'],
  ],
  snow: [
    [-13, -5.4, '冰脊 A z -4.5→-5.4'],
    [-9, 3.7, '冰脊 C z 3→3.7'],
    [-1.6, 9.2, '木箱 (-1.8,9)→(-1.6,9.2)'],
    [5.18, 6, '箱堆错层 .9→.18 m'],
    [11.18, -8, '箱堆错层 .9→.18 m'],
    [18.3, -12, '屋顶移到地面 (14,-12)→(18.3,-12)'],
  ],
  snowtown: [
    [-1.69, -13, '西霓虹牌贴集装箱 +z 面'],
    [3.69, 1.8, '东霓虹牌贴集装箱 -z 面'],
    [9.87, -13.7, '北霓虹牌贴局部面'],
    [8.18, 8.5, '箱堆错层 .9→.18 m'],
    [13.18, -1, '箱堆错层 .9→.18 m'],
    [11.8, -2, '灯柱 x 12→11.8'],
    [-15.2, 6.8, '办公室箱堆 z 7→6.8'],
    [28, -16, '龙门吊梁底 = 柱顶 16'],
  ],
  ember: [
    [-7.6, 17.12, '岸石间距 1.65→1.95'],
    [7.95, -6.7, '柱 offset -1.8→-2.05'],
    [12.85, 1.3, '柱 offset -1.9→-2.15'],
    [5.95, 11, '柱 offset -1.8→-2.05'],
    [11.5, 4, '第二拱门梁底 = 柱顶 3.8'],
  ],
};

const $ = s => document.querySelector(s);
const viewport = $('#viewport');
const loading = $('#loading');
const state = { key: 'desert', colliders: false, markers: false, fog: false, tour: false, view: 'persp' };
let world = null, colliderGroup = null, markerGroup = null, tourTimer = null;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE.desert;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, viewport.clientWidth / viewport.clientHeight, .06, 600);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = .08;
controls.minDistance = 8;
controls.maxDistance = 125;
controls.minPolarAngle = .001;
controls.maxPolarAngle = Math.PI / 2 - .015;
controls.target.set(0, 0, 0);
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
pmrem.dispose();

function makeMapTabs() {
  $('#maps').innerHTML = MAP_KEYS.map((key, i) =>
    `<button data-map="${key}" class="${key === state.key ? 'active' : ''}">${i + 1} · ${INFO[key].label}</button>`).join('');
  for (const b of document.querySelectorAll('[data-map]')) b.addEventListener('click', () => loadMap(b.dataset.map));
}

function clearGroup(group) {
  if (!group) return;
  scene.remove(group);
  const mats = new Set();
  group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) mats.add(o.material);
  });
  for (const m of mats) {
    if (m.map) m.map.dispose();
    m.dispose();
  }
}

function buildColliderGizmos() {
  clearGroup(colliderGroup);
  colliderGroup = new THREE.Group();
  colliderGroup.name = 'collider-gizmos';
  const groundMat = new THREE.LineBasicMaterial({ color: 0x62d9ff, transparent: true, opacity: .62, depthWrite: false });
  const overheadMat = new THREE.LineBasicMaterial({ color: 0xc986ff, transparent: true, opacity: .72, depthWrite: false });
  for (const c of world.colliders) {
    const x = c.x ?? (c.minX + c.maxX) / 2;
    const z = c.z ?? (c.minZ + c.maxZ) / 2;
    const w = c.w ?? (c.maxX - c.minX);
    const d = c.d ?? (c.maxZ - c.minZ);
    const bottom = c.bottom ?? 0;
    const box = new THREE.BoxGeometry(w, c.top - bottom, d);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    const line = new THREE.LineSegments(edges, bottom >= 1.8 ? overheadMat : groundMat);
    line.position.set(x, (bottom + c.top) / 2, z);
    line.rotation.y = c.ry || 0;
    colliderGroup.add(line);
  }
  colliderGroup.visible = state.colliders;
  scene.add(colliderGroup);
}

function labelSprite(text) {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 112;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(22,14,7,.88)';
  g.beginPath(); g.roundRect(6, 6, 628, 100, 22); g.fill();
  g.strokeStyle = '#ff9a45'; g.lineWidth = 3; g.stroke();
  g.fillStyle = '#ffb56e';
  g.beginPath(); g.arc(46, 56, 13, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff5e8'; g.font = '600 30px "Microsoft YaHei", sans-serif';
  g.textBaseline = 'middle'; g.fillText(text, 78, 57, 530);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(8.2, 1.44, 1);
  return sprite;
}

function buildMarkers() {
  clearGroup(markerGroup);
  markerGroup = new THREE.Group();
  markerGroup.name = 'fix-markers';
  const ringGeo = new THREE.RingGeometry(1.15, 1.42, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xff9a45, transparent: true, opacity: .9, side: THREE.DoubleSide, depthWrite: false });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xff9a45, transparent: true, opacity: .75 });
  for (const [x, z, label] of FIXES[state.key]) {
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, .07, z);
    markerGroup.add(ring);
    const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x, .08, z), new THREE.Vector3(x, 4.4, z),
    ]), lineMat);
    markerGroup.add(stem);
    const sprite = labelSprite(label);
    sprite.position.set(x, 5.15, z);
    markerGroup.add(sprite);
  }
  markerGroup.visible = state.markers;
  scene.add(markerGroup);
}

function obbOverlap(a, b) {
  const rect = c => {
    if (c.w && c.d && c.ry != null) {
      const co = Math.cos(c.ry), si = Math.sin(c.ry);
      return { x: c.x, z: c.z, ux: [co, -si], uz: [si, co], hw: c.w / 2, hd: c.d / 2 };
    }
    return {
      x: (c.minX + c.maxX) / 2, z: (c.minZ + c.maxZ) / 2,
      ux: [1, 0], uz: [0, 1], hw: (c.maxX - c.minX) / 2, hd: (c.maxZ - c.minZ) / 2,
    };
  };
  const A = rect(a), B = rect(b);
  for (const axis of [A.ux, A.uz, B.ux, B.uz]) {
    const proj = R => Math.abs(axis[0] * R.ux[0] + axis[1] * R.ux[1]) * R.hw +
      Math.abs(axis[0] * R.uz[0] + axis[1] * R.uz[1]) * R.hd;
    if (Math.abs(axis[0] * (A.x - B.x) + axis[1] * (A.z - B.z)) > proj(A) + proj(B) + 1e-6) return false;
  }
  return true;
}

function auditColliders() {
  const cs = world.colliders, bad = [], TH = .02;
  for (let i = 0; i < cs.length; i++) for (let j = 0; j < i; j++) {
    const a = cs[i], b = cs[j];
    const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const oy = Math.min(a.top, b.top) - Math.max(a.bottom ?? 0, b.bottom ?? 0);
    const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
    if (!(ox > TH && oy > TH && oz > TH)) continue;
    bad.push({
      i, j, ox, oy, oz, real: obbOverlap(a, b),
      ca: [((a.minX + a.maxX) / 2).toFixed(2), ((a.minZ + a.maxZ) / 2).toFixed(2)],
      cb: [((b.minX + b.maxX) / 2).toFixed(2), ((b.minZ + b.maxZ) / 2).toFixed(2)],
    });
  }
  return bad;
}

function updateAudit() {
  const bad = auditColliders();
  const real = bad.filter(x => x.real).length;
  $('#audit').className = 'audit ' + (bad.length ? 'bad' : 'ok');
  $('#audit span').textContent = bad.length ? `${bad.length} (${real} REAL)` : '0';
  $('#conflict-list').textContent = bad.length ? bad.map(x =>
    `#${x.i} @ ${x.ca.join(',')} × #${x.j} @ ${x.cb.join(',')}\n` +
    `  overlap ${x.ox.toFixed(3)} / ${x.oy.toFixed(3)} / ${x.oz.toFixed(3)} · ${x.real ? 'REAL' : 'aabb-only'}`
  ).join('\n') : '无 >2 cm 冲突';
  return bad;
}

function updateUI() {
  const i = MAP_KEYS.indexOf(state.key);
  $('#map-index').textContent = String(i + 1).padStart(2, '0');
  $('#map-name').textContent = INFO[state.key].sub.split(' · ')[0];
  $('#map-sub').textContent = INFO[state.key].sub;
  $('#map-note').textContent = INFO[state.key].note;
  $('#stat-colliders').textContent = world.colliders.length;
  $('#stat-los').textContent = world.losStatics.length;
  $('#stat-fixes').textContent = FIXES[state.key].length;
  for (const b of document.querySelectorAll('[data-map]')) b.classList.toggle('active', b.dataset.map === state.key);
  syncButtons();
}

function syncButtons() {
  const map = { colliders: state.colliders, markers: state.markers, fog: state.fog, tour: state.tour };
  for (const [act, on] of Object.entries(map)) {
    const b = document.querySelector(`[data-act="${act}"]`);
    if (b) b.classList.toggle('on', on);
  }
}

function setView(view) {
  state.view = view;
  if (view === 'top') {
    camera.up.set(0, 1, 0);
    camera.position.set(0, 42, .001);
    controls.target.set(0, 0, 0);
    controls.enableRotate = false;
  } else {
    camera.up.set(0, 1, 0);
    camera.position.set(38, 34, 42);
    controls.target.set(0, 0, 0);
    controls.enableRotate = true;
  }
  controls.update();
}

function loadMap(key) {
  if (!MAP_KEYS.includes(key)) return;
  state.key = key;
  if (world) disposeWorld(scene, world);
  clearGroup(colliderGroup); colliderGroup = null;
  clearGroup(markerGroup); markerGroup = null;
  world = buildWorld(scene, A, 'high', key);
  scene.fog = state.fog ? new THREE.FogExp2(...world.map.fog) : null;
  renderer.toneMappingExposure = EXPOSURE[key] || 1.18;
  buildColliderGizmos();
  buildMarkers();
  updateAudit();
  updateUI();
  setView(state.view);
  loading.classList.add('done');
}

function toggleTour() {
  state.tour = !state.tour;
  clearInterval(tourTimer);
  if (state.tour) tourTimer = setInterval(() => {
    loadMap(MAP_KEYS[(MAP_KEYS.indexOf(state.key) + 1) % MAP_KEYS.length]);
  }, 10000);
  syncButtons();
}

function bindUI() {
  for (const b of document.querySelectorAll('[data-act]')) b.addEventListener('click', async () => {
    const act = b.dataset.act;
    if (act === 'top') setView('top');
    else if (act === 'persp') setView('persp');
    else if (act === 'colliders') { state.colliders = !state.colliders; if (colliderGroup) colliderGroup.visible = state.colliders; syncButtons(); }
    else if (act === 'markers') { state.markers = !state.markers; if (markerGroup) markerGroup.visible = state.markers; syncButtons(); }
    else if (act === 'fog') {
      state.fog = !state.fog;
      scene.fog = state.fog ? new THREE.FogExp2(...world.map.fog) : null;
      syncButtons();
    } else if (act === 'tour') toggleTour();
    else if (act === 'full') {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    }
  });
  addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key >= '1' && e.key <= '4') loadMap(MAP_KEYS[Number(e.key) - 1]);
    else if (e.code === 'Space') { e.preventDefault(); toggleTour(); }
    else if (e.key.toLowerCase() === 't') setView('top');
    else if (e.key.toLowerCase() === 'p') setView('persp');
    else if (e.key.toLowerCase() === 'c') document.querySelector('[data-act="colliders"]').click();
    else if (e.key.toLowerCase() === 'm') document.querySelector('[data-act="markers"]').click();
    else if (e.key.toLowerCase() === 'f') document.querySelector('[data-act="fog"]').click();
  });
}

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

makeMapTabs();
bindUI();
setView('persp');
try {
  initAssets();
  loadMap('desert');
  requestAnimationFrame(() => loading.classList.add('done'));
} catch (err) {
  loading.textContent = '地图生成失败：' + err.message;
  console.error(err);
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  if (world) for (const fn of world.worldAnim) fn(t);
  controls.update();
  renderer.render(scene, camera);
}
animate();
