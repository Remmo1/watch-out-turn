'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Arena, POWERUPS, randomStarts, WIDTH, HEIGHT, STEP } = require('./game');
const rng = seed => () => ((seed=(seed*1664525+1013904223)>>>0)/4294967296);
function fixture(options={}) {
  const a=new Arena(Array.from({length:3},(_,i)=>({id:'p'+i,name:'Player '+i,score:0,bot:false})),{powerups:false,...options},rng(77));
  a.cells.fill(0); a.stamps.fill(0);
  a.players.forEach((p,i)=>{p.x=200+i*220;p.y=200+i*120;p.angle=0;p.gapAt=100;p.gapUntil=0;});
  return a;
}
test('500 seeded random starts have clearance, varied headings and a safe opening runway',()=>{
  const quadrants=new Set();
  for(let seed=1;seed<=500;seed++) {
    const a=new Arena(Array.from({length:8},(_,i)=>({id:'p'+i,score:0,bot:false})),{speed:145,powerups:false},rng(seed));
    for(const p of a.players) {assert.ok(p.x>=110 && p.x<=WIDTH-110 && p.y>=110 && p.y<=HEIGHT-110);quadrants.add(Math.floor(p.angle/(Math.PI/2)));}
    for(let i=0;i<8;i++)for(let j=i+1;j<8;j++)assert.ok(Math.hypot(a.players[i].x-a.players[j].x,a.players[i].y-a.players[j].y)>=115);
    for(let t=0;t<30;t++)a.step();
    assert.ok(a.players.every(p=>p.alive),'Immediate collision for seed '+seed);
  }
  assert.equal(quadrants.size,4);
  assert.notDeepEqual(randomStarts(8,115,rng(1)),randomStarts(8,115,rng(2)));
});
test('bounded spawn fallback handles a constant RNG',()=>{
  const starts=randomStarts(8,145,()=>0.5);assert.equal(starts.length,8);
  for(let i=0;i<8;i++)for(let j=i+1;j<8;j++)assert.ok(Math.hypot(starts[i].x-starts[j].x,starts[i].y-starts[j].y)>=115);
});
test('catalog contains exactly the six requested kinds and rejects all removed items',()=>{
  const expected=['speedSelf','speedOthers','slowSelf','slowOthers','reverse','wrapAll'];
  assert.deepEqual(POWERUPS.map(p=>p.kind),expected);
  assert.deepEqual(POWERUPS.map(p=>p.icon),['lightning','lightning','turtle','turtle','reverse','W']);
  for(const spec of POWERUPS) {const a=fixture();assert.equal(a.applyPowerup(spec.kind,a.players[0]),true);assert.equal(a.events.length,1);assert.ok(a.players.every(p=>p.score===0));}
  for(const kind of ['thin','thick','ghost','wrapSelf','snakey','eraser','eraserSelf','switch','frenzy','sharp','cheese','closing','nonexistent']) {
    const a=fixture();assert.equal(a.applyPowerup(kind,a.players[0]),false);assert.equal(a.events.length,0);assert.ok(a.players.every(p=>Object.keys(p.effects).length===0));
  }
});
for(const spec of POWERUPS) {
  test(spec.name+' targets '+spec.scope+' and expires correctly',()=>{
    const a=fixture(),[p,q,r]=a.players;a.applyPowerup(spec.kind,p);
    for(const target of [p,q,r]) {
      const expected=spec.scope==='self'?target===p:spec.scope==='others'?target!==p:true;
      assert.equal(a.has(target,spec.kind),expected);
      if(expected)assert.equal(target.effects[spec.kind],spec.duration);
    }
    a.time=spec.duration+STEP;assert.ok([p,q,r].every(p=>!a.has(p,spec.kind)));
  });
}
test('speed modifiers expire without permanent changes to speed or trail width',()=>{
  const a=fixture(),[p,q]=a.players;a.applyPowerup('speedSelf',p);assert.equal(a.speedFor(p),115*1.8);
  a.applyPowerup('slowSelf',p);assert.equal(a.speedFor(p),115*1.8*.55);assert.equal(a.width(p),5);
  a.applyPowerup('speedOthers',p);assert.equal(a.turnRate(q),2.55*.7);
  a.time=20;assert.equal(a.speedFor(p),115);assert.equal(a.turnRate(q),2.55);
});
test('Reverse steering is enforced by the server',()=>{
  const a=fixture(),p=a.players[1];a.applyPowerup('reverse',a.players[0]);a.input(p.id,1);a.step();assert.ok(p.angle<0);
});
test('Traverse Walls affects everyone and never draws a line across the map',()=>{
  const a=fixture(),p=a.players[0];a.applyPowerup('wrapAll',p);assert.ok(a.players.every(p=>a.wraps(p)));
  p.x=WIDTH-.5;p.angle=0;a.step();assert.ok(p.alive && p.x<4);assert.equal(a.heads()[0].teleport,true);
  assert.ok(a.segments.every(s=>Math.hypot(s[3]-s[1],s[4]-s[2])<10));
  a.time=10.1;assert.ok(a.players.every(p=>!a.wraps(p)));
});
test('wall traversal does not grant trail or disconnect immunity',()=>{
  const a=fixture(),p=a.players[0];a.applyPowerup('wrapAll',p);a.mark(201,200,2);assert.equal(a.blocked(201,200,p),true);
  a.step(new Set([p.id]));assert.equal(p.alive,false);
});
test('recollecting a timed effect refreshes duration without exponential stacking',()=>{
  const a=fixture(),p=a.players[0];a.applyPowerup('speedSelf',p);a.time=1;a.applyPowerup('speedSelf',p);
  assert.equal(p.effects.speedSelf,4);assert.equal(a.speedFor(p),115*1.8);
});
test('eliminated rivals do not receive effects and dead players cannot collect',()=>{
  const a=fixture(),[p,q]=a.players;q.alive=false;a.applyPowerup('speedOthers',p);assert.equal(a.has(q,'speedOthers'),false);assert.equal(a.applyPowerup('speedSelf',q),false);
});
test('items appear in clear space, collect automatically, and expire after 12 seconds',()=>{
  const a=fixture({powerups:true});assert.equal(a.spawnItem(),true);const item=a.items[0];assert.equal(item.expiresAt,12);
  assert.ok(a.players.every(p=>Math.hypot(p.x-item.x,p.y-item.y)>=45));
  const p=a.players[0];p.x=item.x;p.y=item.y;const deadline=a.nextItemAt;a.collectItems();assert.equal(a.items.length,0);assert.equal(a.events.length,1);assert.equal(a.nextItemAt,deadline);
  a.items=[{id:'expired',kind:'speedSelf',x:400,y:400,expiresAt:0}];a.step();assert.equal(a.items.length,0);
});
test('at most one token exists and disabled rounds have no drops',()=>{
  const off=fixture();assert.equal(off.spawnItem(),false);assert.equal(off.nextItemAt,Infinity);
  const a=fixture({powerups:true});for(let i=0;i<20;i++)a.spawnItem();assert.equal(a.items.length,1);
  a.applyPowerup('speedSelf',a.players[0]);const snap=a.snapshot();assert.equal(snap.items.length,1);assert.equal(snap.heads[0].effects[0].name,'Speed Up');assert.equal(snap.rebuild,true);
  a.step();assert.equal(a.frame().rebuild,false);
});
test('first drop and every later attempt are spaced 12 to 18 seconds apart',()=>{
  for(let seed=1;seed<=20;seed++) {
    const a=fixture({powerups:true});a.random=rng(seed);let deadline=a.nextItemAt;
    assert.ok(deadline>=12 && deadline<=18);
    a.time=deadline-2*STEP;a.step();assert.equal(a.items.length,0);
    a.time=deadline+STEP;a.step();assert.equal(a.items.length,1);
    for(let i=0;i<4;i++) {
      const gap=a.nextItemAt-a.time;assert.ok(gap>=12 && gap<=18);
      deadline=a.nextItemAt;a.time=deadline+STEP;a.step();assert.ok(a.items.length<=1);
    }
  }
});
test('repeated pickups cannot accelerate the spawn schedule',()=>{
  const a=fixture({powerups:true}),deadline=a.nextItemAt;
  for(const spec of POWERUPS)a.applyPowerup(spec.kind,a.players[0]);assert.equal(a.nextItemAt,deadline);
});
test('fast movement cannot tunnel through a narrow trail',()=>{
  const a=fixture({speed:145}),p=a.players[0];a.applyPowerup('speedSelf',p);p.x=200;p.y=200;p.angle=0;a.mark(203,200,2,2);a.step();assert.equal(p.alive,false);
});
