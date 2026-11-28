// funProps.js — Fun Brawl prop models (banana / horseshoe magnet / coil spring / water bomb).
//   · zero external assets: every shape is assembled from Three.js primitives, following the
//     project-wide rule (character.js GEO cache / enemies.js G table);
//   · geometry is cached by key so a dozen peels on the ground still share one buffer, and all
//     materials are module-level singletons — a prop only ever allocates its Group wrapper;
//   · each prop has TWO looks: the object as it leaves the hand, and what it becomes on landing
//     (banana → peel, spring → flat pad, water bomb → puddle). The magnet fires its field on
//     contact and is gone the same frame, so it only needs the thrown shape.
//   · low-poly by design: every part is ≤16 radial segments and a whole prop stays far under
//     1.5k triangles. Nothing here casts shadows (the shadow map is updated on alternate frames).
import * as THREE from 'three';

/* ============ Geometry cache (same contract as character.js) ============ */
const GEO = new Map();
const geo = (key, make) => {
  let g = GEO.get(key);
  if (!g) { g = make(); GEO.set(key, g); }
  return g;
};
const cyl = (rt, rb, h, seg = 8) => geo(`c|${rt}|${rb}|${h}|${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
const sph = (r, ws = 10, hs = 8) => geo(`s|${r}|${ws}|${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
const tor = (r, t, rs = 6, ts = 14, arc = Math.PI * 2) =>
  geo(`t|${r}|${t}|${rs}|${ts}|${arc}`, () => new THREE.TorusGeometry(r, t, rs, ts, arc));
const circle = (r, seg = 24, wobble = 0) =>
  geo(`ci|${r}|${seg}|${wobble}`, () => {
    const g = new THREE.CircleGeometry(r, seg);
    if (wobble) {
      /* Deterministic radial wobble turns a perfect disc into a natural puddle outline, with no
         extra draw call and no runtime randomness (every client sees the same shape). */
      const pos = g.attributes.position;
      for (let i = 1; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const a = Math.atan2(y, x);
        const k = 1 + .10 * Math.sin(3 * a + 1.3) + .06 * Math.sin(7 * a + .4);
        pos.setX(i, x * k); pos.setY(i, y * k);
      }
      pos.needsUpdate = true;
    }
    return g;
  });
const ring = (inner, outer, seg = 20) =>
  geo(`r|${inner}|${outer}|${seg}`, () => new THREE.RingGeometry(inner, outer, seg));

/* A helix, for the spring. Built once and cached; getPoint is the standard parametersation. */
class HelixCurve extends THREE.Curve {
  constructor(r, h, turns) { super(); this.r = r; this.h = h; this.turns = turns; }
  getPoint(t, target = new THREE.Vector3()) {
    const a = Math.PI * 2 * this.turns * t;
    return target.set(Math.cos(a) * this.r, this.h * t - this.h * .5, Math.sin(a) * this.r);
  }
}
const tube = (key, curve, tubular, radius, radial = 5) =>
  geo(`tu|${key}`, () => new THREE.TubeGeometry(curve, tubular, radius, radial, false));

/* ============ Shared materials ============ */
let MATS = null;
function mats() {
  if (MATS) return MATS;
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const basic = (o) => new THREE.MeshBasicMaterial(o);
  MATS = {
    bananaBody:  std({ color: 0xf2d95a, emissive: 0xd8b21e, emissiveIntensity: .4, roughness: .55, metalness: .05 }),
    bananaInner: std({ color: 0xf7efc6, roughness: .85, metalness: .0 }),
    bananaTip:   std({ color: 0x5b4326, roughness: .9, metalness: .0 }),
    magnetRed:   std({ color: 0xd8503e, emissive: 0xd8503e, emissiveIntensity: .12, roughness: .38, metalness: .45 }),
    magnetSteel: std({ color: 0xcfd6de, roughness: .22, metalness: .9 }),
    magnetDark:  std({ color: 0x2b3038, roughness: .6, metalness: .5 }),
    springSteel: std({ color: 0x9fb6c8, roughness: .3, metalness: .85 }),
    springBlue:  std({ color: 0x6ad1f5, emissive: 0x6ad1f5, emissiveIntensity: .28, roughness: .4, metalness: .5 }),
    springGlow:  basic({ color: 0xa8ecff, transparent: true, opacity: .55, blending: THREE.AdditiveBlending,
                         depthWrite: false, side: THREE.DoubleSide }),
    waterSkin:   std({ color: 0x63c4f0, emissive: 0x1c5f9e, emissiveIntensity: .30, roughness: .08,
                       metalness: .0, transparent: true, opacity: .72 }),
    waterCore:   std({ color: 0x2f7fc4, roughness: .5, metalness: .0 }),
    waterDeep:   std({ color: 0x2b6fa8, roughness: .1, metalness: .2, transparent: true, opacity: .5,
                       depthWrite: false, side: THREE.DoubleSide }),
    waterFoam:   basic({ color: 0xbfe9ff, transparent: true, opacity: .38, blending: THREE.AdditiveBlending,
                         depthWrite: false, side: THREE.DoubleSide }),
    waterGlint:  basic({ color: 0xffffff, transparent: true, opacity: .5, depthWrite: false }),
  };
  return MATS;
}

/* Add a transformed mesh to a group. Euler order is the Three.js default XYZ, i.e. Rz is applied
   to the geometry first — the prop builders below rely on that (see the peel flaps / magnet bend). */
function put(parent, g, mat, x, y, z, rx = 0, ry = 0, rz = 0, order) {
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  if (order) m.rotation.order = order;
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

/* ============================================================================ BANANA ==== */
/* Thrown: a whole ripe banana bent into an arc. One tube swept along a shallow curve gives a
   continuous, gap-free body in a single mesh — assembling it from separate cylinders left visible
   seams at every joint, which read as "a string of yellow beads" at throwing distance. */
const BAN_CURVE = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-.150, .050, 0),
  new THREE.Vector3(-.075, .008, 0),
  new THREE.Vector3(0, .000, 0),
  new THREE.Vector3(.075, .008, 0),
  new THREE.Vector3(.150, .050, 0),
], false, 'centripetal');
function buildBanana() {
  const M = mats(), g = new THREE.Group();
  const body = put(g, tube('banana|arc', BAN_CURVE, 22, .027, 8), M.bananaBody, 0, .02, 0);
  /* Real bananas are not round in section: flatten the tube slightly. */
  body.scale.z = .88;
  /* Blossom tip and a stubby stalk close both ends. */
  put(g, sph(.014, 6, 5), M.bananaTip, .152, .070, 0);
  put(g, cyl(.010, .016, .045, 6), M.bananaTip, -.168, .062, 0, 0, 0, .55);
  return g;
}

