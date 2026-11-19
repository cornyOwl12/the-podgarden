// The podGARDEN multiplayer server: podGAN Photo Lap
//   npm install && npm start          (PORT=8080 by default)
// Serves ../index.html at / and runs the shared ocean at /ws for up to 8 players. Every player is a podGAN (one of
// the 1024 in the swarm, numbered 0-1023) swimming laps of the gate course and taking three photos a lap; the
// scoring happens in each browser. The server keeps the best laps for everyone to see.
// Positions and the wild swarm are relayed between browsers: the lowest-numbered player "hosts" the swarm, sending
// everyone corrections twice a second.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8080;
const GAME = path.join(here, '..', 'index.html');
const MAXP = 8, NPOD = 1024;

const http = createServer(async (req, res) => {
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(await readFile(GAME)); }
    catch { res.writeHead(500); res.end('index.html not found: build the game first (cd source && npm run build)'); }
  } else if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ players: [...players.values()].map(pub), board }));
  } else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024 });
const socks = new Map(), players = new Map(); // id -> ws, id -> { id, name, pod }
let host = -1, board = []; // the best laps: [name, points, seconds], best first
const pub = (p) => ({ id: p.id, name: p.name, pod: p.pod });
const send = (ws, m) => { if (ws.readyState === 1) ws.send(typeof m === 'string' || Buffer.isBuffer(m) ? m : JSON.stringify(m)); };
const all = (m, except) => { const s = JSON.stringify(m); for (const [id, ws] of socks) if (id !== except) send(ws, s); };
const clean = (s) => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
function pickHost() { const h = socks.size ? Math.min(...socks.keys()) : -1; if (h !== host) { host = h; all({ t: 'host', id: host }); } }
function freePod() { const used = new Set([...players.values()].map((p) => p.pod)); for (;;) { const i = Math.floor(Math.random() * NPOD); if (!used.has(i)) return i; } }

wss.on('connection', (ws) => {
  let id = 0; while (socks.has(id)) id++;
  if (id >= MAXP) { send(ws, { t: 'full' }); ws.close(); return; }
  socks.set(id, ws);
  const p = { id, name: `podGAN ${id + 1}`, pod: freePod() };
  players.set(id, p);
  send(ws, { t: 'hi', id, host: host < 0 ? id : Math.min(host, id), players: [...players.values()].map(pub), board });
  all({ t: 'join', p: pub(p) }, id);
  pickHost();
  console.log(`+ player ${id} in podGAN #${p.pod} (${socks.size}/${MAXP})`);

  ws.on('message', (data, binary) => {
    // wild swarm corrections from the host, passed on as they are
    if (binary) { if (id === host) for (const [q, w] of socks) if (q !== id) send(w, data); return; }
    let m; try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case 'name': p.name = clean(m.name) || p.name; all({ t: 'name', id, name: p.name }); break;
      case 's': m.id = id; m.i = p.pod; all(m, id); break; // the state of this player's body, relayed
      case 'lap': { // a finished lap: onto the board if it's one of the ten best
        const pts = Math.max(0, Math.min(100000, m.pts | 0)), secs = Math.max(0, Math.min(3600, +m.secs || 0));
        all({ t: 'lap', id, pts, secs }, id);
        board.push([p.name, pts, Math.round(secs)]); board.sort((a, b) => b[1] - a[1] || a[2] - b[2]); board = board.slice(0, 10);
        all({ t: 'board', board });
        break;
      }
    }
  });
  ws.on('close', () => {
    socks.delete(id); players.delete(id);
    all({ t: 'bye', id, i: p.pod }); pickHost();
    console.log(`- player ${id} (${socks.size}/${MAXP})`);
  });
});

http.listen(PORT, () => console.log(`The podGARDEN server on http://localhost:${PORT}  (players open this address; up to ${MAXP})`));
