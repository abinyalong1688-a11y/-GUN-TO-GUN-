// bot-evolution.test.mjs — genetic tuning: bounds, determinism, elitism and the acceptance gain
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  BotEvolution, TACTICAL_RANGES, BASELINE_DOCTRINE,
  simulateDuel, fitnessFromStats, makeRng,
} from '../src/botEvolution.js';
import {PARAM_RANGES, TACTICAL_KEYS} from '../src/botConfig.js';
import {BOT_TUNED} from '../src/botTuning.js';

const inRange = (key, value) => {
  const [min, max] = PARAM_RANGES[key];
  return value >= min && value <= max;
};

test('committed botTuning genome is inside PARAM_RANGES and covers the tactical keys', () => {
  for (const key of TACTICAL_KEYS) {
    assert.ok(Number.isFinite(BOT_TUNED[key]), `${key} should be a finite number`);
    assert.ok(inRange(key, BOT_TUNED[key]), `${key}=${BOT_TUNED[key]} outside its range`);
  }
});

test('rng is deterministic for a seed and diverges across seeds', () => {
  const a = makeRng(7), b = makeRng(7), c = makeRng(8);
  const seqA = [a(), a(), a()];
  assert.deepEqual(seqA, [b(), b(), b()]);
  assert.notDeepEqual(seqA, [c(), c(), c()]);
});

test('createIndividual / crossover / mutate never leave the declared bounds', () => {
  const evo = new BotEvolution({populationSize: 20, seed: 3});
  evo.initPopulation();
  for (const ind of evo.population) {
    for (const key of Object.keys(TACTICAL_RANGES)) assert.ok(inRange(key, ind[key]), key + ' out of range after init');
  }
  for (let i = 0; i < 50; i++) {
    const child = evo.mutate(evo.crossover(evo.population[0], evo.population[1]));
    for (const key of Object.keys(TACTICAL_RANGES)) assert.ok(inRange(key, child[key]), key + ' out of range after mutation');
  }
});

test('simulateDuel is deterministic for a seed and returns sane metrics', () => {
  const a = simulateDuel(BOT_TUNED, BASELINE_DOCTRINE, {seed: 11, rounds: 4});
  const b = simulateDuel(BOT_TUNED, BASELINE_DOCTRINE, {seed: 11, rounds: 4});
  assert.deepEqual(a, b);
  assert.equal(a.rounds, 4);
  assert.ok(a.wins + a.losses <= 4);
  assert.ok(a.winRate >= 0 && a.winRate <= 1);
  assert.ok(a.damageDealt >= 0);
  assert.ok(fitnessFromStats(a) >= 0);
});

test('elitism: the best fitness never drops between generations', () => {
  const evo = new BotEvolution({populationSize: 12, generationCount: 10, seed: 5});
  const result = evo.runEvolution(ind => simulateDuel(ind, BASELINE_DOCTRINE, {seed: 21, rounds: 4}));
  for (let i = 1; i < result.history.length; i++) {
    assert.ok(result.history[i].best >= result.history[i - 1].best - 1e-9,
      `generation ${i + 1} best ${result.history[i].best} dropped below ${result.history[i - 1].best}`);
  }
});

test('the committed evolution run improves the first-generation best by at least 20 %', () => {
  const seed = 20261125;
  const evolution = new BotEvolution({
    populationSize: 32, generationCount: 40, mutationRate: .25, eliteCount: 4, seed,
    seedDoctrine: BASELINE_DOCTRINE,
  });
  const keys = Object.keys(TACTICAL_RANGES);
  const hash = genome => {
    let h = 7;
    for (const key of keys) h = (Math.imul(h, 31) + Math.round(genome[key] * 1000)) | 0;
    return Math.abs(h) || 1;
  };
  const simulator = ind => {
    const h = hash(ind);
    const seeds = [h % 100000 + 11, h % 100000 + 29, h % 100000 + 47];
    const total = {wins: 0, losses: 0, rounds: 0, damageDealt: 0, survivalTime: 0};
    for (const s of seeds) {
      const m = simulateDuel(ind, BASELINE_DOCTRINE, {seed: s, rounds: 6, maxTime: 40});
      total.wins += m.wins; total.losses += m.losses; total.rounds += m.rounds;
      total.damageDealt += m.damageDealt; total.survivalTime += m.survivalTime * m.rounds;
    }
    total.winRate = total.wins / total.rounds;
    total.survivalTime /= total.rounds;
    return total;
  };
  const result = evolution.runEvolution(simulator);
  assert.ok(result.finalBest >= result.initialBest, 'final best should not be below the first generation');
  assert.ok(result.improvement >= .2, `expected ≥20 % fitness gain, got ${(result.improvement * 100).toFixed(1)} %`);
  for (const key of TACTICAL_KEYS) {
    assert.ok(inRange(key, result.genome[key]), `evolved ${key} escaped its bounds`);
  }
});
