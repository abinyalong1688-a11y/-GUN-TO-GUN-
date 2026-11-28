// funProps.js — Fun Brawl prop models (banana / horseshoe magnet / coil spring / water bomb).
//   · zero external assets: every shape is assembled from Three.js primitives (plus two small
//     custom buffers: the ribbed banana tube and the balloon lathe), following the project-wide
//     rule (character.js GEO cache / enemies.js G table);
//   · geometry is cached by key so a dozen peels on the ground still share one buffer, and all
//     materials are module-level singletons — a prop only ever allocates its Group wrapper;
//   · each prop has TWO looks: the object as it leaves the hand, and what it becomes on landing
//     (banana → peel, spring → pad, water bomb → puddle). The magnet fires its field on
//     contact and is gone the same frame, so it only needs the thrown shape.
//   · low-poly by design: every part is ≤16 radial segments and a whole prop stays far under
//     1.5k triangles. Nothing here casts shadows (the shadow map is updated on alternate frames).
//   · fully deterministic: no Math.random anywhere in a builder, so every client (and the boot
//     prewarm frame) builds byte-identical models.
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
         extra draw call and no runtime randomness (every client sees the same shape). Three
         harmonics give the rim a hand-drawn irregularity a single sine cannot. */
      const pos = g.attributes.position;
      for (let i = 1; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const a = Math.atan2(y, x);
        const k = 1 + wobble * (.55 * Math.sin(3 * a + 1.3) + .30 * Math.sin(7 * a + .4) + .15 * Math.sin(11 * a + 2.1));
        pos.setX(i, x * k); pos.setY(i, y * k);
      }
      pos.needsUpdate = true;
      g.computeVertexNormals();
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

/* Ribbed sweep: the banana's body needs a 5-ridge cross-section and vertex colors running from
   the green stem to the brown blossom tip — none of that fits TubeGeometry's round single-color
   tube. Built once per shape and cached; normals are the radial directions (smooth shading, the
   ridges read through the silhouette and the shading gradient across each facet). */
const _c = new THREE.Color(), _c2 = new THREE.Color();
function ribbedTube(key, curve, tubular, radial, radiusFn, colorFn, capA, capB) {
  return geo(key, () => {
    const frames = curve.computeFrenetFrames(tubular, false);
    const pos = [], col = [], nrm = [], idx = [];
    const P = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i <= tubular; i++) {
      const t = i / tubular;
      curve.getPointAt(t, P);
      const N = frames.normals[i], B = frames.binormals[i];
      for (let j = 0; j <= radial; j++) {
        const a = j / radial * Math.PI * 2;
        const r = radiusFn(t, a);
        v.copy(P).addScaledVector(N, Math.cos(a) * r).addScaledVector(B, Math.sin(a) * r);
        pos.push(v.x, v.y, v.z);
        const c = colorFn(t, a);
        col.push(c.r, c.g, c.b);
        nrm.push(N.x * Math.cos(a) + B.x * Math.sin(a), N.y * Math.cos(a) + B.y * Math.sin(a), N.z * Math.cos(a) + B.z * Math.sin(a));
      }
    }
    for (let i = 0; i < tubular; i++) for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    /* End caps: a fan from the ring to a centre vertex, coloured like the cut skin. A null
       colour leaves that end open (the peel flaps tuck their root into the fruit core). */
    const cap = (centreColor, flip) => {
      if (!centreColor) return;
      curve.getPointAt(flip ? 1 : 0, P);
      const ci = pos.length / 3;
      pos.push(P.x, P.y, P.z);
      col.push(centreColor.r, centreColor.g, centreColor.b);
      nrm.push((flip ? -1 : 1) * frames.tangents[flip ? tubular : 0].x,
        (flip ? -1 : 1) * frames.tangents[flip ? tubular : 0].y,
        (flip ? -1 : 1) * frames.tangents[flip ? tubular : 0].z);
      const ringAt = flip ? tubular * (radial + 1) : 0;
      for (let j = 0; j < radial; j++) {
        if (flip) idx.push(ci, ringAt + j + 1, ringAt + j);
        else idx.push(ci, ringAt + j, ringAt + j + 1);
      }
    };
    cap(capA, false);
    cap(capB, true);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    return g;
  });
}
/* Deterministic value hash: peel freckles land on the same vertices on every client. */
const frac = x => x - Math.floor(x);
const hash2 = (t, a) => frac(Math.sin(t * 127.1 + a * 311.7) * 43758.5453);
const lerpC = (out, c1, c2, k) => out.copy(c1).lerp(c2, Math.max(0, Math.min(1, k)));

