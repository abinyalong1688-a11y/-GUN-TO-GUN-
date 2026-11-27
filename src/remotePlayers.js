// remotePlayers.js — avatar factory + snapshot landing. Remote humans and host-replicated bots
// are ordinary HeroBot instances with netDriven=true, so fire()/radar/hit spheres need no changes.
import { HeroBot } from './heroes.js';
import { byId, DEFAULT_OP } from './operators.js';
import { SnapshotBuffer } from './interp.js';
import { decodePeer } from './netProtocol.js';

const opFor = h => {
  const base = byId(h.op) || byId(DEFAULT_OP);
  return { ...base, camo:h.camo || 'default' };
};

/* Create a net-driven proxy. `faction` follows the team online (A=ct, B=t), so name-tag
   colours and bot combat style stay correct even if an operator was switched between sides. */
export function makeNetHero(game, h, { isBot = false, isHost = false } = {}) {
  const op = opFor(h);
  const team = h.team || 'A';
  const faction = h.faction || (team === 'A' ? 'ct' : 't');
  const b = new HeroBot(game, game.scene, game.assets, game.effects, game.audio, game.ui, {
    operator:op, team, name:h.name, faction,
    netId:h.id, netDriven:isBot ? !isHost : true, kind:isBot?'bot':'human',
    spawnBase:game.spawns ? game.spawns[team] : null,
    isSimulated:isBot && isHost,
  });
  b.netBuf = new SnapshotBuffer(32);
  return b;
}

/* Mid-match join: adopt new proxies without clearing the existing roster (adopt(), not setup()). */
export function spawnCombatants(game, { humans = [], bots = [], isHost = false } = {}) {
  const made = [];
  for (const h of humans) {
    if (game.heroes.byNetId(h.id)) continue;
    made.push(game.heroes.adopt(makeNetHero(game, h, { isBot:false, isHost })));
  }
  for (const h of bots) {
    if (game.heroes.byNetId(h.id)) continue;
    made.push(game.heroes.adopt(makeNetHero(game, h, { isBot:true, isHost })));
  }
  return made;
}

/* s:peers / s:bots landing: locate the proxy by netId, push into its interpolation buffer. */
export function applyPeers(game, serverT, peers) {
  if (!peers || !peers.length) return;
  for (const a of peers) {
    const d = decodePeer(a);
    const h = game.heroes.byNetId(d.id);
    if (!h || !h.netBuf) continue;
    // A non-finite / out-of-map snapshot would poison interpolation and the render matrix.
    if (![d.x,d.y,d.z,d.yaw,d.pitch,d.hp].every(Number.isFinite)) continue;
    if (Math.hypot(d.x,d.z) > 60 || d.y < -2 || d.y > 14) continue;
    h.netBuf.push(serverT, {
      x:d.x, y:d.y, z:d.z, yaw:d.yaw, pitch:d.pitch,
      hp:Math.max(0, Math.min(200, d.hp)), alive:!!(d.flags & 1), crouch:!!(d.flags & 2),
    });
  }
}

/* An s:hit addressed to a bot is resolved by the host, which owns that bot's simulation. */
export function applyHitToBot(game, msg) {
  const h = game.heroes.byNetId(msg.bot);
  if (!h || h.netDriven || !h.alive) return false;
  const from = { id:msg.from, name:msg.fromName, pos:msg.pos || null };
  const hp = h.takeDamage(msg.dmg, msg.fromName, !!msg.head, msg.from);
  /* takeDamage returns -1 when nothing was settled (spawn shield / already dead). A shielded bot
     must not flash an impact, and must not be recorded as the last remote hit — that record is
     what authorises the host to report a bot death, so a shielded target would otherwise
     consume a kill it never took. */
  if (hp === -1) return false;
  game.botDamageFx && game.botDamageFx(h, h.pos);
  game.lastRemoteHit = from;  // consumed by onHeroKill -> reportBotDeath
  return true;
}

/* Host migration: turn a snapshot proxy into a locally simulated bot in place (keep position/HP). */
export function promoteToSimulated(h) {
  if (!h || !h.netDriven) return;
  h.netDriven = false;
  h.kind = h.kind === 'human' ? 'bot' : h.kind;
  h.netBuf = null;
  h.isSimulated = true;
  // Keep the last authoritative HP/alive state: a host migration must not resurrect dead bots.
  const wasAlive=!!h.alive, hp=Number.isFinite(h.hp)?h.hp:h.maxHp, deathT=h.deathT||0;
  h.alive = wasAlive; h.state = wasAlive ? 'active' : 'dying'; h.deathT = deathT; h.hp = hp;
  h.fireT = Math.max(h.fireT||0,.2); h.reactionT = 0; h.burst = 0;
  // Keep current AI decisions (route/cover) instead of clearing them on migration.
  h.group.visible = true;
  h.group.rotation.set(0, h.yaw, 0);
}