/* Landed: four peel flaps splayed flat from a pale core. The cross silhouette reads instantly.
   Scaled up from the real fruit: at 0.3 m on bright snow or sand a literal banana peel is
   invisible from eye height, and a trap the player cannot see is just a cheap shot. */
function buildPeel() {
  const M = mats(), g = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const A = i * Math.PI / 2, len = .21 + (i % 2) * .035;
    /* Rz first lays the cylinder down onto +X, then Ry fans it around the vertical axis. */
    put(g, cyl(.014, .055, len, 6), M.bananaBody,
      Math.cos(A) * .105, .018, -Math.sin(A) * .105,
      0, A, -Math.PI / 2);
  }
  const core = put(g, sph(.058, 8, 6), M.bananaInner, 0, .018, 0);
  core.scale.y = .35;
  /* A slightly bent stalk poking out of the middle. */
  put(g, cyl(.013, .018, .07, 6), M.bananaTip, 0, .058, 0, .18);
  g.scale.setScalar(1.25);
  return g;
}

/* ============================================================================ MAGNET ==== */
/* The classic horseshoe: a half-torus bend with two straight legs and steel pole faces. arc=PI
   is exactly the horseshoe curve; rotation.z=PI flips the half-ring so its ends sit at x=±R, y=0,
   which lets the legs be placed on those x values with no trigonometry. */
function buildMagnet() {
  const M = mats(), g = new THREE.Group();
  const R = .11, TB = .034, LIFT = .055;
  put(g, tor(R, TB, 8, 14, Math.PI), M.magnetRed, 0, LIFT, 0, 0, 0, Math.PI);
  for (const s of [-1, 1]) {
    put(g, cyl(TB, TB, .09, 8), M.magnetRed, s * R, LIFT + .10, 0);
    put(g, tor(TB, .008, 4, 10), M.magnetDark, s * R, LIFT + .128, 0, Math.PI / 2);
    put(g, cyl(TB * 1.06, TB * 1.06, .026, 8), M.magnetSteel, s * R, LIFT + .158, 0);
  }
  /* Shift the whole group so its origin sits at the visual centre (props tumble about the origin). */
  g.position.y = 0;
  g.children.forEach(c => { c.position.y -= .10; });
  return g;
}

/* ============================================================================ SPRING ==== */
/* Thrown: a real helix (TubeGeometry along HelixCurve) between two thin steel end plates. */
const SPR_R = .06, SPR_H = .13, SPR_TURNS = 3.25;
function buildSpring() {
  const M = mats(), g = new THREE.Group();
  put(g, tube(`helix|${SPR_R}|${SPR_H}|${SPR_TURNS}`, new HelixCurve(SPR_R, SPR_H, SPR_TURNS), 42, .014, 5),
    M.springSteel, 0, 0, 0);
  put(g, cyl(.075, .080, .014, 12), M.springBlue, 0, -SPR_H / 2 - .007, 0);
  put(g, cyl(.070, .070, .014, 12), M.springBlue, 0, SPR_H / 2 + .007, 0);
  /* Slightly larger than life: a 15 cm spring is a few pixels wide at throwing distance. */
  g.scale.setScalar(1.15);
  return g;
}

