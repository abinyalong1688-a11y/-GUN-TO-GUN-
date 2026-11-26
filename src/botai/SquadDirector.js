// 小队指挥层（Squad Director）：路线规划 + 角色分工 + 节奏控制 + 轮转/反扑 + 局内自适应
// 它不直接操作角色，而是给每个 Bot 下发 order，由"执行层"（游戏原大脑 / 沙盘控制器）翻译成移动与瞄准
import { dist, clamp } from './util.js';

export const ATTACK_ARMS = ['rush', 'default', 'flank', 'split'];
export const DEFENSE_ARMS = ['tight', 'forward', 'mixed'];

export class SquadDirector {
  /**
   * @param {object} o {nav, tac, inf, learning, rng, adaptInterval}
   */
  constructor({ nav, tac, inf, learning, rng = Math.random, adaptInterval = 0.5 }) {
    this.nav = nav; this.tac = tac; this.inf = inf; this.learning = learning; this.rng = rng;
    this.adaptInterval = adaptInterval; this.reach = 1.3; this.time = 0;
    this.teams = { A: this._newTeam('A'), B: this._newTeam('B') };
    this.stats = { plans: 0, replans: 0, rotations: 0, retakes: 0, trades: 0 };
  }
  _newTeam(team) {
    return { team, plan: null, nextAdapt: 0, laneOf: {}, wpOf: {}, laneRef: {}, arrived: {}, laneDeaths: {}, laneDeathT: {}, lastReplan: -99, swaps: 0, heard: [], seen: [], retake: null, lastRotate: -99, lastOrder: {} };
  }

  // ================= 事件入口（执行层调用） =================
  report(type, e = {}) {
    const t = this.time;
    if (type === 'death') {
      const v = e.victim; if (!v) return;
      this.inf.addDeath(v.x, v.z, v.team, 1);
      const st = this.teams[v.team]; const lane = st.laneOf[v.id];
      if (lane) { st.laneDeaths[lane] = (st.laneDeaths[lane] || 0) + 1; st.laneDeathT[lane] = t; }
      if (e.killer && e.killer.team && e.killer.team !== v.team) this.learning.observeEnemy(e.killer.team, e.killer.id || 'k', e.killer.x, e.killer.z, t, 2);
      // 交换击杀（trade）：离死亡点最近的队友 3s 内压过去
      if (e.killer && e.killer.x != null) {
        // the victim's own unit is still flagged alive until the next sync — never order it to trade
      const mates = (this.worldRef?.teams?.[v.team]?.bots || []).filter((b) => b.alive && !b.human && b.id !== v.id);
        let best = null, bd = 10;
        for (const b of mates) { const d = dist(b.x, b.z, v.x, v.z); if (d < bd) { bd = d; best = b; } }
        if (best) { st.lastOrder[best.id] = { kind: 'trade', goal: [v.x, v.z], lookAt: [e.killer.x, e.killer.z], sprint: true, until: t + 3, label: 'TRADE' }; this.stats.trades++; }
      }
    } else if (type === 'shot') {
      // 枪声：敌方队伍的火力位置 → 影响推断 + 对手路线模型
      const enemyTeam = e.team === 'A' ? 'B' : 'A';
      const st = this.teams[enemyTeam];
      st.heard.push({ x: e.x, z: e.z, t, team: e.team }); if (st.heard.length > 24) st.heard.shift();
      this.learning.observeEnemy(e.team, e.id || 's', e.x, e.z, t, 0.25);
    } else if (type === 'seen') {
      const st = this.teams[e.team]; const en = e.enemy;
      st.seen.push({ x: en.x, z: en.z, t, team: en.team, id: en.id }); if (st.seen.length > 24) st.seen.shift();
      this.learning.observeEnemy(en.team, en.id || 'e', en.x, en.z, t, 1);
    } else if (type === 'roundEnd') {
      if (e.winner) this.learning.endRound(e.winner, e);
      for (const k of ['A', 'B']) { const s = this.teams[k]; s.plan = null; s.retake = null; s.heard.length = 0; s.seen.length = 0; s.laneDeaths = {}; s.swaps = 0; s.lastOrder = {}; s.nextAdapt = 0; }
    }
  }

