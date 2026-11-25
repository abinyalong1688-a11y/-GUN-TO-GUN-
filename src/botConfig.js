// botConfig.js — every bot strength knob in one place.
//
// The values mirror the design brief's DEFAULT_DIFFICULTY table, split into three layers:
//   · senses  — how the bot perceives (view cone / range / memory / hearing)
//   · combat  — how it fights (accuracy, reaction, burst discipline, lead, strafe)
//   · tactics — where it goes (aggression, cover bias, flank bias, engagement band)
// `getBotParams(difficulty, faction)` merges a difficulty preset with the faction's weapon
// style and the offline-tuned tactical weights, and caches the result: a settings change or
// a respawn must not allocate a fresh parameter object every frame.

import {BOT_TUNED} from './botTuning.js';

const DIFFICULTY = {
  easy: {
    // senses
    fov: 1.70, viewRange: 30, memoryTime: 2.5, hearing: 14, proximity: 3.8, senseInterval: .14,
    // combat
    reaction: .55, aimTime: 1.15, accuracy: .62, lead: 0, aimJitter: .05, settleError: .55,
    burstScale: .85, pauseScale: 1.20, damageScale: .85, turnRate: 4.0,
    // tactics
    aggression: .40, coverBias: .90, flankBias: .12, strafe: .30,
    preferCoverDist: 15, lowHealthThresh: .32, retreatHold: 3.0, reactionSpread: 1.35,
  },
  normal: {
    fov: 2.30, viewRange: 46, memoryTime: 4.0, hearing: 24, proximity: 5.2, senseInterval: .10,
    reaction: .28, aimTime: .62, accuracy: .83, lead: .65, aimJitter: .028, settleError: .42,
    burstScale: 1, pauseScale: 1, damageScale: 1, turnRate: 6.0,
    aggression: .62, coverBias: .70, flankBias: .35, strafe: .48,
    preferCoverDist: 13, lowHealthThresh: .35, retreatHold: 2.6, reactionSpread: 1,
  },
  hard: {
    fov: 2.90, viewRange: 62, memoryTime: 6.0, hearing: 34, proximity: 6.8, senseInterval: .075,
    reaction: .13, aimTime: .30, accuracy: .90, lead: 1, aimJitter: .012, settleError: .30,
    burstScale: 1.12, pauseScale: .85, damageScale: 1.1, turnRate: 8.0,
    aggression: .85, coverBias: .55, flankBias: .62, strafe: .62,
    preferCoverDist: 11, lowHealthThresh: .40, retreatHold: 2.0, reactionSpread: .7,
  },
};

/* Faction weapon identity: Nova holds steady 3-round bursts, Rogue sprays long and hard.
   Normal keeps the historical damage numbers (Rogue dmgP 9 is asserted by the e2e suite). */
const FACTION = {
  ct: {burst: 3, burstT: .13, pause: 1.20, range: [7, 16], dmgP: 6, dmgH: 12, missK: 1.00, style: 'burst'},
  t:  {burst: 5, burstT: .11, pause: 1.50, range: [6, 13], dmgP: 9, dmgH: 15, missK: 1.35, style: 'spray'},
};

/* Parameter space used by the genetic algorithm (botEvolution.js). All values are clamped
   into these bounds after crossover/mutation, so evolution can never produce an extreme bot. */
export const PARAM_RANGES = {
  fov: [1.5, 3.0],
  viewRange: [26, 65],
  memoryTime: [2, 8],
  hearing: [10, 40],
  proximity: [3, 8],
  reaction: [.08, .55],
  aimTime: [.2, 1.3],
  accuracy: [.45, .9],
  lead: [0, 1],
  burstScale: [.7, 1.3],
  pauseScale: [.7, 1.35],
  damageScale: [.7, 1.25],
  aggression: [.15, .95],
  coverBias: [.25, 1.1],
  flankBias: [.05, .9],
  strafe: [.15, .8],
  preferCoverDist: [7, 18],
  lowHealthThresh: [.15, .5],
  retreatHold: [1.5, 3.5],
  reactionSpread: [.6, 1.5],
};

/* Tactical subset the offline GA actually optimises: how a bot moves and uses cover.
   Perception/accuracy stay under explicit difficulty control (evolving them is just
   "make the bot cheat harder", not a better combat doctrine). */
export const TACTICAL_KEYS = ['aggression', 'coverBias', 'flankBias', 'strafe', 'preferCoverDist', 'retreatHold'];

const PARAM_KEYS = Object.keys(PARAM_RANGES);
const CACHE = new Map();

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* Clamp an arbitrary parameter bag into PARAM_RANGES (GA output, debug overrides, ...). */
export function clampParams(obj) {
  const out = {};
  for (const key of PARAM_KEYS) {
    const lim = PARAM_RANGES[key];
    const n = Number(obj && obj[key]);
    out[key] = Number.isFinite(n) ? clamp(n, lim[0], lim[1]) : undefined;
  }
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

/* GA-tuned tactical weights are merged on top of the chosen difficulty preset. They are
   clamped by PARAM_RANGES, so a stale or corrupted tuning file can only nudge, never break. */
function tunedFor(difficulty) {
  return difficulty === 'hard' ? clampParams(BOT_TUNED || {}) : null;
}

/* Human-readable preset for the menu / docs / tests. */
export function listDifficulties() {
  return Object.keys(DIFFICULTY);
}

/* Merge: difficulty + faction style + (hard only) evolved tactics. Cached per pair. */
export function getBotParams(difficulty, faction) {
  const diff = DIFFICULTY[difficulty] ? difficulty : 'normal';
  const fac = FACTION[faction] ? faction : 'ct';
  const key = diff + '|' + fac;
  let p = CACHE.get(key);
  if (p) return p;
  const base = DIFFICULTY[diff];
  const style = FACTION[fac];
  p = {
    ...base,
    ...style,
    range: [style.range[0], style.range[1]],
    burst: Math.max(1, Math.round(style.burst * base.burstScale)),
    pause: style.pause * base.pauseScale,
    dmgP: Math.max(1, Math.round(style.dmgP * base.damageScale)),
    dmgH: Math.max(1, Math.round(style.dmgH * base.damageScale)),
    difficulty: diff,
    faction: fac,
    viewFOV: base.fov, // legacy naming used by the design brief / perception docs
  };
  const tuned = tunedFor(diff);
  if (tuned) {
    for (const k of TACTICAL_KEYS) {
      if (Number.isFinite(tuned[k])) p[k] = tuned[k];
    }
  }
  CACHE.set(key, p);
  return p;
}

/* Test / tooling hook: forget cached merges after a tuning file change. */
export function clearBotParamsCache() {
  CACHE.clear();
}
