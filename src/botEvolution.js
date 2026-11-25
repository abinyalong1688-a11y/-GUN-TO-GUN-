// botEvolution.js — offline genetic tuning of the bots' tactical doctrine.
//
// The runtime never runs evolution: it imports the winning genome from botTuning.js.
// This module is the generator/proof, kept pure so it can run in Node and be unit-tested:
//   · individuals are bags of tactical parameters (aggression / cover / flank / strafe / ...)
//   · fitness comes from a coarse deterministic duel model (simulateDuel)
//   · selection is roulette with elitism, crossover is single-point, mutation is bounded
//
// The duel model intentionally ignores rendering and navigation: it isolates "does this
// doctrine win fights?" so the GA optimises combat decisions, not map luck. Accuracy and
// reaction stay fixed on both sides — evolving those would just make the bot cheat harder.

import {PARAM_RANGES, TACTICAL_KEYS} from './botConfig.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* Deterministic RNG (mulberry32) — the same seed reproduces the same genome, so the
   committed botTuning.js is reproducible and the tests are stable. */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TACTICAL_RANGES = Object.fromEntries(TACTICAL_KEYS.map(k => [k, PARAM_RANGES[k]]));

/* The doctrine every evolved candidate is measured against: the hand-tuned normal preset. */
export const BASELINE_DOCTRINE = Object.freeze({
  aggression: .62,
  coverBias: .70,
  flankBias: .35,
  strafe: .48,
  preferCoverDist: 13,
  retreatHold: 2.6,
});

/**
 * Coarse deterministic duel: two fighters close to their preferred range, strafe, take
 * cover when hurt, and trade hits. Tactics change both hit chance and incoming damage.
 * Returns aggregate metrics used by the fitness formula in the design brief.
 */
export function simulateDuel(candidate, opponent = BASELINE_DOCTRINE, {seed = 1, rounds = 6, maxTime = 40} = {}) {
  const rng = makeRng(seed);
  const a = {...BASELINE_DOCTRINE, ...candidate};
  const b = {...BASELINE_DOCTRINE, ...opponent};
  const FIRE_INTERVAL = .18;
  const DMG = 9;
  let wins = 0, losses = 0, damageDealt = 0, survivalTotal = 0, hits = 0;

  const shotChance = (self, foe, dist, foeCover, selfCover) => {
    let hit = .35 + .45 * Math.max(0, 1 - dist / 30);
    hit -= (self.strafe || 0) * .07;            // shooting while moving is harder
    hit -= (foe.strafe || 0) * .24;             // a strafing target is harder to hit
    if (foeCover) hit -= (foe.coverBias || 0) * .42; // cover denies the shot
    if (selfCover) hit -= (self.coverBias || 0) * .12; // …but hugging cover costs offence
    hit += (self.flankBias || 0) * .16;         // off-angle pressure beats cover
    return clamp(hit, .12, .92);
  };

  for (let round = 0; round < rounds; round++) {
    let hpA = 100, hpB = 100, dist = 18, t = 0;
    let fireA = .1, fireB = .1;
    let coverA = 0, coverB = 0, coverCdA = 0, coverCdB = 0;
    while (t < maxTime && hpA > 0 && hpB > 0) {
      const dt = .1;
      t += dt;
      // Range control in one dimension: A sits at 0 and B at `dist`. A closing moves +x,
      // B closing moves -x, so the relative distance changes by (moveB - moveA) × speed.
      const desiredA = (a.preferCoverDist || 13) * (1.3 - .6 * (a.aggression || .5));
      const desiredB = (b.preferCoverDist || 13) * (1.3 - .6 * (b.aggression || .5));
      const moveA = dist > desiredA ? 1 : -1;
      const moveB = dist > desiredB ? -1 : 1;
      dist = clamp(dist + (moveB - moveA) * 4 * dt, 2, 30);
      // Break contact when hurt; cover only protects while the timer runs.
      coverCdA -= dt; coverCdB -= dt; coverA = Math.max(0, coverA - dt); coverB = Math.max(0, coverB - dt);
      if (hpA < 35 && coverA <= 0 && coverCdA <= 0) { coverA = a.retreatHold || 2.5; coverCdA = coverA * 2; }
      if (hpB < 35 && coverB <= 0 && coverCdB <= 0) { coverB = b.retreatHold || 2.5; coverCdB = coverB * 2; }
      // Trades.
      fireA -= dt; fireB -= dt;
      if (fireA <= 0) {
        fireA = FIRE_INTERVAL;
        if (rng() < shotChance(a, b, dist, coverB > 0, coverA > 0)) { hpB -= DMG; damageDealt += DMG; hits++; }
      }
      if (fireB <= 0) {
        fireB = FIRE_INTERVAL;
        if (rng() < shotChance(b, a, dist, coverA > 0, coverB > 0)) hpA -= DMG;
      }
    }
    if (hpB <= 0 && hpA > 0) { wins++; survivalTotal += t; }
    else if (hpA <= 0 && hpB > 0) { losses++; survivalTotal += t * .5; }
    else {
      survivalTotal += t;
      if (hpB < hpA) wins++; else if (hpA < hpB) losses++;
    }
  }
  return {
    wins, losses, rounds, hits, damageDealt, survivalTime: survivalTotal / rounds,
    winRate: wins / rounds, killRate: hits / Math.max(1, rounds),
  };
}

