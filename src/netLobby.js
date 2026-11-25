// netLobby.js — DOM controller for the #lobby overlay (room code / roster / ready / map / host actions).
import { escHTML } from './util.js';
import { t } from './i18n.js';
import { ROOM_CODE_RE, LIMITS } from './netProtocol.js';

const $ = id => document.getElementById(id);

export class NetLobby {
  constructor(game, on) {
    this.game = game; this.on = on || {};
    this.el = {
      root:$('lobby'), status:$('lobby-status'), pill:$('lobby-pill'),
      home:$('lobby-home'), room:$('lobby-room'),
      create:$('lobby-create'), code:$('lobby-code'), join:$('lobby-join'),
      solo:$('lobby-solo'), codeVal:$('lobby-code-val'), copy:$('lobby-copy'),
      teamA:$('lobby-team-a'), teamB:$('lobby-team-b'),
      map:$('lobby-map'), ready:$('lobby-ready'), start:$('lobby-start'),
      leave:$('lobby-leave'), mode:$('lobby-mode'),
    };
    this.bind();
  }
  show() { this.el.root.classList.remove('hidden'); }
  hide() { this.el.root.classList.add('hidden'); }
  error(key) {
    if (!this.el.status) return;
    this.el.status.textContent = t(key);
    this.el.status.classList.add('err');
  }
  clearError() {
    if (!this.el.status) return;
    this.el.status.textContent = '';
    this.el.status.classList.remove('err');
  }
  updatePill(state, text) {
    if (!this.el.pill) return;
    this.el.pill.className = 'lp-' + (state || 'off');
    this.el.pill.textContent = text || '';
  }
  inviteLink(code) { return `${location.origin}${location.pathname}?room=${code}`; }

  bind() {
    const e = this.el, on = this.on;
    if (e.create) e.create.addEventListener('click', () => { this.clearError(); on.create && on.create(); });
    if (e.join) e.join.addEventListener('click', () => {
      this.clearError();
      const code = (e.code.value || '').toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g,'').slice(0,5);
      e.code.value = code;
      on.join && on.join(code);
    });
    if (e.code) {
      e.code.addEventListener('input', () => {
        e.code.value = e.code.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g,'').slice(0,5);
      });
      e.code.addEventListener('keydown', ev => { if (ev.key === 'Enter' && e.join) e.join.click(); });
    }
    if (e.solo) e.solo.addEventListener('click', () => on.solo && on.solo());
    if (e.ready) e.ready.addEventListener('click', () => on.ready && on.ready());
    if (e.start) e.start.addEventListener('click', () => on.start && on.start());
    if (e.leave) e.leave.addEventListener('click', () => { on.leave && on.leave(); this.hide(); });
    // Click a team header to request a side switch (server enforces the 5-player cap).
    for (const col of [e.teamA, e.teamB]) if (col) col.addEventListener('click', ev => {
      if (ev.target.closest('.lt')) on.side && on.side(col.dataset.side);
    });
    if (e.copy) e.copy.addEventListener('click', () => {
      const code = this.roomCode;
      if (!code) return;
      const link = this.inviteLink(code);
      const done = () => { e.copy.textContent = t('lobby_copied'); setTimeout(() => { e.copy.textContent = t('lobby_copy'); }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, done);
      else {
        const ta = document.createElement('textarea');
        ta.value = link; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (err) {}
        document.body.removeChild(ta); done();
      }
    });
    if (e.map) {
      for (const k of ['desert','snow','snowtown','ember']) {
        const o = document.createElement('option');
        o.value = k; o.textContent = t('map_' + k);
        e.map.appendChild(o);
      }
      e.map.value = this.game.ui.sel.map;
      e.map.addEventListener('change', () => {
        this.game.ui.sel.map = e.map.value;
        this.game.ui.buildPrimaries && this.game.ui.buildPrimaries();
      });
    }
  }

  render(room, meId) {
    if (!this.el.root) return;
    this.roomCode = room?.code || '';
    const inRoom = !!room && !!room.roster;
    this.el.home.classList.toggle('hidden', inRoom);
    this.el.room.classList.toggle('hidden', !inRoom);
    if (!inRoom) return;
    this.clearError();
    if (this.el.codeVal) this.el.codeVal.textContent = room.code;
    // The room's mode decides the team size; show it so a 3v3 room cannot look like 5v5.
    if (this.el.mode) {
      const m = room.mode || 'dm';
      this.el.mode.textContent = `${t('mode_' + m)} · ${room.sizes ? room.sizes.A : ''}v${room.sizes ? room.sizes.A : ''}`;
      this.el.mode.dataset.mode = m;
    }
    const cols = { A:[], B:[] };
    for (const r of room.roster) if (cols[r.team]) cols[r.team].push(r);
    const mine = room.roster.find(r => r.id === meId);
    const isHost = !!mine?.host;
    const row = r => {
      const ready = r.id === meId ? this._myReady : r.ready;
      return `<div class="lr${r.connected ? '' : ' offline'}${r.id===meId ? ' me' : ''}">
        <span class="lr-name">${escHTML(r.name)}</span>
        ${r.host ? `<span class="lr-host">${escHTML(t('lobby_host'))}</span>` : ''}
        <span class="lr-ready ${ready ? 'yes' : ''}">${ready ? escHTML(t('lobby_ready')) : escHTML(t('lobby_waiting'))}</span>
      </div>`;
    };
    if (this.el.teamA) this.el.teamA.innerHTML =
      `<div class="lt">${escHTML(t('faction_ct'))} · ${cols.A.length}/${LIMITS.teamSize}</div>` +
      (cols.A.length ? cols.A.map(row).join('') : `<div class="lempty">${escHTML(t('lobby_waiting'))}</div>`);
    if (this.el.teamB) this.el.teamB.innerHTML =
      `<div class="lt">${escHTML(t('faction_t'))} · ${cols.B.length}/${LIMITS.teamSize}</div>` +
      (cols.B.length ? cols.B.map(row).join('') : `<div class="lempty">${escHTML(t('lobby_waiting'))}</div>`);
    if (this.el.map) {
      this.el.map.value = room.map || this.game.ui.sel.map;
      this.el.map.disabled = !isHost;
    }
    if (this.el.ready) this.el.ready.classList.toggle('hidden', room.phase === 'live');
    if (this.el.start) this.el.start.classList.toggle('hidden', !isHost || room.phase === 'live');
    const readyCount = room.roster.filter(r => r.connected && (r.id === meId ? this._myReady : r.ready)).length;
    this.updatePill(room.phase === 'live' ? 'live' : 'ok',
      `${readyCount}/${room.roster.length} ${t('lobby_ready')}`);
  }
  setMyReady(v) { this._myReady = !!v; }
}
