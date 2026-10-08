'use strict';
const WIDTH = 960, HEIGHT = 720, CELL = 2, COLS = WIDTH / CELL, ROWS = HEIGHT / CELL;
const COLORS = ['#ff32cb', '#00e5df', '#bfc5ce', '#63f522', '#ffab19', '#ff4141', '#9886ff', '#fff06b'];
const BOT_NAMES = ['Pinkney', 'Bluebell', 'Greydon', 'Greenlee', 'Willem', 'Fred', 'Violet', 'Sunny'];
const STEP = 1 / 60;
// Names and documented durations: archived Curve Fever 2 FAQ (2018 capture).
// Multipliers, unspecified durations and spawn balance are our own tuning.
const POWERUPS = [
  { kind: 'speedSelf', name: 'Speed Up — You', scope: 'self', icon: 'lightning', duration: 3, description: 'Your curve moves faster.' },
  { kind: 'speedOthers', name: 'Speed Up — Rivals', scope: 'others', icon: 'lightning', duration: 3, description: 'Living rivals speed up and have a wider turning radius.' },
  { kind: 'slowSelf', name: 'Slow Down — You', scope: 'self', icon: 'turtle', duration: 10, description: 'Move slower with a tighter turning radius.' },
  { kind: 'slowOthers', name: 'Slow Down — Rivals', scope: 'others', icon: 'turtle', duration: 5, description: 'Living rivals slow down.' },
  { kind: 'reverse', name: 'Reverse — Rivals', scope: 'others', icon: 'reverse', duration: 5, description: 'Living rivals left/right controls are reversed.' },
  { kind: 'wrapAll', name: 'Traverse Walls — Everyone', scope: 'all', icon: 'W', duration: 10, description: 'Everyone can cross an edge and reappear at the opposite edge. Trails still collide.' }
];
const EFFECT_LABELS = { speedSelf: 'Speed Up', speedOthers: 'Speed Up', slowSelf: 'Slow Down', slowOthers: 'Slow Down', reverse: 'Reverse', wrapAll: 'Traverse Walls' };
const DROP_RULES = Object.freeze({ minDelay: 12, maxDelay: 18, maxItems: 1, lifetime: 12 });
function randomStarts(count, speed, random) {
  const starts = [], margin = 110, clearance = 115, runway = 0.65;
  function safe(s) {
    if (starts.some(p => Math.hypot(s.x-p.x,s.y-p.y) < clearance)) return false;
    for (let t = 0; t <= runway; t += 0.05) {
      const x = s.x+Math.cos(s.angle)*speed*t, y = s.y+Math.sin(s.angle)*speed*t;
      if (x < 24 || y < 24 || x > WIDTH-24 || y > HEIGHT-24) return false;
      for (const p of starts) for (let u=0;u<=runway;u+=0.05) {
        if (Math.hypot(x-p.x-Math.cos(p.angle)*speed*u,y-p.y-Math.sin(p.angle)*speed*u)<18) return false;
      }
    }
    return true;
  }
  for (let i = 0; i < count; i++) {
    let chosen = null;
    for (let attempt = 0; attempt < 1200; attempt++) {
      const s = { x: margin+random()*(WIDTH-margin*2), y: margin+random()*(HEIGHT-margin*2), angle: random()*Math.PI*2 };
      if (safe(s)) { chosen = s; break; }
    }
    if (!chosen) {
      // Bounded fallback, including deliberately degenerate test RNGs.
      const candidates = [];
      for (const y of [120,360,600]) for (const x of [150,480,810]) for (let a=0;a<24;a++) {
        const s={x,y,angle:(a*Math.PI/12+random()*0.1)%(Math.PI*2)};
        if (safe(s)) candidates.push(s);
      }
      candidates.sort((a,b) => Math.min(...starts.map(p=>Math.hypot(b.x-p.x,b.y-p.y)),10000)-Math.min(...starts.map(p=>Math.hypot(a.x-p.x,a.y-p.y)),10000));
      chosen = candidates[0];
      if (!chosen) throw new Error('Unable to find a safe player spawn');
    }
    starts.push(chosen);
  }
  return starts;
}
class Arena {
  constructor(players, options = {}, random = Math.random) {
    this.random = random; this.speed = options.speed || 115; this.difficulty = options.difficulty || 'normal';
    this.time = 0; this.tick = 0; this.done = false; this.winner = null; this.reason = '';
    this.cells = new Uint16Array(COLS * ROWS); this.stamps = new Uint32Array(COLS * ROWS);
    this.segments = []; this.pending = []; this.items = []; this.events = []; this.itemSerial = 0;
    this.powerupsEnabled = options.powerups !== false; this.nextItemAt = Infinity;
    this.wallInset = 0; this.trailVersion = 0; this.maxTrailRadius = 2.5;
    const starts = randomStarts(players.length, this.speed, random);
    this.players = players.map((p, i) => ({ ...p, ...starts[i], slot: i + 1,
      alive: true, steer: 0, gap: false, gapAt: 1.5 + random() * 2, gapUntil: 0,
      botDecisionAt: 0, lastInput: 0, effects: {}, snapHeld: 0, teleportAt: -10 }));
    for (const p of this.players) this.mark(p.x, p.y, p.slot);
    if (this.powerupsEnabled) this.nextItemAt = this.dropDelay();
  }
  dropDelay() { return DROP_RULES.minDelay + this.random()*(DROP_RULES.maxDelay-DROP_RULES.minDelay); }
  has(p, effect) { return (p.effects[effect] || 0) > this.time; }
  wraps(p) { return this.has(p, 'wrapAll'); }
  width() { return 5; }
  speedFor(p) {
    const fast = this.has(p,'speedSelf') || this.has(p,'speedOthers');
    const slow = this.has(p,'slowSelf') || this.has(p,'slowOthers');
    return this.speed * (fast ? 1.8 : 1) * (slow ? 0.55 : 1);
  }
  turnRate(p) { return 2.55 * (this.has(p,'speedOthers') ? 0.7 : 1); }
  effectiveTurn(p, raw) { return raw * (this.has(p,'reverse') ? -1 : 1); }
  project(x, y, p) {
    if (!this.wraps(p)) return { x, y, jumped: false };
    const xx = ((x%WIDTH)+WIDTH)%WIDTH, yy = ((y%HEIGHT)+HEIGHT)%HEIGHT;
    return { x: xx, y: yy, jumped: Math.abs(xx-x)>WIDTH/2 || Math.abs(yy-y)>HEIGHT/2 };
  }
  mark(x, y, owner, width = 5) {
    const radius = width/2, r = Math.ceil(radius/CELL), cx = Math.floor(x/CELL), cy = Math.floor(y/CELL);
    this.maxTrailRadius = Math.max(this.maxTrailRadius, radius);
    for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++) {
      const xx=cx+dx, yy=cy+dy;
      if (xx<0 || yy<0 || xx>=COLS || yy>=ROWS) continue;
      const ox=xx*CELL+1-x, oy=yy*CELL+1-y;
      if (ox*ox+oy*oy>(radius+0.7)*(radius+0.7)) continue;
      const n=yy*COLS+xx;
      if (!this.cells[n] || (this.cells[n]===owner && this.tick-this.stamps[n]<=30)) { this.cells[n]=owner; this.stamps[n]=this.tick; }
    }
  }
  blocked(x, y, p, future = false) {
    const radius=2.5, wraps=this.wraps(p);
    if (!wraps && (x<=radius+1 || y<=radius+1 || x>=WIDTH-radius-1 || y>=HEIGHT-radius-1)) return true;
    const point=this.project(x,y,p), cx=Math.floor(point.x/CELL), cy=Math.floor(point.y/CELL), r=2;
    const grace=Math.max(future?14:8,Math.ceil((radius+this.maxTrailRadius+3)/(this.speedFor(p)*STEP)));
    for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++) {
      const xx=cx+dx, yy=cy+dy;
      if (xx<0 || yy<0 || xx>=COLS || yy>=ROWS) continue;
      const n=yy*COLS+xx, owner=this.cells[n];
      // Most look-ahead cells are empty or a fresh own trail: skip geometry work.
      if (!owner || owner===p.slot && this.tick-this.stamps[n]<=grace) continue;
      const ox=xx*CELL+1-point.x, oy=yy*CELL+1-point.y;
      if (ox*ox+oy*oy<=(radius+0.7)*(radius+0.7)) return true;
    }
    return false;
  }
  applyPowerup(kind, collector) {
    const spec=POWERUPS.find(p=>p.kind===kind);
    if (!spec || !collector?.alive) return false;
    const active=this.players.filter(p=>p.alive), targets=spec.scope==='self'?[collector]:spec.scope==='others'?active.filter(p=>p.id!==collector.id):active;
    for (const p of targets) p.effects[kind]=this.time+spec.duration;
    this.events.push({ id: ++this.itemSerial, text: collector.name+' collected '+spec.name, scope: spec.scope, playerId: collector.id });
    return true;
  }
  spawnItem() {
    if (!this.powerupsEnabled || this.items.length>=DROP_RULES.maxItems) return false;
    const b={left:24,right:WIDTH-24,top:24,bottom:HEIGHT-24};
    for (let attempt=0;attempt<80;attempt++) {
      const x=b.left+this.random()*(b.right-b.left), y=b.top+this.random()*(b.bottom-b.top);
      if (this.players.some(p=>p.alive && Math.hypot(x-p.x,y-p.y)<45) || this.items.some(p=>Math.hypot(x-p.x,y-p.y)<40)) continue;
      let occupied=false;
      for (let dy=-14;dy<=14;dy+=2) for (let dx=-14;dx<=14;dx+=2) if (this.cells[Math.floor((y+dy)/CELL)*COLS+Math.floor((x+dx)/CELL)]) occupied=true;
      if (occupied) continue;
      const spec=POWERUPS[Math.floor(this.random()*POWERUPS.length)];
      this.items.push({id:'i'+(++this.itemSerial),kind:spec.kind,x:+x.toFixed(2),y:+y.toFixed(2),expiresAt:this.time+DROP_RULES.lifetime}); return true;
    }
    return false;
  }
  collectItems() {
    for (const item of [...this.items]) {
      // Resolve ties by geometric proximity, not player iteration order.
      const contenders=this.players.filter(p=>p.alive && Math.hypot(p.x-item.x,p.y-item.y)<=13+this.width(p)/2);
      contenders.sort((a,b)=>Math.hypot(a.x-item.x,a.y-item.y)-Math.hypot(b.x-item.x,b.y-item.y));
      if (contenders.length) { this.items=this.items.filter(p=>p.id!==item.id); this.applyPowerup(item.kind,contenders[0]); }
    }
  }
  botSteer(p) {
    if (this.time < p.botDecisionAt) return p.steer;
    const cfg = { easy: [0.22, 0.55, 0.12], normal: [0.10, 0.85, 0.035], hard: [0.06, 1.15, 0] }[this.difficulty];
    p.botDecisionAt = this.time + cfg[0];
    if (this.random() < cfg[2]) return [-1, 0, 1][Math.floor(this.random() * 3)];
    let best = -Infinity, decision = 0;
    const speed=this.speedFor(p), rate=this.turnRate(p), reverse=this.has(p,'reverse')?-1:1;
    for (const turn of [0, -1, 1]) {
      let x = p.x, y = p.y, angle = p.angle, safe = 0;
      for (let t = 0; t < cfg[1]; t += 0.04) {
        angle += turn*reverse*rate*0.04;
        x+=Math.cos(angle)*speed*0.04; y+=Math.sin(angle)*speed*0.04;
        const projected=this.project(x,y,p); x=projected.x; y=projected.y;
        if (this.blocked(x, y, p, true)) break;
        safe += 0.04;
      }
      const edge = Math.min(x, WIDTH - x, y, HEIGHT - y);
      const score = safe * 100 + Math.min(edge, 80) * 0.015 - Math.abs(turn) * 0.5 + (turn === p.steer ? 0.15 : 0);
      if (score > best) { best = score; decision = turn; }
    }
    return decision;
  }
  input(id, steer) { const p = this.players.find(p => p.id === id); if (p && !p.bot) { p.steer = steer; p.lastInput = this.time; } }
  step(disconnected = new Set()) {
    if (this.done) return;
    this.time += STEP; this.tick++;
    if (this.items.length) this.items=this.items.filter(p=>p.expiresAt>this.time);
    if (this.powerupsEnabled && this.time>=this.nextItemAt) { this.spawnItem(); this.nextItemAt=this.time+this.dropDelay(); }
    const active = this.players.filter(p => p.alive), moves = [], fallen = new Set();
    const samples=Math.max(1,Math.ceil(Math.max(...active.map(p=>this.speedFor(p)),1)*STEP/1.5));
    for (const p of active) {
      if (disconnected.has(p.id)) { fallen.add(p.id); continue; }
      if (p.bot) p.steer = this.botSteer(p);
      else if (this.time - p.lastInput > 0.6) p.steer = 0;
      p.angle+=this.effectiveTurn(p,p.steer)*this.turnRate(p)*STEP;
      if (p.gap && this.time >= p.gapUntil) { p.gap = false; p.gapAt = this.time + 1.6+this.random()*2.5; }
      if (!p.gap && this.time >= p.gapAt) { p.gap = true; p.gapUntil = this.time + 0.29; }
      const path=[], distance=this.speedFor(p)*STEP/samples;
      let x=p.x,y=p.y,jumped=false;
      for (let sample=0;sample<samples;sample++) {
        const next=this.project(x+Math.cos(p.angle)*distance,y+Math.sin(p.angle)*distance,p);
        x=next.x; y=next.y; jumped ||= next.jumped;
        path.push({x,y,jumped:next.jumped});
        if (this.blocked(x,y,p)) fallen.add(p.id);
      }
      moves.push({p,x,y,path,jumped});
    }
    // Check swept heads symmetrically; faster powerups cannot tunnel through a trail.
    for (let i=0;i<moves.length;i++) for (let j=i+1;j<moves.length;j++) {
      for (let s=0;s<samples;s++) {
        if (Math.hypot(moves[i].path[s].x-moves[j].path[s].x,moves[i].path[s].y-moves[j].path[s].y)<(this.width(moves[i].p)+this.width(moves[j].p))/2+1) {
          fallen.add(moves[i].p.id); fallen.add(moves[j].p.id); break;
        }
      }
    }
    for (const m of moves) {
      if (!m.p.gap) {
        const width=this.width(m.p);
        if (!m.jumped) {
          const seg=[m.p.id,+m.p.x.toFixed(2),+m.p.y.toFixed(2),+m.x.toFixed(2),+m.y.toFixed(2),width];
          this.segments.push(seg); this.pending.push(seg);
        } else {
          // Never draw a line across the map when traversing a wall.
          let x=m.p.x,y=m.p.y;
          for (const point of m.path) {
            if (!point.jumped) { const seg=[m.p.id,+x.toFixed(2),+y.toFixed(2),+point.x.toFixed(2),+point.y.toFixed(2),width]; this.segments.push(seg); this.pending.push(seg); }
            x=point.x; y=point.y;
          }
        }
        for (const point of m.path) this.mark(point.x,point.y,m.p.slot,width);
      }
      m.p.x=m.x; m.p.y=m.y; if (m.jumped) m.p.teleportAt=this.time;
    }
    for (const p of active) {
      if (fallen.has(p.id)) p.alive = false;
      else p.score += fallen.size;
    }
    this.collectItems();
    const alive = this.players.filter(p => p.alive);
    if (alive.length <= 1 || this.time >= 90) {
      this.done = true; this.winner = alive.length === 1 ? alive[0].id : null;
      this.reason = this.time >= 90 ? 'Time limit reached' : this.winner ? 'Last curve standing' : 'Simultaneous collision';
    }
  }
  heads() { return this.players.map(p => ({ id: p.id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), angle: +p.angle.toFixed(3), alive: p.alive, gap: p.gap, score: p.score,
    radius: 2.5, teleport: this.time-p.teleportAt<0.075,
    effects: Object.entries(p.effects).filter(([,end])=>end>this.time).map(([kind,end])=>({kind,name:EFFECT_LABELS[kind]||kind,remaining:+(end-this.time).toFixed(2)})) })); }
  view() { return { heads:this.heads(), items:this.items.map(({id,kind,x,y})=>({id,kind,x,y})), wallInset:0, trailVersion:this.trailVersion }; }
  snapshot() { return { ...this.view(), segments:this.segments, rebuild:true }; }
  frame() {
    const segments=this.pending; this.pending=[]; const events=this.events; this.events=[];
    return { ...this.view(), segments, rebuild:false, events };
  }
  drain() { const p = this.pending; this.pending = []; return p; }
}
function matchWinner(players, target) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  return sorted[0] && sorted[0].score >= target && sorted[0].score - (sorted[1]?.score || 0) >= 2 ? sorted[0] : null;
}
module.exports = { Arena, matchWinner, randomStarts, POWERUPS, DROP_RULES, WIDTH, HEIGHT, STEP, COLORS, BOT_NAMES };
