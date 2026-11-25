// botTuning.js — tactical weights produced by the offline evolution run.
//
// Regenerate with:  npm run evolve
// The genetic algorithm (src/botEvolution.js) evaluates candidate tactical doctrines against
// the baseline normal doctrine in a headless duel model and writes the best genome back here.
// Only the keys in TACTICAL_KEYS survive into the runtime hard preset; every value is clamped
// by PARAM_RANGES in botConfig.js, so a hand-edited file can never produce an extreme bot.
//
// Committed output: seed 20261125, 32 individuals × 40 generations,
// initial best 87.16 → final best 118.37 (+35.8%).
// Fitness: winRate×60 + kills×2 + survivalTime×.5 + damageDealt×.01 − deaths×3.

export const BOT_TUNED = {
  aggression: 0.592,
  coverBias: 0.746,
  flankBias: 0.9,
  strafe: 0.711,
  preferCoverDist: 8.965,
  retreatHold: 3.312,
};