/* Design-brief fitness: kills×2 + survival×.5 + damage×.01 − deaths×3, plus a win-rate term
   so a doctrine that wins rounds (not just farms damage) ranks higher. */
export function fitnessFromStats(m) {
  const kills = m.wins || 0;
  const deaths = m.losses || 0;
  const fitness = (m.winRate || 0) * 60 + kills * 2 + (m.survivalTime || 0) * .5
    + (m.damageDealt || 0) * .01 - deaths * 3;
  return Math.max(0, fitness);
}

export class BotEvolution {
  constructor(options = {}) {
    this.populationSize = options.populationSize || 24;
    this.generationCount = options.generationCount || 18;
    this.mutationRate = options.mutationRate == null ? .18 : options.mutationRate;
    this.eliteCount = options.eliteCount || 3;
    this.seed = options.seed || 1;
    this.rng = makeRng(this.seed);
    this.ranges = options.ranges || TACTICAL_RANGES;
    this.keys = Object.keys(this.ranges);
    this.population = [];
    this.history = [];
    /* Optional warm start: seed every genome around a known-good doctrine instead of the
       whole parameter space. Production runs start from the hand-tuned normal doctrine, so
       evolution refines a working tactic rather than rediscovering "don't stand still". */
    this.seedDoctrine = options.seedDoctrine || null;
  }

  createIndividual() {
    const ind = {};
    const base = this.seedDoctrine;
    for (const [key, [min, max]] of Object.entries(this.ranges)) {
      if (base && Number.isFinite(base[key])) {
        const span = max - min;
        ind[key] = clamp(base[key] + (this.rng() - .5) * span * .18, min, max);
      } else {
        ind[key] = min + this.rng() * (max - min);
      }
    }
    ind.fitness = 0;
    return ind;
  }

  initPopulation() {
    this.population = [];
    for (let i = 0; i < this.populationSize; i++) this.population.push(this.createIndividual());
  }

  /* Evaluate against the baseline doctrine with deterministic seeds per individual. */
  evaluateFitness(individual, simulator) {
    const metrics = simulator(individual);
    individual.fitness = fitnessFromStats(metrics);
    individual.stats = metrics;
    return individual.fitness;
  }

  /* Roulette-wheel selection (zero-fitness populations fall back to uniform). */
  select() {
    const total = this.population.reduce((s, ind) => s + Math.max(0, ind.fitness), 0);
    if (total <= 0) return this.population[Math.floor(this.rng() * this.population.length)];
    let r = this.rng() * total;
    for (const ind of this.population) {
      r -= Math.max(0, ind.fitness);
      if (r <= 0) return ind;
    }
    return this.population[this.population.length - 1];
  }

  /* Single-point crossover over the parameter key list. */
  crossover(parentA, parentB) {
    const child = {};
    const point = Math.floor(this.rng() * this.keys.length);
    this.keys.forEach((key, i) => {
      child[key] = i < point ? parentA[key] : parentB[key];
    });
    child.fitness = 0;
    return child;
  }

  mutate(individual) {
    for (const [key, [min, max]] of Object.entries(this.ranges)) {
      if (this.rng() < this.mutationRate) {
        const span = max - min;
        individual[key] = clamp(individual[key] + (this.rng() - .5) * span * .4, min, max);
      }
    }
    return individual;
  }

  /* Run the full loop. `simulator` receives an individual params bag and returns metrics. */
  runEvolution(simulator, onGeneration = null) {
    this.initPopulation();
    this.history = [];
    let bestEver = null;
    for (let gen = 0; gen < this.generationCount; gen++) {
      for (const ind of this.population) this.evaluateFitness(ind, simulator);
      this.population.sort((x, y) => y.fitness - x.fitness);
      const genBest = this.population[0];
      if (!bestEver || genBest.fitness > bestEver.fitness) bestEver = {...genBest};
      const mean = this.population.reduce((s, ind) => s + ind.fitness, 0) / this.population.length;
      const row = {generation: gen + 1, best: genBest.fitness, mean, genome: this.genomeOf(genBest)};
      this.history.push(row);
      if (onGeneration) onGeneration(row);
      if (gen === this.generationCount - 1) break;
      const next = [];
      for (let i = 0; i < this.eliteCount && i < this.population.length; i++) {
        next.push({...this.population[i]});
      }
      while (next.length < this.populationSize) {
        const child = this.mutate(this.crossover(this.select(), this.select()));
        next.push(child);
      }
      this.population = next;
    }
    const initialBest = this.history.length ? this.history[0].best : 0;
    const finalBest = this.history.length ? this.history[this.history.length - 1].best : 0;
    return {
      best: bestEver,
      genome: this.genomeOf(bestEver),
      initialBest,
      finalBest,
      improvement: initialBest > 0 ? (finalBest - initialBest) / initialBest : 0,
      history: this.history,
    };
  }

  /* Strip fitness/stats so only evolved parameters are written to botTuning.js. */
  genomeOf(individual) {
    const out = {};
    for (const key of this.keys) out[key] = Math.round(individual[key] * 1000) / 1000;
    return out;
  }
}