  // ================= 每帧更新 =================
  update(world, dt) {
    this.time = world.time; this.worldRef = world;
    this.inf.update(dt);
    for (const team of ['A', 'B']) {
      const tv = world.teams[team]; if (!tv || !tv.bots.length) continue;
      const st = this.teams[team];
      // 攻防阶段变化（据点易手）→ 重新规划（3s 内不抖动）
      if (st.plan && this.time - st.plan.time > 3 && st.plan.phase !== this._phase(world, team)) st.plan = null;
      if (!st.plan) this._plan(world, team, st);
      if (this.time >= st.nextAdapt) {
        st.nextAdapt = this.time + this.adaptInterval;
        const units = []; for (const k of ['A', 'B']) for (const b of world.teams[k].bots) if (b.alive) units.push({ team: k, x: b.x, z: b.z });
        this.inf.rebuild(units);
        this._adapt(world, team, st);
      }
      this._issue(world, team, st);
    }
  }

  _phase(world, team) {
    const tv = world.teams[team]; const obj = world.objective;
    if (world.mode === 'koth' && obj) return obj.owner === team ? 'defense' : 'attack';
    if (world.mode === 'waves') return tv.isAttacker ? 'attack' : 'escort';
    return tv.isAttacker === false ? 'defense' : 'attack'; // dm：默认双方都走"推进+狩猎"
  }

  _plan(world, team, st) {
    const phase = this._phase(world, team);
    st.plan = phase === 'defense' ? this._planDefense(world, team, st) : phase === 'escort' ? this._planEscort(world, team) : this._planAttack(world, team, st);
    st.plan.phase = phase; st.plan.time = this.time; st.plan.strategy = st.strategy || 'default';
    st.wpOf = {}; st.laneRef = {}; st.arrived = {}; this.stats.plans++;
    for (const a of st.plan.assignments) st.laneOf[a.botId] = a.lane || null;
  }