/* Landed: the spring compressed into a launch pad. Seen from above a helix is unreadable, so the
   coil becomes three concentric flattened rings — the shape that says "spring" in silhouette.
   A glowing top ring marks it as steppable. */
function buildSpringPad() {
  const M = mats(), g = new THREE.Group();
  put(g, cyl(.38, .40, .055, 16), M.springBlue, 0, .028, 0);
  put(g, tor(.38, .014, 4, 16), M.springBlue, 0, .055, 0, Math.PI / 2);
  const radii = [.20, .14, .085];
  radii.forEach((r, i) => put(g, tor(r, .014, 5, 14), M.springSteel, 0, .058 + i * .014, 0, Math.PI / 2));
  put(g, cyl(.09, .09, .02, 12), M.springBlue, 0, .105, 0);
  /* The glow ring is the "you can step on this" cue — wide and additive so it reads from a
     distance on every map, including the white snow one. */
  const glow = put(g, ring(.30, .37, 24), M.springGlow, 0, .058, 0, -Math.PI / 2);
  glow.renderOrder = 3;
  return g;
}

/* ========================================================================= WATER BOMB ==== */
/* Thrown: a rubber water balloon — translucent skin with a distinct water core inside, a tied
   neck and a specular glint. The core being a separate opaque sphere is what sells "full of water". */
function buildWaterBomb() {
  const M = mats(), g = new THREE.Group();
  const body = put(g, sph(.115, 12, 10), M.waterSkin, 0, 0, 0);
  body.scale.y = 1.08;
  const core = put(g, sph(.080, 10, 8), M.waterCore, 0, -.006, 0);
  core.scale.y = 1.05;
  put(g, cyl(.024, .038, .045, 8), M.waterSkin, 0, .128, 0);
  put(g, tor(.028, .008, 4, 10), M.magnetDark, 0, .124, 0, Math.PI / 2);
  /* Fixed highlight: guarantees a sphere read even under flat lighting. */
  put(g, sph(.016, 6, 4), M.waterGlint, -.048, .048, .072);
  return g;
}

/* Landed: a puddle sized to the real gameplay radius. Layered by height + depthWrite:false +
   renderOrder instead of polygon offset. depthTest stays ON — a puddle must not show through walls. */
function buildPuddle(radius) {
  const M = mats(), g = new THREE.Group();
  const R = radius;
  const base = put(g, circle(R, 28, 1), M.waterSkin, 0, .012, 0, -Math.PI / 2);
  base.renderOrder = 1;
  const deep = put(g, circle(R * .62, 20), M.waterDeep, 0, .016, 0, -Math.PI / 2);
  deep.renderOrder = 2;
  const foam = put(g, ring(R * .93, R * .99, 28), M.waterFoam, 0, .019, 0, -Math.PI / 2);
  foam.renderOrder = 3;
  /* Three ripples, rising slightly so they never z-fight the base disc. */
  [[.15, .18], [.46, .50], [.72, .75]].forEach(([a, b], i) => {
    const rp = put(g, ring(R * a, R * b, 22), M.waterFoam, 0, .022 + i * .003, 0, -Math.PI / 2);
    rp.renderOrder = 4;
  });
  return g;
}

/* ============================================================================ API ==== */
let PUDDLE_R = 2.2;
/* The puddle is drawn at the same radius the slowdown check uses, so "looks wet" and "is wet"
   can never disagree. funItems.js sets this once from FUN_DEFS.water.radius. */
export function setPropPuddleRadius(r) { if (r > 0) PUDDLE_R = r; }

/* Build the model for a prop.
     stage 'fly'  — the object as it leaves the hand
     stage 'rest' — what it becomes on the ground (banana → peel, spring → pad, water → puddle)
   The magnet has no resting form: it bursts on contact, so 'rest' returns the thrown shape and
   funItems.js removes it in the same frame. */
export function makeProp(type, stage = 'fly') {
  if (type === 'banana') return stage === 'rest' ? buildPeel() : buildBanana();
  if (type === 'magnet') return buildMagnet();
  if (type === 'spring') return stage === 'rest' ? buildSpringPad() : buildSpring();
  if (type === 'water') return stage === 'rest' ? buildPuddle(PUDDLE_R) : buildWaterBomb();
  return new THREE.Group();
}

/* Release every cached buffer / material. Note: these are app-lifetime singletons (the same
   contract as character.js), so this is only for a full teardown, not per-match cleanup. */
export function disposePropAssets() {
  for (const g of GEO.values()) g.dispose();
  GEO.clear();
  if (MATS) {
    for (const k in MATS) MATS[k].dispose && MATS[k].dispose();
    MATS = null;
  }
}
