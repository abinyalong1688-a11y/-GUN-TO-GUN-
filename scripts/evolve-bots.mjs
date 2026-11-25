#!/usr/bin/env node
// evolve-bots.mjs — offline genetic tuning for the deathmatch bot doctrine.
//
//   npm run evolve            (writes src/botTuning.js)
//   node scripts/evolve-bots.mjs --dry
//
// Each candidate doctrine is evaluated against the baseline normal doctrine in
// simulateDuel() with three deterministic seeds, so the run is reproducible and a lucky
// single duel cannot dominate the fitness. The winning genome is merged into the runtime
// hard preset by src/botConfig.js (clamped by PARAM_RANGES).
import {writeFileSync} from 'fs';
import {BotEvolution, TACTICAL_RANGES, BASELINE_DOCTRINE, simulateDuel} from '../src/botEvolution.js';

const args = new Set(process.argv.slice(2));
const seed = 20261125;
const populationSize = 32;
const generationCount = 40;

const PARAM_KEYS = Object.keys(TACTICAL_RANGES);
const genomeHash = genome => {
  let h = 7;
  for (const key of PARAM_KEYS) h = (Math.imul(h, 31) + Math.round(genome[key] * 1000)) | 0;
  return Math.abs(h) || 1;
};

/* Three deterministic evaluation seeds per genome: stable across runs, varied enough that a
   single lucky trade cannot define a doctrine's fitness. */
function simulator(ind) {
  const h = genomeHash(ind);
  const totals = {wins: 0, losses: 0, rounds: 0, hits: 0, damageDealt: 0, survivalTime: 0, winRate: 0};
  const seeds = [h % 100000 + 11, h % 100000 + 29, h % 100000 + 47];
  for (const s of seeds) {
    const m = simulateDuel(ind, BASELINE_DOCTRINE, {seed: s, rounds: 6, maxTime: 40});
    totals.wins += m.wins; totals.losses += m.losses; totals.rounds += m.rounds;
    totals.hits += m.hits; totals.damageDealt += m.damageDealt;
    totals.survivalTime += m.survivalTime * m.rounds;
  }
  totals.winRate = totals.wins / totals.rounds;
  totals.survivalTime /= totals.rounds;
  return totals;
}

const evo = new BotEvolution({
  populationSize, generationCount, mutationRate: .25, eliteCount: 4, seed,
  seedDoctrine: BASELINE_DOCTRINE, // warm start: refine the working doctrine, don't rediscover it
});
const t0 = Date.now();
const result = evo.runEvolution(simulator, row => {
  if (row.generation === 1 || row.generation % 3 === 0 || row.generation === generationCount) {
    console.log(`gen ${String(row.generation).padStart(2)}  best ${row.best.toFixed(2)}  mean ${row.mean.toFixed(2)}  ${JSON.stringify(row.genome)}`);
  }
});

const pct = (result.improvement * 100).toFixed(1);
console.log(`\ninitial best ${result.initialBest.toFixed(2)} → final best ${result.finalBest.toFixed(2)}  (+${pct}%)  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('winning genome:', result.genome);
console.log('baseline     :', BASELINE_DOCTRINE);

// Acceptance: every evolved value inside its declared range, and the run must actually improve.
for (const [key, value] of Object.entries(result.genome)) {
  const [min, max] = TACTICAL_RANGES[key];
  if (!(value >= min && value <= max)) throw new Error(`${key}=${value} outside [${min}, ${max}]`);
}
if (!(result.finalBest > result.initialBest)) throw new Error('evolution did not improve the best fitness');

if (!args.has('--dry')) {
  const lines = Object.entries(result.genome).map(([k, v]) => `  ${k}: ${v},`).join('\n');
  const out = `// botTuning.js — tactical weights produced by the offline evolution run.
//
// Regenerate with:  npm run evolve
// The genetic algorithm (src/botEvolution.js) evaluates candidate tactical doctrines against
// the baseline normal doctrine in a headless duel model and writes the best genome back here.
// Only the keys in TACTICAL_KEYS survive into the runtime hard preset; every value is clamped
// by PARAM_RANGES in botConfig.js, so a hand-edited file can never produce an extreme bot.
//
// Committed output: seed ${seed}, ${populationSize} individuals × ${generationCount} generations,
// initial best ${result.initialBest.toFixed(2)} → final best ${result.finalBest.toFixed(2)} (+${pct}%).
// Fitness: winRate×60 + kills×2 + survivalTime×.5 + damageDealt×.01 − deaths×3.

export const BOT_TUNED = {
${lines}
};
`;
  writeFileSync('src/botTuning.js', out);
  console.log('wrote src/botTuning.js');
}