  // ---------------- 进攻路线规划 ----------------
  _planAttack(world, team, st) {
    const tv = world.teams[team]; const obj = world.objective;
    const enemyTeam = team === 'A' ? 'B' : 'A';
    const target = obj ? obj.pos : (world.teams[enemyTeam].spawn || [0, 0]);
    const spawn = tv.spawn || target;
    const alive = tv.bots.filter((b) => b.alive && !b.human); const n = alive.length; if (!n) return { assignments: [], lanes: {} };

    const strategy = this.learning.chooseStrategy(team, 'atk', ATTACK_ARMS, 0.1); st.strategy = strategy;
    const lanes = this.tac.findLanes(spawn, target, 4, team, { radius: obj?.radius || 8 });
    if (!lanes.length) return { assignments: [], lanes: {}, target, kind: 'attack', strategy };
    const entr = obj ? this.tac.entrances(target[0], target[1], (obj.radius || 8) + 4, 5) : [];
    const defPos = this.tac.defensePositions(target[0], target[1], obj?.radius || 8, entr, 8, enemyTeam);
    const scored = lanes.map((pts, i) => { const s = this.tac.scoreLane(pts, team, defPos); s.i = i; return s; });
    const maxLen = Math.max(...scored.map((s) => s.len), 1);
    for (const s of scored) {
      const mid = s.i ? lanes[s.i][Math.floor(lanes[s.i].length / 2)] : target;
      const heat = this.learning.enemyProbNear(enemyTeam, mid[0], mid[1], 14);
      s.score = 1 / (1 + s.danger * 1.6) + (1 - s.len / maxLen) * 0.5 + (1 - s.coverage) * 0.8 + (1 - heat) * 0.4;
    }
    scored.sort((a, b) => b.score - a.score);
    const main = scored[0].i;
    let flank = scored.find((s) => s.i !== main && this.tac.laneOverlap(lanes[main], lanes[s.i]) < 0.45)?.i; if (flank == null) flank = scored[Math.min(1, scored.length - 1)].i;
    let lurk = scored.find((s) => s.i !== main && s.i !== flank && this.tac.laneOverlap(lanes[main], lanes[s.i]) < 0.45 && this.tac.laneOverlap(lanes[flank], lanes[s.i]) < 0.45)?.i; if (lurk == null) lurk = flank;

    // 角色分配：按性格
    const byAggr = alive.slice().sort((a, b) => (b.persona?.aggression ?? 0.5) - (a.persona?.aggression ?? 0.5));
    const byPatience = alive.slice().sort((a, b) => (b.persona?.patience ?? 0.5) - (a.persona?.patience ?? 0.5));
    const used = new Set(); const pickFrom = (arr) => { for (const b of arr) if (!used.has(b.id)) { used.add(b.id); return b; } return null; };
    const assignments = []; const t = this.time;
    let executeAt = t + 5;
    const assign = (bot, lane, role, stage, extra = {}) => assignments.push({ botId: bot.id, lane, role, stage, sprint: false, ...extra });
    if (strategy === 'rush') {
      executeAt = t + 1.5;
      byAggr.forEach((b, i) => assign(b, 'main', i === 0 ? 'entry' : 'support', 0.25 + i * 0.05, { sprint: true }));
    } else if (strategy === 'flank') {
      executeAt = t + 8;
      assign(pickFrom(byAggr), 'main', 'bait', 0.55); if (n >= 4) assign(pickFrom(byAggr), 'main', 'bait', 0.6);
      for (const b of byAggr) if (!used.has(b.id)) assign(b, 'flank', 'flank', 0.45 + this.rng() * 0.1);
      if (n >= 4) { const l = pickFrom(byPatience); if (l) { assignments.splice(assignments.findIndex((a) => a.botId === l.id), 1); assign(l, 'lurk', 'lurk', 0.3, { delay: 5 }); } }
    } else if (strategy === 'split') {
      executeAt = t + 6;
      const pools = ['main', 'flank', 'lurk']; byAggr.forEach((b, i) => assign(b, pools[i % 3], i < 3 ? 'entry' : 'support', 0.4));
    } else {
      executeAt = t + 5;
      const nMain = Math.max(1, Math.ceil(n * 0.6));
      byAggr.slice(0, nMain).forEach((b, i) => assign(b, 'main', i === 0 ? 'entry' : 'support', 0.3 + i * 0.04));
      const rest = byAggr.slice(nMain); rest.forEach((b, i) => assign(b, 'flank', i === 0 ? 'flank' : 'support', 0.45));
      if (n >= 4 && rest.length) { const l = byPatience.find((b) => rest.includes(b)); if (l) { const a = assignments.find((x) => x.botId === l.id); a.lane = 'lurk'; a.role = 'lurk'; a.delay = 4; a.stage = 0.3; } }
    }
    for (const a of assignments) a.executeAt = executeAt + (a.delay || 0);
    return { kind: 'attack', target, lanes: { main: lanes[main], flank: lanes[flank], lurk: lanes[lurk] }, laneMeta: { main: scored.find((s) => s.i === main), flank: scored.find((s) => s.i === flank) }, assignments, executeAt, strategy, secure: false };
  }

