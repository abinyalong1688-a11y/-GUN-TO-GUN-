// room.js — pure room state machine (no Cloudflare / DOM dependency, Node-testable).
// One instance per room code. The DO owns mode, scoring, roster, timer and host election;
// positions, physics and AI stay on the clients.
import { LIMITS, MODE, DEFAULT_MODE, modeLimits, isMode, sanitizeName, BOT_OP, BOT_ID } from '../src/netProtocol.js';

export function createRoom(code, now) {
  const m = modeLimits(DEFAULT_MODE);
  return {
    v:2, code, phase:'lobby', hostId:null, map:'desert', bots:[],
    mode:DEFAULT_MODE, teamSize:m.teamSize,               // fixed when the host picks the mode
    createdAt:now, startAt:0, left:0, duration:m.duration, winKills:m.winKills,
    humans:{}, order:[], score:{A:0,B:0}, kills:{}, seq:0, seen:{},
    worldGeo:null, worldMap:'',   // authoritative map geometry (host upload, hash-pinned)
  };
}

const count = (s, team) => Object.values(s.humans).filter(h => h.team === team).length;
const slots = s => (s.teamSize || LIMITS.teamSize);

export function uniqueName(s, name) {
  const base = sanitizeName(name) || 'Player';
  const taken = new Set(Object.values(s.humans).map(h => h.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 50; i++) {
    const n = `${base} ${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return base + ' ' + Date.now().toString(36).slice(-3);
}

/* The host picks the mode in the menu; the room mirrors team size / duration / win target.
   Joining clients learn it from s:room, so the choice has to happen before anyone else joins. */
export function setMode(s, mode) {
  if (!isMode(mode)) return { err:'badMode' };
  if (s.phase !== 'lobby') return { err:'locked' };
  if (Object.keys(s.humans).length > 1) return { err:'locked' };
  s.mode = mode;
  const m = modeLimits(mode);
  s.teamSize = m.teamSize;
  s.winKills = m.winKills;
  s.duration = m.duration;
  s.left = m.duration;
  return { ok:true };
}

export function join(s, { id, name, op, camo, token }, now) {
  if (s.humans[id]) {
    s.humans[id].connected = true;
    return { ok:true, host:s.hostId === id, reconnect:true, team:s.humans[id].team };
  }
  // Token续位: a client that reconnects within the grace window reclaims its old seat (team,
  // host rights, name) instead of consuming a new slot. Only disconnected seats can be claimed.
  if (token) {
    const prev = Object.values(s.humans).find(h => h.token === token && !h.connected);
    if (prev) {
      delete s.humans[prev.id];
      s.order = s.order.map(x => x === prev.id ? id : x);
      if (s.hostId === prev.id) s.hostId = id;
      s.humans[id] = { ...prev, id, connected:true };
      return { ok:true, team:prev.team, rejoin:true };
    }
  }
  if (Object.keys(s.humans).length >= LIMITS.maxHumans) return { err:'full' };
  // Auto-balance: join the smaller team; a full team cannot be joined even if the other has room.
  const team = count(s, 'A') <= count(s, 'B') ? 'A' : 'B';
  if (count(s, team) >= slots(s)) return { err:'full' };
  s.humans[id] = {
    id, name:uniqueName(s, name), op, camo, team, ready:false,
    connected:true, joinedAt:now, token:token || '',
  };
  s.order.push(id);
  if (!s.hostId) s.hostId = id;
  return { ok:true, team };
}

export function setSide(s, id, team) {
  const h = s.humans[id]; if (!h) return { err:'unknown' };
  if (s.phase !== 'lobby') return { err:'locked' };
  if (team !== 'A' && team !== 'B') return { err:'badTeam' };
  if (h.team === team) return { ok:true };
  if (count(s, team) >= slots(s)) return { err:'teamFull' };
  h.team = team; return { ok:true };
}

export function setReady(s, id, ready) {
  const h = s.humans[id]; if (!h) return { err:'unknown' };
  if (s.phase !== 'lobby') return { err:'locked' };
  h.ready = !!ready; return { ok:true };
}

export function start(s, now, { map, difficulty } = {}) {
  if (!s.hostId) return { err:'noHost' };
  if (s.phase === 'live') return { err:'alreadyLive' };
  const m = modeLimits(s.mode);
  s.phase = 'live';
  s.map = map || s.map;
  s.difficulty = difficulty || s.difficulty || 'normal';
  s.startAt = now + 3000;
  s.duration = m.duration;
  s.left = m.duration;
  s.winKills = m.winKills;
  s.teamSize = m.teamSize;
  s.score = { A:0, B:0 };
  s.kills = {};                       // per-entity kill/death counters for the result screen
  s.seq = 0; s.seen = {};
  s.bots = [];
  if (m.botFill) {
    for (const team of ['A','B']) {
      const filled = count(s, team);
      for (let i = filled; i < m.teamSize; i++)
        s.bots.push({ id:BOT_ID(team, i), team, name:`BOT-${team}${i+1}`, op:BOT_OP[team], alive:true });
    }
  }
  return { ok:true };
}

/* A kill is authoritative here. seq is per-victim monotonic and rejects duplicates/replays.
   Scoring: the point goes to the killer's team (a bot's own team when a bot scored), and only
   when killer and victim are on opposing teams. Unknown victims never score. */
export function recordKill(s, { killerId, victimId, killerName, victimName, weapon, head, seq = 0 }) {
  const k = s.humans[killerId], v = s.humans[victimId];
  if (!k && !killerName) return { err:'unknown' };
  if (victimId && seq > 0) {
    const last = s.seen[victimId] || 0;
    if (seq <= last) return { err:'duplicate', score:{ ...s.score }, seq:s.seq };
    s.seen[victimId] = seq;
  }
  const bot = (s.bots || []).find(b => b.id === killerId);
  const victimBot = (s.bots || []).find(b => b.id === victimId);
  const killerTeam = k ? k.team : (bot ? bot.team : null);
  const victimTeam = v ? v.team : (victimBot ? victimBot.team : null);
  s.seq++;
  // K/D counters feed the result board (they are informational, so they count every kill).
  if (killerTeam) {
    s.kills[killerId] = s.kills[killerId] || { id:killerId, name:killerName || (bot && bot.name) || '', team:killerTeam, kills:0, deaths:0 };
    s.kills[killerId].kills++;
  }
  if (victimTeam) {
    s.kills[victimId] = s.kills[victimId] || { id:victimId, name:victimName || (victimBot && victimBot.name) || '', team:victimTeam, kills:0, deaths:0 };
    s.kills[victimId].deaths++;
  }
  // No known killer team, no known victim team, or a team kill → the score does not move.
  // Control point (koth) is scored by addPoint(), not by kills.
  if (!killerTeam || !victimTeam || killerTeam === victimTeam || s.mode === MODE.KOTH)
    return { ok:true, score:{ ...s.score }, end:null };
  s.score[killerTeam] += 1;
  return { ok:true, score:{ ...s.score }, end:checkEnd(s) };
}

/* Control point (koth): the host reports who is standing on the point and the DO is the single
   writer of the score, so the two clients cannot disagree about the capture. */
export function addPoint(s, team) {
  if (s.phase !== 'live' || (team !== 'A' && team !== 'B')) return { err:'bad' };
  s.score[team] += 1;
  return { ok:true, score:{ ...s.score }, end:checkEnd(s) };
}

function checkEnd(s) {
  if (!(s.winKills > 0)) return null;
  if (s.score.A >= s.winKills || s.score.B >= s.winKills)
    return s.score.A > s.score.B ? 'A' : 'B';
  return null;
}

export function tick(s, now) {
  if (s.phase !== 'live') return { left:0 };
  const dur = s.duration ?? LIMITS.duration;
  if (!(dur > 0)) { s.left = 0; return { left:0 }; }
  s.left = Math.max(0, Math.min(dur, dur - (now - s.startAt) / 1000));
  if (s.startAt > now) s.left = dur; // 3 s countdown: keep the clock full
  if (s.left <= 0 && s.startAt <= now) { s.phase = 'over'; return { end:'time', left:0 }; }
  return { left:s.left };
}

export function promoteHost(s) {
  const next = s.order.find(id => s.humans[id] && s.humans[id].connected && id !== s.hostId);
  s.hostId = next || null;
  return s.hostId;
}

export const toJSON = s => JSON.stringify(s);
export const fromJSON = o => JSON.parse(o);
