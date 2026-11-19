// The podGARDEN multiplayer server: podGAN tag
//   npm install && npm start          (PORT=8080 by default)
// Serves ../index.html at / and runs the game at /ws for up to 8 players. Every player is a podGAN: one of the
// 1024 in the swarm (numbered 0-1023). The rules (who is IT, catching, rounds, scores) are in
// ../source/src/tag.js, the same file the browser uses for solo games against bots:
//   - one player starts as IT; jumping into another player's podGAN catches them: they become IT too, and the
//     podGAN splits in two, one for each of you
//   - when everyone is IT the round is over and the last one caught wins; 8 s later a new round starts
//   - jumping into a wild podGAN is always allowed; ink once a minute
// Positions, ink and the wild swarm are relayed between browsers: the lowest-numbered player "hosts" the swarm,
// sending everyone corrections twice a second.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8080;
const GAME = path.join(here, '..', 'index.html');
const MAXP = 8, NPOD = 1024;
// the shared rules file is plain browser script: load it as a function
const TagGame = new Function(readFileSync(path.join(here, '..', 'source', 'src', 'tag.js'), 'utf8') + '\nreturn TagGame;')();

const http = createServer(async (req, res) => {
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(await readFile(GAME)); }
    catch { res.writeHead(500); res.end('index.html not found: build the game first (cd source && npm run build)'); }
  } else if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ state: game.state, round: game.n, players: [...game.players.values()].map(game.pub) }));
  } else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024 });
const socks = new Map(); // id -> ws
let host = -1;

const send = (ws, m) => { if (ws.readyState === 1) ws.send(typeof m === 'string' || Buffer.isBuffer(m) ? m : JSON.stringify(m)); };
const all = (m, except) => { const s = JSON.stringify(m); for (const [id, ws] of socks) if (id !== except) send(ws, s); };
const game = TagGame({ npod: NPOD, now: Date.now, emit: (m) => all(m) });
const clean = (s) => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
function pickHost() { const h = socks.size ? Math.min(...socks.keys()) : -1; if (h !== host) { host = h; all({ t: 'host', id: host }); } }
setInterval(() => game.tick(), 250);

wss.on('connection', (ws) => {
  let id = 0; while (socks.has(id)) id++;
  if (id >= MAXP) { send(ws, { t: 'full' }); ws.close(); return; }
  socks.set(id, ws);
  const p = game.add(id, `podGAN ${id + 1}`);
  send(ws, { t: 'hi', id, host: host < 0 ? id : Math.min(host, id), state: game.state, n: game.n, start: game.start, res: game.res, players: [...game.players.values()].map(game.pub) });
  all({ t: 'join', p: game.pub(p) }, id);
  pickHost();
  if (game.state === 'wait' && game.players.size < 2) send(ws, { t: 'wait' });
  console.log(`+ player ${id} in podGAN #${p.pod} (${socks.size}/${MAXP})`);

  ws.on('message', (data, binary) => {
    // wild swarm corrections from the host, passed on as they are
    if (binary) { if (id === host) for (const [q, w] of socks) if (q !== id) send(w, data); return; }
    let m; try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case 'name': p.name = clean(m.name) || p.name; all({ t: 'name', id, name: p.name }); break;
      case 's': m.id = id; m.i = p.pod; all(m, id); break; // the state of this player's body, relayed
      case 'ink': if (game.ink(id)) all({ t: 'ink', id, p: m.p }, id); break;
      case 'jump': { const why = game.jump(id, m.i | 0); if (why) send(ws, { t: 'no', why }); break; }
    }
  });
  ws.on('close', () => {
    socks.delete(id); const i = p.pod;
    all({ t: 'bye', id, i }); // first, so everyone has forgotten them before any "wait" or new IT
    game.remove(id); pickHost();
    console.log(`- player ${id} (${socks.size}/${MAXP})`);
  });
});

http.listen(PORT, () => console.log(`The podGARDEN server on http://localhost:${PORT}  (players open this address; up to ${MAXP})`));