  // ---------------- 防守路线规划 ----------------
  _planDefense(world, team, st) {
    const tv = world.teams[team]; const obj = world.objective; const enemyTeam = team === 'A' ? 'B' : 'A';
    const target = obj ? obj.pos : [0, 0]; const radius = obj?.radius || 8;
    const alive = tv.bots.filter((b) => b.alive && !b.human); const n = alive.length; if (!n) return { assignments: [] };
    const strategy = this.learning.chooseStrategy(team, 'def', DEFENSE_ARMS, 0.1); st.strategy = strategy;
    const entr = this.tac.entrances(target[0], target[1], radius + 4, 5);
    if (!entr.length) return { kind: 'defense', target, radius, entrances: [], positions: [], assignments: [], posterior: [], strategy };
    const eSpawn = world.teams[enemyTeam].spawn || target;
    // 先验：离敌方出生点近的出入口更可能 + 对手模型里常见的区域更可能
    for (const e of entr) e.prior = 1 / (1 + dist(e.x, e.z, eSpawn[0], eSpawn[1]) / 15) + 1.5 * this.learning.enemyProbNear(enemyTeam, e.x, e.z, 12);
    const ps = entr.reduce((a, e) => a + e.prior, 0) || 1; for (const e of entr) e.prior /= ps;
    const positions = this.tac.defensePositions(target[0], target[1], radius, entr, 8, team);
    // 给每个站位算"加权覆盖"（只算先验高的出入口）并排序
    for (const p of positions) { p.w = 0; p.covers = []; for (let i = 0; i < entr.length; i++) if (this.nav.lineOfSight(p.x, p.z, entr[i].x, entr[i].z, 0)) { p.w += entr[i].prior; p.covers.push(i); } }
    if (strategy === 'tight') positions.sort((a, b) => (dist(a.x, a.z, target[0], target[1]) - dist(b.x, b.z, target[0], target[1])) || b.w - a.w);
    else if (strategy === 'forward') positions.sort((a, b) => (dist(b.x, b.z, target[0], target[1]) - dist(a.x, a.z, target[0], target[1])) || b.w - a.w);
    else positions.sort((a, b) => b.w - a.w);
    // 可旋转者：覆盖出入口最多的站位
    let rotIdx = -1, rc = -1; positions.forEach((p, i) => { if (p.covers.length > rc) { rc = p.covers.length; rotIdx = i; } });
    const rotPos = rotIdx >= 0 ? positions.splice(rotIdx, 1)[0] : null;
    const anchors = positions;
    const byAggr = alive.slice().sort((a, b) => (b.persona?.aggression ?? 0.5) - (a.persona?.aggression ?? 0.5));
    const assignments = []; const taken = new Set();
    const needRot = n >= 3 && rotPos;
    const anchorBots = needRot ? byAggr.slice(0, n - 1) : byAggr;
    anchorBots.forEach((b, i) => {
      // 按先验从高到低轮询出入口，挑能覆盖它的、未被占用的最佳站位
      const order = entr.map((e, idx) => idx).sort((a, b2) => entr[b2].prior - entr[a].prior);
      let pos = null, ei = order[i % order.length];
      for (let k = 0; k < order.length && !pos; k++) { const cand = order[(i + k) % order.length]; pos = anchors.find((p) => !taken.has(p) && p.covers.includes(cand)); if (pos) ei = cand; }
      if (!pos) pos = anchors.find((p) => !taken.has(p)) || { x: target[0], z: target[1], covers: [] };
      taken.add(pos);
      assignments.push({ botId: b.id, pos: { x: pos.x, z: pos.z }, entrance: ei, role: 'anchor', lookAt: { x: entr[ei].x, z: entr[ei].z } });
    });
    if (needRot) assignments.push({ botId: byAggr[n - 1].id, pos: { x: rotPos.x, z: rotPos.z }, entrance: -1, role: 'rotator', lookAt: { x: target[0], z: target[1] } });
    return { kind: 'defense', target, radius, entrances: entr, positions, assignments, posterior: entr.map((e) => e.prior), prior: entr.map((e) => e.prior), strategy, rotPos };
  }

