'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Arena, matchWinner, WIDTH, HEIGHT, COLORS } = require('./game');
const makePlayers = (n = 3, bot = false) => Array.from({length:n}, (_,i) => ({id:'p'+i,score:0,bot,name:'Test '+i,color:COLORS[i]}));
const rng = seed => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
test('spawns are inside the arena and trails are server-owned', () => {
  const a = new Arena(makePlayers(8));
  for (const p of a.players) { assert.ok(p.x > 4 && p.x < WIDTH-4 && p.y > 4 && p.y < HEIGHT-4); }
  a.step(); assert.equal(a.segments.length,8); assert.equal(a.drain().length,8); assert.equal(a.drain().length,0);
});
test('wall elimination rewards every remaining survivor', () => {
  const a = new Arena(makePlayers()); a.players[0].x = 3; a.players[0].angle = Math.PI;
  a.step(); assert.equal(a.players[0].alive,false); assert.equal(a.players[0].score,0);
  assert.equal(a.players[1].score,1); assert.equal(a.players[2].score,1);
});
test('head-on collisions are simultaneous and give no ordering advantage', () => {
  const a = new Arena(makePlayers(2)); const [p,q] = a.players;
  p.x = 400; p.y = 350; p.angle = 0; q.x = 407; q.y = 350; q.angle = Math.PI;
  a.step(); assert.equal(p.alive,false); assert.equal(q.alive,false); assert.equal(p.score,0); assert.equal(q.score,0); assert.equal(a.winner,null); assert.equal(a.done,true);
});
test('existing trails kill, but fresh own trails do not', () => {
  const a = new Arena(makePlayers(3)); const p = a.players[0];
  assert.equal(a.blocked(p.x,p.y,p),false);
  a.mark(400,400,2); assert.equal(a.blocked(400,400,p),true);
  a.tick = 9; assert.equal(a.blocked(p.x,p.y,p),true);
});
test('gaps stop trail deposition, not collision checking', () => {
  const a = new Arena(makePlayers(3)); const p = a.players[0]; p.gap = true; p.gapUntil = 2;
  a.step(); assert.equal(a.segments.some(s => s[0] === p.id),false);
  a.mark(p.x+2,p.y,2); assert.equal(a.blocked(p.x+2,p.y,p),true);
});
test('steering input expires if a client stops sending it', () => {
  const a = new Arena(makePlayers(3)); a.input('p0',1);
  assert.equal(a.players[0].steer,1); a.time = .7; a.step(); assert.equal(a.players[0].steer,0);
});
test('disconnected players are eliminated and cannot win by disconnecting', () => {
  const a = new Arena(makePlayers(2)); a.step(new Set(['p0']));
  assert.equal(a.players[0].alive,false); assert.equal(a.players[1].score,1); assert.equal(a.winner,'p1');
});
test('match requires target and two-point advantage', () => {
  assert.equal(matchWinner([{id:'a',score:10},{id:'b',score:9}],10),null);
  assert.equal(matchWinner([{id:'a',score:10},{id:'b',score:8}],10).id,'a');
  assert.equal(matchWinner([{id:'a',score:9},{id:'b',score:0}],10),null);
  assert.equal(matchWinner([{id:'a',score:52},{id:'b',score:50}],50).id,'a');
});
test('all bot difficulties finish deterministic games with finite positions', () => {
  for (const difficulty of ['easy','normal','hard']) for (let seed = 1; seed <= 5; seed++) {
    const a = new Arena(makePlayers(6,true),{difficulty},rng(seed));
    for (let t = 0; t < 5402 && !a.done; t++) a.step();
    assert.equal(a.done,true); assert.ok(a.segments.length < 33000);
    for (const p of a.players) { assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y)); assert.ok(p.score >= 0 && p.score <= 5); }
  }
});
