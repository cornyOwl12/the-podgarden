// The podGARDEN multiplayer server: podGAN tag
//   npm install && npm start          (PORT=8080 by default)
// Serves ../index.html at / and runs the game at /ws for up to 8 players. Every player is a podGAN: one of the
// 1024 in the swarm (numbered 0-1023). The server keeps track of who is in which body, who is IT and the score:
//   - jumping into a wild podGAN is always allowed (your old body goes back to the wild)
//   - only IT can jump into a body another player is in: that's a tag. IT takes the body, the tagged player is
//     thrown into a random wild podGAN and becomes IT. The one who tagged them can't be tagged back for 3 s
//   - score: seconds spent as IT (counted while 2+ players are in), fewest wins
// Positions, ink and the wild swarm are relayed between browsers: the lowest-numbered player "hosts" the swarm,
// sending everyone corrections twice a second.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8080;
const GAME = path.join(here, '..', 'index.html');
const MAXP = 8, NPOD = 1024, NOTAGBACK = 3000, JUMP_GAP = 400;

const http = createServer(async (req, res) => {
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(await readFile(GAME)); }
    catch { res.writeHead(500); res.end('index.html not found: build the game first (cd source && npm run build)'); }
  } else if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ it, players: [...players.values()].map(pub) }));
  } else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024 });
const players = new Map(); // id -> { id, ws, name, pod, itTime, tags, immune, lastJump }
const owner = new Map();   // podGAN number -> player id
let host = -1, it = -1;

const send = (p, m) => { if (p.ws.readyState === 1) p.ws.send(typeof m === 'string' || Buffer.isBuffer(m) ? m : JSON.stringify(m)); };
const all = (m, except) => { const s = JSON.stringify(m); for (const p of players.values()) if (p !== except) send(p, s); };
const pub = (p) => ({ id: p.id, name: p.name, pod: p.pod, itTime: Math.round(p.itTime), tags: p.tags });
const clean = (s) => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
function freePod() { for (;;) { const i = Math.floor(Math.random() * NPOD); if (!owner.has(i)) return i; } }
function setPod(p, i) { if (owner.get(p.pod) === p.id) owner.delete(p.pod); p.pod = i; owner.set(i, p.id); }
function pickHost() { const h = players.size ? Math.min(...players.keys()) : -1; if (h !== host) { host = h; all({ t: 'host', id: host }); } }
// someone has to be IT once there are two of us; a random one
function checkIt() {
  if (players.has(it) || players.size < 2) { if (players.size < 2 && it >= 0) { it = -1; all({ t: 'it', id: -1 }); } return; }
  const ids = [...players.keys()]; it = ids[Math.floor(Math.random() * ids.length)]; all({ t: 'it', id: it });
}
// IT time adds up while there is a game on
let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = (now - last) / 1000; last = now;
  const p = players.get(it); if (p && players.size > 1) p.itTime += dt;
  if (players.size) all({ t: 'score', s: [...players.values()].map((q) => [q.id, Math.round(q.itTime), q.tags]) });
}, 1000);

wss.on('connection', (ws) => {
  let id = 0; while (players.has(id)) id++;
  if (id >= MAXP) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
  const p = { id, ws, name: `podGAN ${id + 1}`, pod: -1, itTime: 0, tags: 0, immune: 0, lastJump: 0 };
  players.set(id, p); setPod(p, freePod());
  send(p, { t: 'hi', id, host: host < 0 ? id : Math.min(host, id), it, players: [...players.values()].map(pub) });
  all({ t: 'join', p: pub(p) }, p);
  pickHost(); checkIt();
  console.log(`+ player ${id} in podGAN #${p.pod} (${players.size}/${MAXP})`);

  ws.on('message', (data, binary) => {
    // wild swarm corrections from the host, passed on as they are
    if (binary) { if (id === host) for (const q of players.values()) if (q !== p) send(q, data); return; }
    let m; try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case 'name': p.name = clean(m.name) || p.name; all({ t: 'name', id, name: p.name }); break;
      case 's': // the state of this player's body, relayed
        m.id = id; m.i = p.pod; all(m, p); break;
      case 'ink': all({ t: 'ink', id, p: m.p }, p); break;
      case 'jump': {
        const i = m.i | 0, now = Date.now();
        if (i < 0 || i >= NPOD || i === p.pod || now - p.lastJump < JUMP_GAP) return;
        const o = owner.get(i);
        if (o === undefined) { // a wild one: just move in
          p.lastJump = now; const from = p.pod; setPod(p, i);
          all({ t: 'own', id, i, from });
        } else { // another player's body: only IT can, and that's a tag
          const q = players.get(o);
          if (!q) { owner.delete(i); return; }
          if (id !== it) { send(p, { t: 'no', why: 'Only IT can jump into another player' }); return; }
          if (now < q.immune) { send(p, { t: 'no', why: `${q.name} just tagged you: no tag-backs for a moment` }); return; }
          p.lastJump = now; p.tags++;
          const from = p.pod, qi = freePod();
          owner.delete(i); setPod(p, i); setPod(q, qi);
          it = q.id; p.immune = now + NOTAGBACK;
          all({ t: 'tag', by: id, v: q.id, i, from, vi: qi });
        }
        break;
      }
    }
  });
  ws.on('close', () => {
    players.delete(id); if (owner.get(p.pod) === id) owner.delete(p.pod);
    all({ t: 'bye', id, i: p.pod }); pickHost(); checkIt();
    console.log(`- player ${id} (${players.size}/${MAXP})`);
  });
});

http.listen(PORT, () => console.log(`The podGARDEN server on http://localhost:${PORT}  (players open this address; up to ${MAXP})`));