  // ---------------- 周期自适应 ----------------
  _adapt(world, team, st) {
    const plan = st.plan; if (!plan) return;
    const tv = world.teams[team]; const alive = tv.bots.filter((b) => b.alive && !b.human); const t = this.time;
    const override = st.lastOrder; // 临时命令（trade/hunt/rotate）优先
    if (plan.kind === 'attack') {
      const obj = world.objective;
      // 1) 主路线连续减员 → 换线（最多两次）
      const mainDeaths = st.laneDeaths.main || 0;
      if (mainDeaths >= 2 && !plan.swapped && t - st.lastReplan > 15) {
        plan.swapped = true; st.lastReplan = t; st.swaps++;
        for (const a of plan.assignments) {
          if (!alive.find((b) => b.id === a.botId)) continue;
          if (a.lane === 'main') { a.lane = 'flank'; a.executeAt = t; a.sprint = true; }
          else if (a.lane === 'flank') { a.lane = 'main'; a.executeAt = t; }
        }
        for (const a of plan.assignments) st.laneOf[a.botId] = a.lane;
      }
      // 2) 交叉火力：主路线已交火、侧翼还没动 → 侧翼立即压上
      const mainContact = st.seen.some((s) => t - s.t < 3 && this._nearLane(plan.lanes.main, s));
      const flankContact = st.seen.some((s) => t - s.t < 4 && this._nearLane(plan.lanes.flank, s));
      if (mainContact && !flankContact) for (const a of plan.assignments) if (a.lane !== 'main' && t < a.executeAt) { a.executeAt = t; a.sprint = true; }
      // 3) 时间压力：目标正在被敌方占领 → 全员冲刺
      if (obj && obj.owner !== team && obj.capture != null) {
        const against = (team === 'A' && obj.capture < -0.15) || (team === 'B' && obj.capture > 0.15);
        if (against) for (const a of plan.assignments) { a.executeAt = Math.min(a.executeAt, t); a.sprint = true; }
      }
      // 4) 到点 → 转为"固守"（站位面向出入口）
      const inside = alive.filter((b) => dist(b.x, b.z, plan.target[0], plan.target[1]) < (obj?.radius || 6) * 0.9);
      if (!plan.secure && inside.length >= Math.max(1, Math.ceil(alive.length * 0.5))) {
        plan.secure = true;
        const entr = this.tac.entrances(plan.target[0], plan.target[1], (obj?.radius || 8) + 2, 5);
        const poss = this.tac.defensePositions(plan.target[0], plan.target[1], obj?.radius || 8, entr, 6, team);
        let k = 0; for (const a of plan.assignments) { if (!alive.find((b) => b.id === a.botId)) continue; const p = poss[k % Math.max(1, poss.length)] || { x: plan.target[0], z: plan.target[1] }; const e = entr[k % Math.max(1, entr.length)] || { x: plan.target[0], z: plan.target[1] }; a.securePos = { x: p.x, z: p.z }; a.lookAt = { x: e.x, z: e.z }; k++; }
      }
      // 5) 残局：只剩自己且无目标 → 去最近一次发现敌人的位置
      if (alive.length === 1 && !override[alive[0].id]) {
        const recent = st.seen.filter((s) => t - s.t < 12).sort((a, b) => b.t - a.t)[0];
        if (recent) override[alive[0].id] = { kind: 'hunt', goal: [recent.x, recent.z], until: t + 4, label: 'HUNT' };
      }
    } else if (plan.kind === 'defense') {
      const obj = world.objective; const enemyTeam = team === 'A' ? 'B' : 'A';
      const entr = plan.entrances; if (!entr.length) return;
      // 1) 贝叶斯推断：敌人会从哪个入口来
      const ev = [...st.heard.filter((h) => t - h.t < 6 && h.team === enemyTeam), ...st.seen.filter((s) => t - s.t < 6)];
      let post = plan.posterior.slice();
      if (ev.length) {
        // 每条证据做一次 softmax 归一化的似然更新（比裸乘更能拉开差距）
        for (let i = 0; i < entr.length; i++) { let L = 1; for (const e of ev) { let w = 0, s = 0; for (let j = 0; j < entr.length; j++) { const v = Math.exp(-dist(e.x, e.z, entr[j].x, entr[j].z) / 12); s += v; if (j === i) w = v; } L *= 0.2 + w / Math.max(1e-6, s); } post[i] *= L; }
        const s = post.reduce((a, b) => a + b, 0) || 1; post = post.map((p) => p / s);
      } else { const k = 0.04; post = post.map((p, i) => p * (1 - k) + plan.prior[i] * k); }
      plan.posterior = post;
      let bi = 0; for (let i = 1; i < post.length; i++) if (post[i] > post[bi]) bi = i;
      const E = entr[bi];
      // 2) 高置信 → 轮转（旋转位 + 最闲的锚点）
      const lost = obj && (obj.owner === enemyTeam || (team === 'A' ? obj.capture < -0.6 : obj.capture > 0.6));
      const enemiesIn = obj ? st.seen.filter((s) => t - s.t < 2.5 && s.team === enemyTeam && dist(s.x, s.z, plan.target[0], plan.target[1]) < plan.radius + 1).length : 0;
      if ((lost || enemiesIn >= 2) && !st.retake) {
        st.retake = { phase: 'gather', since: t, rally: this._rallyPoint(world, team, plan.target) }; this.stats.retakes++;
      }
      if (st.retake) { this._retake(world, team, st, plan, bi); return; }
      if (post[bi] > 0.42 && t - st.lastRotate > 7 && ev.length) {
        st.lastRotate = t; this.stats.rotations++;
        const rot = plan.assignments.find((a) => a.role === 'rotator' && alive.find((b) => b.id === a.botId));
        if (rot) { const p = this._posCovering(plan.positions, E, alive.find((b) => b.id === rot.botId)) || rot.pos; override[rot.botId] = { kind: 'rotate', goal: [p.x, p.z], lookAt: [E.x, E.z], until: t + 6, label: 'ROTATE' }; rot.lookAt = { x: E.x, z: E.z }; }
        // 先验最低入口的锚点，改看高置信入口（保留另一侧至少 1 人）
        const anchors = plan.assignments.filter((a) => a.role === 'anchor' && alive.find((b) => b.id === a.botId));
        if (anchors.length >= 3) {
          const lazy = anchors.slice().sort((a, b) => plan.posterior[a.entrance] - plan.posterior[b.entrance])[0];
          const p = this._posCovering(plan.positions.filter((q) => !plan.assignments.some((a) => a.pos.x === q.x && a.pos.z === q.z && a !== lazy)), E, alive.find((b) => b.id === lazy.botId));
          if (p) { override[lazy.botId] = { kind: 'rotate', goal: [p.x, p.z], lookAt: [E.x, E.z], until: t + 6, label: 'ROTATE' }; lazy.pos = { x: p.x, z: p.z }; lazy.lookAt = { x: E.x, z: E.z }; lazy.entrance = bi; }
        }
      }
    }
  }

