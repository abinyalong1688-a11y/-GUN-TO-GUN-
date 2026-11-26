// 对外统一出口
import { NavGrid } from './NavGrid.js';
import { InfluenceMap } from './InfluenceMap.js';
import { TacticalMap } from './TacticalMap.js';
import { SquadDirector, ATTACK_ARMS, DEFENSE_ARMS } from './SquadDirector.js';
import { Learning, LearningStore, ThompsonBandit, OpponentRouteModel, CombatTuner, DifficultyController, CEM } from './Learning.js';

export { NavGrid, InfluenceMap, TacticalMap, SquadDirector, ATTACK_ARMS, DEFENSE_ARMS, Learning, LearningStore, ThompsonBandit, OpponentRouteModel, CombatTuner, DifficultyController, CEM };
export { mulberry32, gauss, clamp, dist, angNorm } from './util.js';

/**
 * 一键构建：给一张地图（AABB 列表）和若干配置，返回整套 AI 子系统
 * @example
 *   const ai = createBotAI({ colliders, size: 112, cell: 0.5, mapKey: 'desert', mode: 'koth', humanTeam: 'A' });
 *   // 每帧： ai.director.update(worldView, dt)
 */
export function createBotAI({ colliders, size = 112, cell = 0.5, radius = 0.45, mapKey = 'default', mode = 'dm', humanTeam = 'A', store = null, seed = 11, circleBound = 52 }) {
  const nav = new NavGrid(size, cell, radius, circleBound);
  nav.rasterize(colliders);
  const inf = new InfluenceMap(nav);
  const tac = new TacticalMap(nav, inf);
  tac.buildCovers();
  const learning = new Learning({ store, humanTeam, seed });
  learning.setContext(mapKey, mode);
  const director = new SquadDirector({ nav, tac, inf, learning });
  return { nav, inf, tac, learning, director };
}
