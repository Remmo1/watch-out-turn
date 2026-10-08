'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { upgrade } = require('./websocket');
const { Arena, matchWinner, WIDTH, HEIGHT, COLORS, BOT_NAMES, POWERUPS } = require('./game');
function createGameServer() {
  const peers = new Set(), people = new Map();
  let participants = [], hostId = null, phase = 'lobby', round = 0, arena = null, until = 0;
  let champion = null, result = '', serial = 0, frameTick = 0, accumulator = 0, last = performance.now();
  const settings = { slots: 6, fillBots: true, difficulty: 'normal', target: 10, speed: 115, powerups: true };
  const id = () => 'p' + (++serial);
  const name = value => typeof value === 'string' ? value.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 20) || 'Player' : 'Player';
  const publicPlayer = p => ({ id: p.id, name: p.name, color: p.color, bot: p.bot, ready: p.ready, connected: p.bot || p.connected, score: p.score });
  const roster = () => participants.map(publicPlayer);
  function broadcast(message) { for (const peer of peers) if (peer.joined) peer.send(message); }
  function room() { return { type: 'room', phase, hostId, settings, players: roster(), round, champion, result, remaining: Math.max(0, until - Date.now()) / 1000 }; }
  function notify() { broadcast(room()); }
  function rebalance() {
    const oldBots = participants.filter(p => p.bot);
    participants = participants.filter(p => !p.bot);
    const used = new Set(participants.map(p => p.color));
    if (settings.fillBots) while (participants.length < Math.max(settings.slots, participants.length) && participants.length < 8) {
      const color = COLORS.find(c => !used.has(c)); used.add(color);
      const n = COLORS.indexOf(color);
      participants.push(oldBots.find(p => p.color === color) || { id: id(), name: BOT_NAMES[n], color, bot: true, ready: true, connected: true, score: 0 });
    }
  }
  function chooseHost() {
    if (!participants.some(p => p.id === hostId && p.connected && !p.bot)) hostId = participants.find(p => !p.bot && p.connected)?.id || null;
  }
  function sync(peer) {
    peer.send(room());
    if (arena) peer.send({ type: 'sync', width: WIDTH, height: HEIGHT, players: arena.players.map(publicPlayer), ...arena.snapshot() });
  }
  function beginRound() {
    participants = participants.filter(p => p.bot || p.connected); chooseHost(); rebalance();
    if (participants.length < 2 || !participants.some(p => !p.bot && p.connected)) return resetLobby();
    round++; arena = new Arena(participants, settings); phase = 'countdown'; until = Date.now() + 3000; result = '';
    broadcast({ type: 'reset', width: WIDTH, height: HEIGHT, players: arena.players.map(publicPlayer), ...arena.snapshot() }); notify();
  }
  function resetLobby() {
    phase = 'lobby'; arena = null; round = 0; champion = null; result = ''; until = 0;
    participants = participants.filter(p => !p.bot && p.connected);
    for (const p of participants) { p.score = 0; p.ready = false; }
    chooseHost(); rebalance(); broadcast({ type: 'clear' }); notify();
  }
  function error(peer, message) { peer.send({ type: 'error', message }); }
  function handle(peer, text) {
    const now = Date.now();
    if (now - peer.windowAt > 1000) { peer.windowAt = now; peer.messages = 0; }
    if (++peer.messages > 80) return peer.close(1008, 'Too many messages');
    let m; try { m = JSON.parse(text); } catch { return error(peer, 'Invalid message.'); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    if (m.type === 'join' && !peer.joined) {
      const resumed = typeof m.token === 'string' ? people.get(m.token) : null;
      let p = resumed && !resumed.connected && now - resumed.leftAt < 15000 && participants.includes(resumed) ? resumed : null;
      if (!p && m.spectator !== true) {
        if (participants.filter(p => !p.bot).length >= 8) return error(peer, 'All eight player seats are taken. Join as a spectator.');
        if (phase === 'lobby') participants = participants.filter(p => !p.bot);
        const used = new Set(participants.map(p => p.color));
        const available = COLORS.find(c => !used.has(c));
        // A late arrival reserves a human seat; a bot gives up its color at the next round.
        const humanColors = new Set(participants.filter(p => !p.bot).map(p => p.color));
        const color = available || COLORS.find(c => !humanColors.has(c)) || COLORS[0];
        p = { id: id(), name: name(m.name), color, bot: false, ready: false, connected: true, score: 0, token: randomBytes(24).toString('hex') };
        participants.push(p); people.set(p.token, p);
      }
      if (p) { p.connected = true; p.leftAt = 0; p.peer = peer; peer.player = p; }
      peer.joined = true; peer.spectator = !p; chooseHost();
      if (phase === 'lobby') rebalance();
      peer.send({ type: 'welcome', id: p?.id || null, token: p?.token || null, width: WIDTH, height: HEIGHT, powerCatalog: POWERUPS });
      sync(peer); notify(); return;
    }
    if (!peer.joined) return;
    const p = peer.player;
    if (m.type === 'input') {
      if (p && arena && phase === 'playing' && [-1, 0, 1].includes(m.steer)) arena.input(p.id, m.steer);
      return;
    }
    if (m.type === 'ready' && p && phase === 'lobby') { p.ready = m.ready === true; notify(); return; }
    if (m.type === 'ping') return peer.send({ type: 'pong', stamp: m.stamp });
    if (!p || p.id !== hostId) return error(peer, 'Only the host can change the match.');
    if (m.type === 'settings' && phase === 'lobby') {
      if ([2, 3, 4, 5, 6, 7, 8].includes(m.slots)) settings.slots = m.slots;
      if (typeof m.fillBots === 'boolean') settings.fillBots = m.fillBots;
      if (typeof m.powerups === 'boolean') settings.powerups = m.powerups;
      if (['easy', 'normal', 'hard'].includes(m.difficulty)) settings.difficulty = m.difficulty;
      if ([10, 25, 50].includes(m.target)) settings.target = m.target;
      if ([90, 115, 145].includes(m.speed)) settings.speed = m.speed;
      rebalance(); notify(); return;
    }
    if (m.type === 'start' && phase === 'lobby') {
      if (participants.length < 2) return error(peer, 'Add bots or wait for another player.');
      if (participants.some(p => !p.bot && p.connected && !p.ready)) return error(peer, 'Every human player must be ready.');
      for (const p of participants) p.score = 0;
      champion = null; round = 0; beginRound(); return;
    }
    if (m.type === 'lobby' && ['roundEnd', 'matchEnd', 'lobby'].includes(phase)) return resetLobby();
  }
  const server = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, phase, humans: participants.filter(p => !p.bot && p.connected).length })); }
    if (!['/', '/index.html', '/favicon.ico'].includes(req.url?.split('?')[0])) { res.writeHead(404); return res.end('Not found'); }
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    fs.readFile(path.join(__dirname, 'index.html'), (err, body) => {
      if (err) { res.writeHead(500); return res.end('Client file missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'" });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });
  server.on('upgrade', (req, socket, head) => {
    // Same-origin browser connections only. No internet-facing configuration is provided.
    let originAllowed = false;
    try { const u = new URL(req.headers.origin); originAllowed = ['http:', 'https:'].includes(u.protocol) && u.host === req.headers.host; } catch {}
    if (req.url !== '/ws' || !originAllowed || peers.size >= 32) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const peer = upgrade(req, socket, head); if (!peer) return;
    peers.add(peer); peer.messages = 0; peer.windowAt = Date.now();
    const joinTimer = setTimeout(() => { if (!peer.joined) peer.close(1008, 'Join timeout'); }, 10000); joinTimer.unref();
    peer.on('message', text => handle(peer, text));
    peer.on('close', () => {
      clearTimeout(joinTimer); peers.delete(peer);
      if (peer.player?.peer === peer) { peer.player.connected = false; peer.player.ready = false; peer.player.leftAt = Date.now(); chooseHost(); notify(); }
    });
    peer.start();
  });
  const heartbeat = setInterval(() => {
    for (const peer of peers) { if (!peer.alive) peer.socket.destroy(); else { peer.alive = false; peer.ping(); } }
  }, 10000); heartbeat.unref();
  const timer = setInterval(() => {
    const current = performance.now(); accumulator += Math.min((current - last) / 1000, 0.1); last = current;
    const now = Date.now();
    if (phase === 'countdown' && now >= until) { phase = 'playing'; until = 0; notify(); }
    if (phase === 'roundEnd' && now >= until) beginRound();
    while (accumulator >= 1 / 60) {
      accumulator -= 1 / 60;
      if (phase === 'playing' && arena) {
        arena.step(new Set(participants.filter(p => !p.bot && !p.connected).map(p => p.id)));
        for (const ap of arena.players) { const p = participants.find(p => p.id === ap.id); if (p) p.score = ap.score; }
        if (arena.done) {
          champion = matchWinner(participants, settings.target)?.id || null;
          phase = champion ? 'matchEnd' : 'roundEnd'; until = champion ? 0 : now + 4500;
          const win = arena.players.find(p => p.id === arena.winner);
          result = champion ? (participants.find(p => p.id === champion)?.name + ' wins the match!') : win ? (win.name + ' survived this round') : arena.reason;
          notify();
        }
      }
      if (++frameTick % 3 === 0 && arena) broadcast({ type: 'state', ...arena.frame(), phase, remaining: Math.max(0, until - now) / 1000 });
    }
    if (!participants.some(p => !p.bot && p.connected) && participants.some(p => !p.bot) && participants.filter(p => !p.bot).every(p => now - p.leftAt > 15000)) resetLobby();
    if (phase === 'lobby') {
      const expired = participants.filter(p => !p.bot && !p.connected && now - p.leftAt > 15000);
      if (expired.length) { participants = participants.filter(p => !expired.includes(p)); for (const p of expired) people.delete(p.token); rebalance(); chooseHost(); notify(); }
    }
    for (const [token, p] of people) if (!participants.includes(p) && !p.connected) people.delete(token);
  }, 1000 / 60);
  server.on('close', () => { clearInterval(timer); clearInterval(heartbeat); });
  return { server, close: () => { for (const p of peers) p.socket.destroy(); return new Promise(resolve => server.close(resolve)); } };
}
if (require.main === module) {
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '0.0.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const game = createGameServer();
  game.server.on('error', err => { console.error('Cannot start server:', err.message); process.exitCode = 1; game.close(); });
  game.server.listen(port, host, () => {
    console.log('\nWATCH OUT / TURN - LAN server\n');
    console.log('On this computer: http://localhost:' + port);
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) console.log('LAN address:      http://' + a.address + ':' + port);
    console.log('\nShare a LAN address with players on the same network. Ctrl+C stops the server.\n');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await game.close(); process.exit(0); });
}
module.exports = { createGameServer };