  _nearLane(lane, s) { if (!lane) return false; let d = Infinity; for (let i = 0; i < lane.length - 1; i++) d = Math.min(d, pointSegDist2(s.x, s.z, lane[i], lane[i + 1])); return d < 6; }
  _posCovering(positions, E, from) { let best = null, bd = Infinity; for (const p of positions) { if (!this.nav.lineOfSight(p.x, p.z, E.x, E.z, 0)) continue; const d = from ? dist(p.x, p.z, from.x, from.z) : 0; if (d < bd) { bd = d; best = p; } } return best; }
  _rallyPoint(world, team, target) {
    const spawn = world.teams[team].spawn || target;
    const lane = this.tac.findLanes(spawn, target, 1, team)[0];
    if (!lane) return { x: (spawn[0] + target[0]) / 2, z: (spawn[1] + target[1]) / 2 };
    // 沿路线走，找距目标 12~14m 的点
    for (let i = lane.length - 1; i >= 0; i--) { const d = dist(lane[i][0], lane[i][1], target[0], target[1]); if (d >= 12 && d <= 16) return { x: lane[i][0], z: lane[i][1] }; }
    const d0 = dist(lane[0][0], lane[0][1], target[0], target[1]); return d0 > 16 ? { x: lane[0][0], z: lane[0][1] } : { x: (spawn[0] + target[0]) / 2, z: (spawn[1] + target[1]) / 2 };
  }
  _retake(world, team, st, plan, bi) {
    const tv = world.teams[team]; const alive = tv.bots.filter((b) => b.alive && !b.human); const t = this.time; const r = st.retake;
    const E = plan.entrances[bi] || { x: plan.target[0], z: plan.target[1] };
    if (r.phase === 'gather') {
      const near = alive.filter((b) => dist(b.x, b.z, r.rally.x, r.rally.z) < 5).length;
      alive.forEach((b, i) => { st.lastOrder[b.id] = { kind: 'retake', goal: [r.rally.x + (i % 3 - 1) * 1.6, r.rally.z + (Math.floor(i / 3) - 0.5) * 1.6], lookAt: [plan.target[0], plan.target[1]], until: t + 2, label: 'RETAKE·集结' }; });
      if (near >= Math.max(1, Math.ceil(alive.length * 0.6)) || t - r.since > 8) { r.phase = 'push'; r.since = t; r.order = alive.slice().sort((a, b) => (b.hp / b.maxHp) - (a.hp / a.maxHp)); }
    } else if (r.phase === 'push') {
      const poss = this.tac.defensePositions(plan.target[0], plan.target[1], plan.radius, plan.entrances, 6, team);
      // no defensive position could be derived → push straight onto the objective
      r.order.forEach((b, i) => { const p = poss.length ? poss[i % poss.length] : { x: plan.target[0], z: plan.target[1] }; const start = r.since + i * 0.7; st.lastOrder[b.id] = { kind: 'retake', goal: t >= start ? [p.x, p.z] : [b.x, b.z], lookAt: [E.x, E.z], sprint: t >= start, until: t + 2, label: 'RETAKE·突入' }; });
      const inside = alive.filter((b) => dist(b.x, b.z, plan.target[0], plan.target[1]) < plan.radius).length;
      if (inside >= Math.max(1, Math.ceil(alive.length * 0.5)) || t - r.since > 7) { st.retake = null; st.plan = null; /* 重新规划防守 */ }
    }
  }