/* ============ Shared materials ============ */
let MATS = null;
function mats() {
  if (MATS) return MATS;
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const basic = (o) => new THREE.MeshBasicMaterial(o);
  MATS = {
    /* Banana skin is vertex-colored (stem green → ripe yellow → brown tip + freckles). */
    bananaSkin:  std({ vertexColors: true, roughness: .52, metalness: .02 }),
    bananaCream: std({ color: 0xf7efc6, roughness: .82, metalness: 0 }),
    bananaCut:   std({ color: 0xfbf6dd, roughness: .9, metalness: 0 }),
    bananaStem:  std({ color: 0x4c6626, roughness: .85, metalness: 0 }),
    bananaTip:   std({ color: 0x5b4326, roughness: .9, metalness: 0 }),
    /* Lacquered toy magnet: a clearcoat red over a hint of emissive so it pops against snow. */
    magnetRed:   new THREE.MeshPhysicalMaterial({ color: 0xd8503e, roughness: .30, metalness: .08,
                     clearcoat: .65, clearcoatRoughness: .25, emissive: 0x581508, emissiveIntensity: .3 }),
    magnetSteel: std({ color: 0xd6dde8, roughness: .16, metalness: .95 }),
    magnetDark:  std({ color: 0x2b3038, roughness: .55, metalness: .5 }),
    magnetSpark: basic({ color: 0xffd9a0, transparent: true, opacity: .85, blending: THREE.AdditiveBlending,
                         depthWrite: false }),
    magnetArc:   basic({ color: 0x9fdcff, transparent: true, opacity: .38, blending: THREE.AdditiveBlending,
                         depthWrite: false, side: THREE.DoubleSide }),
    springSteel: std({ color: 0x9fb6c8, roughness: .28, metalness: .88 }),
    springBlue:  std({ color: 0x6ad1f5, emissive: 0x1a7fa8, emissiveIntensity: .5, roughness: .35, metalness: .4 }),
    springBolt:  std({ color: 0x39434f, roughness: .4, metalness: .7 }),
    springCore:  std({ color: 0xdff6ff, emissive: 0x8fdcff, emissiveIntensity: 1.1, roughness: .2 }),
    springGlow:  basic({ color: 0xa8ecff, transparent: true, opacity: .5, blending: THREE.AdditiveBlending,
                         depthWrite: false, side: THREE.DoubleSide }),
    waterSkin:   std({ color: 0x63c4f0, emissive: 0x1c5f9e, emissiveIntensity: .30, roughness: .07,
                       metalness: .0, transparent: true, opacity: .72 }),
    waterCore:   std({ color: 0x2f7fc4, roughness: .45, metalness: .0 }),
    waterDeep:   std({ color: 0x2b6fa8, roughness: .1, metalness: .2, transparent: true, opacity: .5,
                       depthWrite: false, side: THREE.DoubleSide }),
    waterFoam:   basic({ color: 0xbfe9ff, transparent: true, opacity: .4, blending: THREE.AdditiveBlending,
                         depthWrite: false, side: THREE.DoubleSide }),
    waterWet:    std({ color: 0x27506e, transparent: true, opacity: .28, roughness: .15, metalness: 0,
                       depthWrite: false, side: THREE.DoubleSide }),
    waterGlint:  basic({ color: 0xffffff, transparent: true, opacity: .55, depthWrite: false }),
  };
  return MATS;
}

