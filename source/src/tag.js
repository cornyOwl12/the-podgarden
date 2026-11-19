// ============================================================================
// Body Snatchers: the rules, shared by the server (server/server.mjs) and the solo game against bots (main.js)
// ============================================================================
// Players look exactly like the 1024 wild podGANs. Each round two of them (one if there are fewer than four)
// start as hunters, who glow red; the rest are hiders, lost in the crowd. Hiders score by swimming through
// glowing pearls (which sit at wild podGANs' homes), and may hop into any wild podGAN. Hunters can't hop: jumping
// into a podGAN is a guess. Guess a hider and they get a moment's warning, then are caught and hunt too (they
// split off into a podGAN of their own); guess a wild one and the hunter is stunned for 3 s while it squeals.
// A hunter's sonar ping goes "bwong" for everyone to hear. Rounds last 4 minutes: hiders win if any are still
// free. Points for pearls, time survived, catches and surviving; a match is three rounds.
//
// Messages it emits (the server sends them to every player as they are):
//   round {n, rim, its:[id], pods:[[id, pod]], pearls:[pod], len}   a round starts (rim: round in the match, 1-3)
//   own {id, i, from}                              someone hopped into wild podGAN i
//   miss {id, i, until}                            hunter `id` guessed wild podGAN i: stunned for `until` ms
//   enter {by, v, i, ms}                           hunter `by` is getting into `v`'s podGAN i: caught in ms unless
//                                                  they ink (or hop away) first
//   dodge {by, v}                                  `v` got away
//   catch {by, v, i, from, vi, left}               `by` caught `v` in podGAN i; `v` buds off into podGAN vi
//   pearl {k, by, pod}                             `by` took pearl k; it moves to podGAN `pod`'s home
//   bonus {id, pts, why}                           extra points (an inkfish found)
//   bwong {id, i}                                  hunter `id` pinged from podGAN i
//   it {id}                                        `id` hunts now (the hunters all left)
//   over {res, next, hiders, rim, match}           round over: res [[id, name, points, total, pearls, catches,
//                                                  seconds free]] best first; hiders: did they win; match: last of 3
//   wait {}                                        fewer than two players: no game until someone else comes
// o: { npod, now(): milliseconds, emit(message), enter: ms a catch takes (the victim's chance to get away) }
function TagGame(o) {
  const LEN = 240000, OVER_GAP = 10000, JUMP_GAP = 400, INK_GAP = 60000, STUN = 3000, PING_GAP = 6000, NPEARL = 30, MATCH = 3;
  const ENTER = o.enter ?? 200;
  // the colour scheme of podGAN i, as swarm.js and the shader pick it (3: inkfish)
  const pcg = (v) => { const s = (Math.imul(v, 747796405) + 2891336453) >>> 0; const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0; return ((w >>> 22) ^ w) >>> 0; };
  const inkfish = (i) => { const r = (pcg((pcg(i) + 4) >>> 0) >>> 8) / 16777216; return r >= 63 / 128 && r < 0.5; };
  const T = { players: new Map(), owner: new Map(), pend: new Map(), pearls: [], used: new Set(), state: 'wait', n: 0, rim: 0,
    start: 0, overAt: 0, res: null, INK_GAP, LEN };
  const rnd = (n) => Math.floor(Math.random() * n);
  T.free = () => { for (let k = 0; k < 1000; k++) { const i = rnd(o.npod); if (!T.owner.has(i) && !T.pearls.includes(i)) return i; } return 0; };
  const setPod = (p, i) => { if (T.owner.get(p.pod) === p.id) T.owner.delete(p.pod); p.pod = i; if (i >= 0) T.owner.set(i, p.id); };
  T.survivors = () => [...T.players.values()].filter((p) => !p.it);
  T.hunters = () => [...T.players.values()].filter((p) => p.it);
  T.pub = (p) => ({ id: p.id, name: p.name, pod: p.pod, it: p.it, total: p.total });
  T.elapsed = () => o.now() - T.start;
  T.add = (id, name) => {
    const p = { id, name: String(name || `podGAN ${id + 1}`).slice(0, 16), pod: -1, it: T.state === 'play', caught: 0, lastJump: 0, inkT: -1e9,
      pingT: -1e9, stun: 0, score: 0, total: 0, pearls: 0, catches: 0, huntN: 0 };
    T.players.set(id, p); setPod(p, T.free());
    if (p.it) p.caught = o.now(); // joining mid-round: you hunt
    return p;
  };
  T.remove = (id) => {
    const p = T.players.get(id); if (!p) return;
    setPod(p, -1); T.players.delete(id);
    for (const [v, e] of T.pend) if (v === id || e.by === id) T.pend.delete(v);
    if (T.state !== 'play') return;
    if (T.players.size < 2) { T.state = 'wait'; o.emit({ t: 'wait' }); return; }
    if (!T.hunters().length) { const q = T.survivors()[0]; q.it = true; q.caught = o.now(); o.emit({ t: 'it', id: q.id }); }
  };
  T.newRound = () => {
    const now = o.now(), ps = [...T.players.values()];
    if (T.rim >= MATCH) { T.rim = 0; for (const p of ps) { p.total = 0; p.huntN = 0; } }
    T.state = 'play'; T.n++; T.rim++; T.start = now; T.res = null; T.pend.clear(); T.used.clear();
    T.owner.clear(); T.pearls = [];
    for (const p of ps) { p.pod = -1; p.it = false; p.caught = 0; p.stun = 0; p.score = 0; p.pearls = 0; p.catches = 0; p.lastJump = 0; }
    // the hunters: whoever has hunted least this match
    const nh = ps.length >= 4 ? 2 : 1;
    ps.sort((a, b) => a.huntN - b.huntN || Math.random() - 0.5).slice(0, nh).forEach((p) => { p.it = true; p.huntN++; });
    for (const p of ps) setPod(p, T.free());
    for (let k = 0; k < NPEARL; k++) T.pearls.push(T.free());
    o.emit({ t: 'round', n: T.n, rim: T.rim, its: ps.filter((p) => p.it).map((p) => p.id), pods: ps.map((p) => [p.id, p.pod]), pearls: T.pearls.slice(), len: LEN });
  };
  // id jumps into podGAN i. Returns null when it happened (or started), '' to ignore quietly, or why not
  T.jump = (id, i) => {
    const p = T.players.get(id), now = o.now();
    if (!p || i < 0 || i >= o.npod || i === p.pod) return '';
    if (now - p.lastJump < JUMP_GAP) return '';
    if (now < p.stun) return "You're stunned!";
    for (const e of T.pend.values()) if (e.by === id) return '';
    const qid = T.owner.get(i);
    if (qid === undefined) {
      if (T.state === 'play' && p.it) { // a hunter's guess, and this one is wild
        p.lastJump = now; p.stun = now + STUN;
        o.emit({ t: 'miss', id, i, until: STUN });
        return null;
      }
      p.lastJump = now;
      const from = p.pod; setPod(p, i);
      o.emit({ t: 'own', id, i, from });
      if (T.state === 'play' && inkfish(i) && !T.used.has(i)) { // a rare inkfish: ink refilled and points
        T.used.add(i); p.inkT = -1e9; p.score += 20; o.emit({ t: 'bonus', id, pts: 20, why: 'inkfish' });
      }
      return null;
    }
    const q = T.players.get(qid);
    if (T.state !== 'play') return 'Wait for the next round to start';
    if (!p.it) return 'Someone is already in there';
    if (q.it) return `${q.name} is a hunter already`;
    if (T.pend.has(q.id)) return '';
    p.lastJump = now;
    T.pend.set(q.id, { by: id, i, at: now });
    o.emit({ t: 'enter', by: id, v: q.id, i, ms: ENTER });
    return null;
  };
  const caught = (p, q, i, now) => {
    p.lastJump = now; p.catches++; p.score += 25;
    const from = p.pod, vi = T.free();
    setPod(q, -1); setPod(p, i); setPod(q, vi);
    q.it = true; q.caught = now;
    const left = T.survivors().length;
    o.emit({ t: 'catch', by: p.id, v: q.id, i, from, vi, left });
    if (!left) end(false, now, q);
  };
  T.ink = (id) => {
    const p = T.players.get(id), now = o.now();
    if (!p || now - p.inkT < INK_GAP - 1500) return false;
    p.inkT = now;
    const e = T.pend.get(id);
    if (e) { T.pend.delete(id); const h = T.players.get(e.by); if (h) h.lastJump = now + 1000; o.emit({ t: 'dodge', by: e.by, v: id }); }
    return true;
  };
  // a hider swam through pearl k
  T.pearl = (id, k) => {
    const p = T.players.get(id);
    if (!p || p.it || T.state !== 'play' || !(k >= 0 && k < T.pearls.length)) return false;
    p.pearls++; p.score += 10;
    T.pearls[k] = T.free();
    o.emit({ t: 'pearl', k, by: id, pod: T.pearls[k] });
    return true;
  };
  // sonar: anyone may ping, but a hunter's ping is heard by all
  T.ping = (id) => {
    const p = T.players.get(id), now = o.now();
    if (!p || now - p.pingT < PING_GAP - 300) return false;
    p.pingT = now;
    if (p.it && T.state === 'play') o.emit({ t: 'bwong', id, i: p.pod });
    return true;
  };
  // the round's points: pearls and catches as they happen, then 1 a second free (every 4 s), 50 for surviving
  // the round, 30 for the last hider caught
  function end(hiders, now, last) {
    T.state = 'over'; T.overAt = now; T.pend.clear();
    for (const p of T.players.values()) {
      const free = Math.floor(((p.it ? p.caught || T.start : now) - T.start) / 1000);
      if (p.caught || !p.it) p.score += Math.floor(free / 4);
      if (!p.it) p.score += 50;
      if (last && p === last) p.score += 30;
      p.total += p.score; p.free = p.caught || !p.it ? free : 0;
    }
    T.res = [...T.players.values()].sort((a, b) => b.score - a.score).map((p) => [p.id, p.name, p.score, p.total, p.pearls, p.catches, p.free]);
    o.emit({ t: 'over', res: T.res, next: OVER_GAP, hiders, rim: T.rim, match: T.rim >= MATCH });
  }
  T.tick = () => {
    const now = o.now();
    for (const [v, e] of T.pend) {
      if (now - e.at < ENTER) continue;
      T.pend.delete(v);
      const p = T.players.get(e.by), q = T.players.get(v);
      // still on? (the victim may have hopped away in time)
      if (T.state === 'play' && p && q && p.it && !q.it && q.pod === e.i) caught(p, q, e.i, now);
      else if (p && q) o.emit({ t: 'dodge', by: e.by, v });
    }
    if (T.state === 'play') { if (now - T.start >= LEN) end(true, now, null); }
    else if (T.state === 'over') { if (now - T.overAt >= OVER_GAP) { if (T.players.size >= 2) T.newRound(); else { T.state = 'wait'; o.emit({ t: 'wait' }); } } }
    else if (T.state === 'wait' && T.players.size >= 2) T.newRound();
  };
  return T;
}