  // ---------------- 把计划翻译成每个 Bot 的 order ----------------
  _issue(world, team, st) {
    const tv = world.teams[team]; const plan = st.plan; if (!plan) return; const t = this.time;
    for (const b of tv.bots) {
      if (!b.alive || b.human) { b.order = null; continue; }
      const o = st.lastOrder[b.id];
      if (o && o.until > t) { b.order = o; continue; }
      if (o && o.until <= t) delete st.lastOrder[b.id];
      b.order = this._orderFor(world, team, st, plan, b);
    }
  }

  _orderFor(world, team, st, plan, b) {
    const t = this.time;
    if (plan.kind === 'defense') {
      const a = plan.assignments.find((x) => x.botId === b.id); if (!a) return { kind: 'hold', goal: [b.x, b.z], label: 'DEF' };
      const d = dist(b.x, b.z, a.pos.x, a.pos.z);
      const la = a.lookAt || (plan.entrances[a.entrance] ? { x: plan.entrances[a.entrance].x, z: plan.entrances[a.entrance].z } : { x: plan.target[0], z: plan.target[1] });
      return { kind: d > 1.0 ? 'move' : 'hold', goal: [a.pos.x, a.pos.z], lookAt: [la.x, la.z], holdRadius: 1.0, role: a.role, label: `${a.role === 'rotator' ? 'ROT' : 'ANCHOR'}·E${a.entrance + 1}` };
    }
    if (world.mode === 'waves' && plan.phase === 'escort') return this._escortOrder(world, team, plan, b);
    const a = plan.assignments.find((x) => x.botId === b.id); if (!a) return { kind: 'hold', goal: [b.x, b.z], label: 'IDLE' };
    // 固守阶段
    if (plan.secure && a.securePos) { const d = dist(b.x, b.z, a.securePos.x, a.securePos.z); return { kind: d > 1 ? 'move' : 'hold', goal: [a.securePos.x, a.securePos.z], lookAt: [a.lookAt.x, a.lookAt.z], holdRadius: 1, label: 'SECURE' }; }
    const lane = plan.lanes[a.lane] || plan.lanes.main; if (!lane) return { kind: 'hold', goal: [b.x, b.z], label: 'IDLE' };
    const stage = lanePointAt(lane, a.stage);
    if (t < a.executeAt) {
      const d = dist(b.x, b.z, stage[0], stage[1]);
      const look = lanePointAt(lane, Math.min(1, a.stage + 0.15));
      return { kind: d > 1.2 ? 'move' : 'hold', goal: [stage[0], stage[1]], lookAt: look, holdRadius: 1.2, role: a.role, label: `${a.role === 'bait' ? 'BAIT' : 'STAGE'}·${a.lane}` };
    }
    if (a.role === 'bait') { // 诱饵：停在集结点朝目标看，吸引火力
      return { kind: 'hold', goal: [stage[0], stage[1]], lookAt: [plan.target[0], plan.target[1]], holdRadius: 1.2, role: 'bait', label: 'BAIT' };
    }
    // 沿路线推进（换线后路点索引要归零，长路线→短路线时会越界）
    if (st.laneRef[b.id] !== lane) { st.laneRef[b.id] = lane; st.wpOf[b.id] = 0; }
    let wp = st.wpOf[b.id] || 0; if (wp > lane.length - 1) wp = lane.length - 1;
    while (wp < lane.length - 1 && dist(b.x, b.z, lane[wp][0], lane[wp][1]) < this.reach) wp++;
    st.wpOf[b.id] = wp;
    const goal = lane[wp] || lane[lane.length - 1]; const look = lane[Math.min(lane.length - 1, wp + 1)] || goal;
    return { kind: 'move', goal: [goal[0], goal[1]], lookAt: [look[0], look[1]], sprint: !!a.sprint, role: a.role, lane: a.lane, label: `ATK·${a.lane}·${a.role}` };
  }