/* Add a transformed mesh to a group. Euler order is the Three.js default XYZ, i.e. Rz is applied
   to the geometry first — the prop builders below rely on that (see the peel flaps / magnet bend). */
function put(parent, g, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, order) {
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  if (order) m.rotation.order = order;
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

/* ============================================================================ BANANA ==== */
/* Thrown: a whole ripe banana bent into a C. The body is one ribbed sweep (5 ridges like the
   real fruit) with vertex colors: green at the stalk, ripe yellow over the belly, brown at the
   blossom tip, plus deterministic freckles. One mesh, one draw call, ~260 tris. */
const BAN_CURVE = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-.165, -.010, 0),
  new THREE.Vector3(-.082, .048, 0),
  new THREE.Vector3(0, .062, 0),
  new THREE.Vector3(.082, .048, 0),
  new THREE.Vector3(.165, -.010, 0),
], false, 'centripetal');
const BAN_SKIN_A = new THREE.Color(0x5f7d33), BAN_SKIN_B = new THREE.Color(0xf2d95a),
  BAN_SKIN_C = new THREE.Color(0x7a5a26), BAN_FRECKLE = new THREE.Color(0xb98a3a),
  BAN_CAP_A = new THREE.Color(0x4c6626), BAN_CAP_B = new THREE.Color(0x6b4f22);
function buildBanana() {
  const M = mats(), g = new THREE.Group();
  const radiusFn = (t, a) => (.026 + .008 * Math.pow(Math.sin(Math.PI * t), .7)) * (.86 + .14 * Math.cos(5 * a));
  const colorFn = (t, a) => {
    if (t < .10) lerpC(_c, BAN_SKIN_A, BAN_SKIN_B, t / .10);
    else if (t > .92) lerpC(_c, BAN_SKIN_B, BAN_SKIN_C, (t - .92) / .08);
    else lerpC(_c, BAN_SKIN_B, BAN_SKIN_B, 0);
    if (t > .22 && t < .88 && hash2(t, a) < .055) _c.lerp(BAN_FRECKLE, .65);
    return _c;
  };
  const body = put(g, ribbedTube('banana|ribs', BAN_CURVE, 22, 5, radiusFn, colorFn, BAN_CAP_A, BAN_CAP_B), M.bananaSkin);
  body.scale.z = .88;   // real bananas are slightly flattened in section
  /* Stalk stub and blossom tip close both ends with real silhouette. */
  put(g, cyl(.010, .016, .05, 6), M.bananaStem, -.172, -.026, 0, 0, 0, .42);
  put(g, sph(.014, 6, 5), M.bananaTip, .172, -.022, 0);
  /* Scaled up from the real fruit: a 30 cm banana is a few pixels wide at throwing distance,
     and a prop the player cannot read is just noise. Same for the peel below. */
  g.scale.setScalar(1.6);
  return g;
}

/* Landed: four flaps splayed flat from a pale five-ridge core. The flaps are tapered sweeps
   (thick at the root, thin at the upturned tip) so they read as torn peel rather than tubes;
   the cream core is the same 5-ridge profile as the banana body — one continuous fruit story.
   Scaled up from the real fruit: at 0.3 m on bright snow or sand a literal banana peel is
   invisible from eye height, and a trap the player cannot see is just a cheap shot. */
const PEEL_CURVE = new THREE.CatmullRomCurve3([
  new THREE.Vector3(.02, .052, 0),
  new THREE.Vector3(.062, .028, 0),
  new THREE.Vector3(.112, .010, 0),
  new THREE.Vector3(.162, .006, 0),
  new THREE.Vector3(.205, .022, 0),
], false, 'centripetal');
const PEEL_TIP_A = new THREE.Color(0xf2d95a), PEEL_TIP_B = new THREE.Color(0xf4e6a0),
  PEEL_CAP = new THREE.Color(0xf7efc6);
