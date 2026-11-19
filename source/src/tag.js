// ============================================================================
// podGAN tag rules: shared by the browser (solo games against bots) and server/server.mjs (online games)
// ============================================================================
// One player starts as IT and hunts. When IT jumps into another player's podGAN, that player is caught and is IT
// too, and the podGAN splits in two: the hunter keeps the body, the caught player swims off in a second podGAN
// that buds off beside it. When everyone is IT the round is over; the last one caught wins. A few seconds later a
// new round starts with everyone in a random podGAN and a new IT.
// Jumping into a wild (unowned) podGAN is always allowed, hunter or not. Ink can be squirted once a minute.
// The rules only keep track of who is where; they report what happened as messages through o.emit:
//   round {n, it, pods: [[id, pod]...], start}   a round starts: everyone moves to their pod, `it` hunts
//   own   {id, i, from}                           someone moved into wild podGAN i
//   enter {by, v, i, ms}                          `by` is getting into `v`'s podGAN i: in ms, `v` is caught unless
//                                                 they squirt ink (or jump away) first
//   dodge {by, v}                                 `v` squirted away in time
//   catch {by, v, i, from, vi, left}              `by` caught `v` in podGAN i; `v` buds off into podGAN vi
//   it    {id}                                    `id` was made IT (the hunter left the game)
//   over  {res: [[id, name, seconds survived, catches]...], next}   all caught: last one first
//   wait  {}                                      not enough players for a round
// o: { npod, now(): milliseconds, emit(message), enter: ms a catch takes (the victim's chance to ink away) }
function TagGame(o) {
  const ROUND_GAP = 8000, JUMP_GAP = 400, INK_GAP = 60000, ENTER = o.enter ?? 200;
  const T = { players: new Map(), owner: new Map(), pend: new Map(), state: 'wait', n: 0, start: 0, overAt: 0, res: null, INK_GAP };
  const setPod = (p, i) => { if (T.owner.get(p.pod) === p.id) T.owner.delete(p.pod); p.pod = i; if (i >= 0) T.owner.set(i, p.id); };
  T.free = () => { for (;;) { const i = Math.floor(Math.random() * o.npod); if (!T.owner.has(i)) return i; } };
  T.survivors = () => [...T.players.values()].filter((p) => !p.it);
  T.pub = (p) => ({ id: p.id, name: p.name, pod: p.pod, it: p.it, caught: p.caught, tags: p.tags });
  T.add = (id, name) => {
    const p = { id, name, pod: -1, it: false, caught: 0, tags: 0, lastJump: 0, inkT: -1e12 };
    T.players.set(id, p); setPod(p, T.free());
    if (T.state === 'play') { p.it = true; p.caught = o.now(); } // joining mid-round: you join the hunt
    return p;
  };
  T.remove = (id) => {
    const p = T.players.get(id); if (!p) return;
    setPod(p, -1); T.players.delete(id);
    for (const [v, e] of T.pend) if (v === id || e.by === id) T.pend.delete(v);
    if (T.state !== 'play') return;
    if (T.players.size < 2) { T.state = 'wait'; o.emit({ t: 'wait' }); return; }
    if (![...T.players.values()].some((q) => q.it)) { // the hunters all left: someone else hunts
      const s = T.survivors(), q = s[Math.floor(Math.random() * s.length)];
      q.it = true; q.caught = o.now(); o.emit({ t: 'it', id: q.id });
    }
  };
  T.newRound = () => {
    const now = o.now(), ps = [...T.players.values()];
    T.state = 'play'; T.n++; T.start = now; T.res = null; T.pend.clear();
    for (const p of ps) { setPod(p, -1); p.it = false; p.caught = 0; p.tags = 0; p.lastJump = 0; }
    for (const p of ps) setPod(p, T.free());
    const it = ps[Math.floor(Math.random() * ps.length)]; it.it = true; it.caught = now;
    o.emit({ t: 'round', n: T.n, it: it.id, pods: ps.map((p) => [p.id, p.pod]), start: now });
  };
  // id wants to jump into podGAN i. Returns a reason when it's not allowed
  T.jump = (id, i) => {
    const p = T.players.get(id), now = o.now();
    if (!p || i < 0 || i >= o.npod || i === p.pod || now - p.lastJump < JUMP_GAP) return '';
    const q = T.players.get(T.owner.get(i));
    if (!q) { p.lastJump = now; const from = p.pod; setPod(p, i); o.emit({ t: 'own', id, i, from }); return null; }
    if (T.state !== 'play') return 'Wait for the next round to start';
    if (!p.it) return 'Only IT can jump into another player';
    if (q.it) return `${q.name} is already IT`;
    if (T.pend.has(q.id)) return '';
    for (const e of T.pend.values()) if (e.by === id) return '';
    // the catch takes a moment, and the victim is warned: ink in time and they get away
    p.lastJump = now;
    T.pend.set(q.id, { by: id, i, at: now });
    o.emit({ t: 'enter', by: id, v: q.id, i, ms: ENTER });
    return null;
  };
  const caught = (p, q, i, now) => {
    p.lastJump = now; p.tags++;
    const from = p.pod, vi = T.free();
    setPod(q, -1); setPod(p, i); setPod(q, vi);
    q.it = true; q.caught = now;
    o.emit({ t: 'catch', by: p.id, v: q.id, i, from, vi, left: T.survivors().length });
  };
  T.ink = (id) => {
    const p = T.players.get(id), now = o.now();
    if (!p || now - p.inkT < INK_GAP - 1500) return false;
    p.inkT = now;
    const e = T.pend.get(id);
    if (e) { T.pend.delete(id); const h = T.players.get(e.by); if (h) h.lastJump = now + 1000; o.emit({ t: 'dodge', by: e.by, v: id }); }
    return true;
  };
  T.tick = () => {
    const now = o.now();
    for (const [v, e] of T.pend) {
      if (now - e.at < ENTER) continue;
      T.pend.delete(v);
      const p = T.players.get(e.by), q = T.players.get(v);
      // still on? (the victim may have jumped to another body in time)
      if (T.state === 'play' && p && q && p.it && !q.it && q.pod === e.i) caught(p, q, e.i, now);
      else if (p && q) o.emit({ t: 'dodge', by: e.by, v });
    }
    if (T.state === 'play' && T.players.size >= 2 && T.survivors().length === 0) {
      // everyone is caught: the last one caught first, then back to the first IT
      const ps = [...T.players.values()].sort((a, b) => b.caught - a.caught);
      T.res = ps.map((p) => [p.id, p.name, Math.max(0, Math.round((p.caught - T.start) / 1000)), p.tags]);
      T.state = 'over'; T.overAt = now;
      o.emit({ t: 'over', res: T.res, next: ROUND_GAP });
    } else if (T.state === 'over' && now - T.overAt > ROUND_GAP) {
      if (T.players.size >= 2) T.newRound(); else { T.state = 'wait'; o.emit({ t: 'wait' }); }
    } else if (T.state === 'wait' && T.players.size >= 2) T.newRound();
  };
  return T;
}