  // 波次防守：围绕被保护对象（玩家/据点）环形站位，面向最近一次敌方活动方向
  _escortOrder(world, team, plan, b) {
    const anchor = world.escort || world.objective?.pos || [b.x, b.z]; const st = this.teams[team];
    if (!plan.escortAnchor || dist(plan.escortAnchor[0], plan.escortAnchor[1], anchor[0], anchor[1]) > 6 || !plan.assignments.find((a) => a.botId === b.id)) {
      const t = this.time; const recent = st.heard.filter((h) => t - h.t < 10).sort((x, y) => y.t - x.t)[0];
      const dir = recent ? Math.atan2(recent.x - anchor[0], recent.z - anchor[1]) : 0;
      const alive = world.teams[team].bots.filter((x) => x.alive);
      plan.assignments = alive.map((x, i) => { const ang = dir + (i - (alive.length - 1) / 2) * 0.9; const r = 6 + (i % 2) * 2.5; const c = this.tac.bestCover(anchor[0] + Math.cos(ang) * r, anchor[1] + Math.sin(ang) * r, anchor[0] + Math.cos(dir) * 30, anchor[1] + Math.sin(dir) * 30, 5); return { botId: x.id, pos: c ? { x: c.x, z: c.z } : { x: anchor[0] + Math.cos(ang) * r, z: anchor[1] + Math.sin(ang) * r }, lookAt: { x: anchor[0] + Math.cos(dir) * 20, z: anchor[1] + Math.sin(dir) * 20 }, role: 'escort' }; });
      plan.escortAnchor = [anchor[0], anchor[1]];
    }
    const a = plan.assignments.find((x) => x.botId === b.id); if (!a) return { kind: 'hold', goal: [b.x, b.z], label: 'ESCORT' };
    const d = dist(b.x, b.z, a.pos.x, a.pos.z);
    return { kind: d > 1.2 ? 'move' : 'hold', goal: [a.pos.x, a.pos.z], lookAt: [a.lookAt.x, a.lookAt.z], holdRadius: 1.2, role: 'escort', label: 'ESCORT' };
  }

  _planEscort(world, team) { return { kind: 'escort', phase: 'escort', assignments: [], target: world.objective?.pos || [0, 0], time: this.time, strategy: 'escort' }; }

  debugTeam(team) {
    const st = this.teams[team]; const p = st.plan; if (!p) return null;
    return { kind: p.kind, strategy: p.strategy, executeAt: p.executeAt, posterior: p.posterior, assignments: p.assignments, lanes: p.lanes ? Object.keys(p.lanes) : [], retake: st.retake?.phase || null };
  }
}

function lanePointAt(lane, f) {
  if (!lane || !lane.length) return [0, 0]; if (lane.length === 1) return lane[0];
  const total = lane.reduce((a, p, i) => a + (i ? dist(p[0], p[1], lane[i - 1][0], lane[i - 1][1]) : 0), 0);
  let target = total * clamp(f, 0, 1);
  for (let i = 1; i < lane.length; i++) { const d = dist(lane[i][0], lane[i][1], lane[i - 1][0], lane[i - 1][1]); if (target <= d) { const k = d ? target / d : 0; return [lane[i - 1][0] + (lane[i][0] - lane[i - 1][0]) * k, lane[i - 1][1] + (lane[i][1] - lane[i - 1][1]) * k]; } target -= d; }
  return lane[lane.length - 1];
}
function pointSegDist2(px, pz, a, b) { const vx = b[0] - a[0], vz = b[1] - a[1]; const L2 = vx * vx + vz * vz; let t = L2 ? ((px - a[0]) * vx + (pz - a[1]) * vz) / L2 : 0; t = clamp(t, 0, 1); return Math.hypot(px - (a[0] + vx * t), pz - (a[1] + vz * t)); }