function buildPeel() {
  const M = mats(), g = new THREE.Group();
  const flapFn = (t) => (.034 - .021 * t);                  // root thick → tip thin
  const flapColor = (t) => lerpC(_c2, PEEL_TIP_A, PEEL_TIP_B, t);
  for (let i = 0; i < 4; i++) {
    const A = i * Math.PI / 2 + Math.PI / 8;
    const flap = put(g, ribbedTube('peel|flap', PEEL_CURVE, 14, 8, flapFn, flapColor, null, PEEL_CAP), M.bananaSkin);
    flap.rotation.y = -A;
  }
  /* Cream fruit core poking out of the middle, five ridges like the body it came from. */
  put(g, cyl(.050, .058, .092, 5), M.bananaCream, 0, .042, 0);
  put(g, cyl(.044, .048, .012, 5), M.bananaCut, 0, .096, 0);   // pale cut face on top
  put(g, cyl(.012, .016, .06, 6), M.bananaTip, 0, .104, 0, .18); // bent stalk stub
  g.scale.setScalar(2.0);
  return g;
}

/* ============================================================================ MAGNET ==== */
/* The classic lacquered horseshoe: a half-torus bend with two straight legs and steel pole
   faces. arc=PI is exactly the horseshoe curve; rotation.z=PI flips the half-ring so its ends
   sit at x=±R, y=0. On top of the paint: two additive sparks breathing on the poles and a thin
   additive arc floating over the bend — at a glance it reads "charged", not "red metal". */
function buildMagnet() {
  const M = mats(), g = new THREE.Group();
  const R = .11, TB = .034, LIFT = .055;
  put(g, tor(R, TB, 10, 16, Math.PI), M.magnetRed, 0, LIFT, 0, 0, 0, Math.PI);
  for (const s of [-1, 1]) {
    put(g, cyl(TB, TB, .095, 10), M.magnetRed, s * R, LIFT + .10, 0);
    put(g, tor(TB, .006, 4, 12), M.magnetDark, s * R, LIFT + .128, 0, Math.PI / 2);
    put(g, cyl(TB * 1.06, TB * 1.06, .024, 10), M.magnetSteel, s * R, LIFT + .156, 0);
    /* Pole spark: the magnet is "on". */
    put(g, sph(.013, 6, 5), M.magnetSpark, s * R, LIFT + .176, 0).renderOrder = 3;
  }
  /* Charged field arc hovering over the bend (thrown look only). */
  put(g, tor(.135, .005, 4, 24, Math.PI * .75), M.magnetArc, 0, LIFT + .155, 0, 0, 0, Math.PI * .62).renderOrder = 3;
  /* Shift the whole group so its origin sits at the visual centre (props tumble about the origin). */
  g.position.y = 0;
  g.children.forEach(c => { c.position.y -= .10; });
  g.scale.setScalar(1.4);
  return g;
}

/* ============================================================================ SPRING ==== */
/* Thrown: a real helix (TubeGeometry along HelixCurve) between two bolted end plates. */
const SPR_R = .06, SPR_H = .13, SPR_TURNS = 3.25;
function buildSpring() {
  const M = mats(), g = new THREE.Group();
  put(g, tube(`helix|${SPR_R}|${SPR_H}|${SPR_TURNS}`, new HelixCurve(SPR_R, SPR_H, SPR_TURNS), 42, .014, 5),
    M.springSteel, 0, 0, 0);
  for (const s of [-1, 1]) {
    const y = s * (SPR_H / 2 + .008);
    put(g, cyl(.078, .084, .014, 12), M.springBlue, 0, y, 0);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      put(g, cyl(.008, .008, .02, 6), M.springBolt, Math.cos(a) * .062, y + s * .012, Math.sin(a) * .062);
    }
  }
  /* Slightly larger than life: a 15 cm spring is a few pixels wide at throwing distance. */
  g.scale.setScalar(1.3);
  return g;
}

/* Landed: the spring compressed into a launch pad. A hexagonal industrial base (unmistakably a
   machine part, not a disc), twin-wire coils, a glowing charge core and a double glow ring —
   the "you can step on this" cue stays wide and additive so it reads on every map. */
function buildSpringPad() {
  const M = mats(), g = new THREE.Group();
  put(g, cyl(.38, .42, .06, 6), M.springBlue, 0, .03, 0);
  put(g, cyl(.27, .27, .008, 6), M.springBolt, 0, .063, 0);          // dark hex hatch on top
  for (let i = 0; i < 4; i++) {                                       // base bolts
    const a = i * Math.PI / 2 + Math.PI / 6;
    put(g, cyl(.014, .014, .018, 6), M.springBolt, Math.cos(a) * .31, .066, Math.sin(a) * .31);
  }
  /* Twin-wire coil: two paired rings per level read as a compressed double spring. */
  for (const [r, y] of [[.20, .078], [.19, .086], [.13, .096], [.12, .104]])
    put(g, tor(r, .009, 4, 18), M.springSteel, 0, y, 0, Math.PI / 2);
  put(g, cyl(.085, .10, .022, 6), M.springBlue, 0, .118, 0);          // coil retainer
  /* Charge core + its additive halo. */
  put(g, sph(.05, 10, 8), M.springCore, 0, .128, 0);
  put(g, sph(.075, 8, 6), M.springGlow, 0, .128, 0).renderOrder = 3;
  /* Double glow ring: bright inner + faint outer. */
  const glow = put(g, ring(.29, .35, 24), M.springGlow, 0, .066, 0, -Math.PI / 2);
  glow.renderOrder = 3;
  const glow2 = put(g, ring(.37, .41, 24), M.springGlow, 0, .064, 0, -Math.PI / 2);
  glow2.material = M.waterFoam;                                       // fainter sibling, shared mat
  glow2.renderOrder = 3;
  return g;
}

/* ========================================================================= WATER BOMB ==== */
/* Thrown: a rubber water balloon on a lathe profile — neck, full belly, slightly sagging base —
   instead of a stretched sphere. The core being a separate opaque sphere is what sells "full of
   water"; two fixed glints guarantee a sphere read under flat lighting. */
const BALLOON_PROFILE = [
  [.001, -.105], [.052, -.098], [.088, -.062], [.104, -.008], [.106, .040],
  [.088, .086], [.055, .116], [.028, .132], [.020, .150],
];
function buildWaterBomb() {
  const M = mats(), g = new THREE.Group();
  const lathe = geo('balloon', () => new THREE.LatheGeometry(
    BALLOON_PROFILE.map(([x, y]) => new THREE.Vector2(x, y)), 14));
  put(g, lathe, M.waterSkin, 0, 0, 0);
  const core = put(g, sph(.078, 10, 8), M.waterCore, 0, -.004, 0);
  core.scale.y = 1.06;
  put(g, tor(.024, .007, 4, 10), M.magnetDark, 0, .148, 0, Math.PI / 2); // tied neck
  put(g, sph(.015, 6, 4), M.waterGlint, -.045, .050, .068);
  put(g, sph(.009, 6, 4), M.waterGlint, .050, -.030, -.068);
  g.scale.setScalar(1.45);
  return g;
}

/* Landed: a puddle sized to the real gameplay radius, layered by height + depthWrite:false +
   renderOrder instead of polygon offset. depthTest stays ON — a puddle must not show through
   walls. Around the water: a darker soaked patch, splash droplets and two bubble rings. */
function buildPuddle(radius) {
  const M = mats(), g = new THREE.Group();
  const R = radius;
  const wet = put(g, circle(R * 1.12, 28, .5), M.waterWet, 0, .008, 0, -Math.PI / 2);
  wet.renderOrder = 1;
  const base = put(g, circle(R, 28, 1), M.waterSkin, 0, .012, 0, -Math.PI / 2);
  base.renderOrder = 2;
  const deep = put(g, circle(R * .60, 20), M.waterDeep, 0, .016, 0, -Math.PI / 2);
  deep.renderOrder = 3;
  const foam = put(g, ring(R * .92, R * .985, 28), M.waterFoam, 0, .019, 0, -Math.PI / 2);
  foam.renderOrder = 4;
  /* Three ripples, rising slightly so they never z-fight the base disc. */
  [[.15, .18], [.46, .50], [.72, .75]].forEach(([a, b], i) => {
    const rp = put(g, ring(R * a, R * b, 22), M.waterFoam, 0, .022 + i * .003, 0, -Math.PI / 2);
    rp.renderOrder = 5;
  });
  /* Splash droplets thrown outward on impact — fixed deterministic angles, not noise. */
  const dropGeo = circle(1, 8);      // unit disc, scaled per droplet
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + .26, d = R * (1.02 + (i % 3) * .05);
    const dr = put(g, dropGeo, M.waterFoam, Math.cos(a) * d, .010, Math.sin(a) * d, -Math.PI / 2);
    dr.scale.setScalar(R * (.05 + (i % 2) * .03));
    dr.renderOrder = 2;
  }
  /* Two bubble rings drifting inside the puddle. */
  for (const [k, r] of [[.34, .10], [.62, .07]]) {
    const b = put(g, ring(r * .8, r, 14), M.waterGlint, R * k * .5, .024, -R * k * .4, -Math.PI / 2);
    b.material = M.waterFoam;
    b.renderOrder = 5;
  }
  return g;
}

/* ============================================================================ API ==== */
let PUDDLE_R = 2.2;
/* The puddle is drawn at the same radius the slowdown check uses, so "looks wet" and "is wet"
   can never disagree. funItems.js sets this once from FUN_DEFS.water.radius. */
export function setPropPuddleRadius(r) { if (r > 0) PUDDLE_R = r; }

/* The magnet's one-shot field ring (funItems._magnetPulse). Built once and shared for the whole
   session — it used to be rebuilt per burst (80 tris + 4 buffer uploads on every magnet hit);
   only the material is per-pulse, because the fade animates a private opacity. */
let MAGNET_PULSE_GEO = null;
export function ensureMagnetPulseGeo() {
  if (!MAGNET_PULSE_GEO) {
    MAGNET_PULSE_GEO = new THREE.RingGeometry(.9, 1, 40);
    MAGNET_PULSE_GEO.rotateX(-Math.PI / 2);
  }
  return MAGNET_PULSE_GEO;
}

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
  if (MAGNET_PULSE_GEO) { MAGNET_PULSE_GEO.dispose(); MAGNET_PULSE_GEO = null; }
  if (MATS) {
    for (const k in MATS) MATS[k].dispose && MATS[k].dispose();
    MATS = null;
  }
}

/* Prewarm: draw every prop variant once so the first in-match throw is free. The slow part is
   NOT our CPU code — it is the driver compiling the shaders for each material variant (and the
   standard materials' blending states) on the first actual draw call, which is invisible to JS
   and measured at 70-380 ms per first throw on D3D11. Rendering all eight variants (4 types ×
   fly/rest) plus the magnet's pulse ring once during the loading screen moves that whole cost
   to boot. Returns a cleanup that removes the temporary meshes. */
export function prewarmPropModels(scene) {
  const far = new THREE.Vector3(0, -80, 0);
  const list = [];
  const add = (m) => {
    m.position.copy(far);
    m.traverse(o => { o.frustumCulled = false; });
    scene.add(m);
    list.push(m);
  };
  for (const type of ['banana', 'magnet', 'spring', 'water']) {
    add(makeProp(type, 'fly'));
    add(makeProp(type, 'rest'));
  }
  ensureMagnetPulseGeo();
  /* The magnet's one-shot pulse ring has its own additive material (funItems._magnetPulse);
     the geometry is the shared singleton, so only the throwaway material is disposed after. */
  const mat = new THREE.MeshBasicMaterial({ color: 0xff7a5c, transparent: true, opacity: .7,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  add(new THREE.Mesh(ensureMagnetPulseGeo(), mat));
  return () => {
    for (const m of list) scene.remove(m);
    mat.dispose();
  };
}
