'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { createGameServer } = require('./server');
class Client extends EventEmitter {
  constructor(socket) { super(); this.socket = socket; this.buffer = Buffer.alloc(0); this.ready = false; this.history = []; socket.on('error',()=>{}); socket.on('data',b=>this.read(b)); }
  read(b) {
    this.buffer = Buffer.concat([this.buffer,b]);
    if (!this.ready) {
      const i = this.buffer.indexOf('\r\n\r\n'); if (i < 0) return;
      this.handshake = this.buffer.subarray(0,i).toString(); this.buffer = this.buffer.subarray(i+4); this.ready = true; this.emit('ready');
    }
    while (this.buffer.length >= 2) {
      const op = this.buffer[0]&15; let n = this.buffer[1]&127, o = 2;
      if (n===126) { if (this.buffer.length<4) return; n=this.buffer.readUInt16BE(2); o=4; }
      if (n===127) { if (this.buffer.length<10) return; n=Number(this.buffer.readBigUInt64BE(2)); o=10; }
      if (this.buffer.length<o+n) return; const payload=this.buffer.subarray(o,o+n); this.buffer=this.buffer.subarray(o+n);
      if (op===1) { const m=JSON.parse(payload.toString()); this.history.push(m); this.emit('message',m); }
      if (op===9) this.write(10,payload);
      if (op===8) { this.write(8,payload); this.socket.end(); }
    }
  }
  write(op,payload,fin=true) {
    payload=Buffer.isBuffer(payload)?payload:Buffer.from(payload); const mask=randomBytes(4); const h=Buffer.alloc(payload.length<126?2:4);
    h[0]=(fin?128:0)|op; if(payload.length<126)h[1]=128|payload.length;else{h[1]=128|126;h.writeUInt16BE(payload.length,2);}
    const data=Buffer.from(payload);for(let i=0;i<data.length;i++)data[i]^=mask[i&3];this.socket.write(Buffer.concat([h,mask,data]));
  }
  send(m) {this.write(1,JSON.stringify(m));}
  next(predicate,ms=2500) {
    const found=this.history.find(predicate);if(found)return Promise.resolve(found);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.off('message',fn);reject(new Error('Timed out waiting for message'));},ms);const fn=m=>{if(predicate(m)){clearTimeout(timer);this.off('message',fn);resolve(m);}};this.on('message',fn);});
  }
  clear(){this.history=[];}
  close(){this.socket.destroy();}
  static async connect(port,origin) {
    const socket=net.connect(port,'127.0.0.1');const c=new Client(socket);
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
    const ready=new Promise(resolve=>c.once('ready',resolve));
    socket.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nOrigin: '+(origin||'http://127.0.0.1:'+port)+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '+randomBytes(16).toString('base64')+'\r\n\r\n');
    await ready;return c;
  }
}
async function start(t) { const g=createGameServer(); await new Promise(r=>g.server.listen(0,'127.0.0.1',r));t.after(()=>g.close());return g.server.address().port; }
test('HTTP serves the game, not server source; cross-origin upgrades are rejected',async t=>{
  const port=await start(t);const response=await fetch('http://127.0.0.1:'+port+'/');assert.equal(response.status,200);assert.match(await response.text(),/WATCH OUT/);
  assert.equal((await fetch('http://127.0.0.1:'+port+'/server.js')).status,404);
  assert.equal((await fetch('http://127.0.0.1:'+port+'/health')).status,200);
  const c=await Client.connect(port,'http://other.example');assert.match(c.handshake,/403/);c.close();
});
test('LAN lobby, bot replacement, readiness, authorization, rounds and reconnection',async t=>{
  const port=await start(t);const a=await Client.connect(port);t.after(()=>a.close());
  a.send({type:'join',name:'Host'});const wa=await a.next(m=>m.type==='welcome');const first=await a.next(m=>m.type==='room');
  assert.equal(first.hostId,wa.id);assert.equal(first.players.length,6);assert.equal(first.players.filter(p=>p.bot).length,5);
  a.clear();a.send({type:'settings',slots:3});await a.next(m=>m.type==='room'&&m.players.length===3);
  const b=await Client.connect(port);t.after(()=>b.close());b.send({type:'join',name:'Guest'});const wb=await b.next(m=>m.type==='welcome');
  const joined=await b.next(m=>m.type==='room'&&m.players.some(p=>p.id===wb.id));assert.equal(joined.players.filter(p=>p.bot).length,1);
  assert.equal(new Set(joined.players.map(p=>p.color)).size,3);
  b.send({type:'settings',target:50});assert.match((await b.next(m=>m.type==='error')).message,/Only the host/);
  a.clear();a.send({type:'start'});assert.match((await a.next(m=>m.type==='error')).message,/ready/);
  a.send({type:'ready',ready:true});b.send({type:'ready',ready:true});await a.next(m=>m.type==='room'&&m.players.filter(p=>!p.bot).every(p=>p.ready));
  a.send({type:'start'});const reset=await a.next(m=>m.type==='reset');assert.equal(reset.players.length,3);assert.equal(reset.players.find(p=>p.bot).id,joined.players.find(p=>p.bot).id);
  await a.next(m=>m.type==='room'&&m.phase==='playing',4500);
  a.send({type:'input',steer:1});const frame=await a.next(m=>m.type==='state'&&m.segments.length>0);assert.ok(frame.heads.length===3);
  const s=await Client.connect(port);t.after(()=>s.close());s.send({type:'join',spectator:true});assert.equal((await s.next(m=>m.type==='welcome')).id,null);assert.ok((await s.next(m=>m.type==='sync')).segments.length>0);
  b.close();await a.next(m=>m.type==='room'&&m.players.some(p=>p.id===wb.id&&!p.connected));
  const resumed=await Client.connect(port);t.after(()=>resumed.close());resumed.send({type:'join',name:'Guest',token:wb.token});assert.equal((await resumed.next(m=>m.type==='welcome')).id,wb.id);
  const late=await Client.connect(port);t.after(()=>late.close());late.send({type:'join',name:'Late arrival'});const wl=await late.next(m=>m.type==='welcome');const sync=await late.next(m=>m.type==='sync');assert.ok(!sync.players.some(p=>p.id===wl.id));
});
test('WebSocket fragmentation, ping/pong and malformed-frame rejection',async t=>{
  const port=await start(t);const c=await Client.connect(port);t.after(()=>c.close());
  const json=JSON.stringify({type:'join',name:'Fragmented'});c.write(1,json.slice(0,10),false);c.write(9,'ping');c.write(0,json.slice(10),true);
  assert.ok((await c.next(m=>m.type==='welcome')).id);
  const bad=await Client.connect(port);t.after(()=>bad.close());
  const closed=new Promise(resolve=>bad.socket.once('close',resolve));bad.socket.write(Buffer.from([0x81,0x02,0x7b,0x7d]));await closed;
});
test('host owns power-up settings and LAN snapshots carry the new state',async t=>{
  const port=await start(t),a=await Client.connect(port),b=await Client.connect(port);t.after(()=>a.close());t.after(()=>b.close());
  a.send({type:'join',name:'Host'});const welcome=await a.next(m=>m.type==='welcome');assert.equal(welcome.powerCatalog.length,6);
  b.send({type:'join',name:'Guest'});await b.next(m=>m.type==='welcome');b.send({type:'settings',powerups:false});assert.match((await b.next(m=>m.type==='error')).message,/Only the host/);
  a.send({type:'settings',powerups:false});assert.equal((await a.next(m=>m.type==='room'&&m.settings.powerups===false)).settings.powerups,false);
  a.send({type:'ready',ready:true});b.send({type:'ready',ready:true});await a.next(m=>m.type==='room'&&m.players.filter(p=>!p.bot).every(p=>p.ready));
  a.send({type:'start'});const reset=await a.next(m=>m.type==='reset');assert.deepEqual(reset.items,[]);assert.equal(reset.wallInset,0);assert.equal(reset.trailVersion,0);assert.ok(reset.heads.every(p=>Array.isArray(p.effects)));
  const spectator=await Client.connect(port);t.after(()=>spectator.close());spectator.send({type:'join',spectator:true});
  const snapshot=await spectator.next(m=>m.type==='sync');assert.deepEqual(snapshot.items,[]);assert.equal(snapshot.rebuild,true);assert.equal(snapshot.wallInset,0);
  b.clear();b.send({type:'pickup',kind:'ghost'});assert.match((await b.next(m=>m.type==='error')).message,/Only the host/);
});
test('host role moves to another connected human',async t=>{
  const port=await start(t);const a=await Client.connect(port),b=await Client.connect(port);t.after(()=>a.close());t.after(()=>b.close());
  a.send({type:'join',name:'First'});await a.next(m=>m.type==='welcome');b.send({type:'join',name:'Second'});const wb=await b.next(m=>m.type==='welcome');a.close();
  assert.equal((await b.next(m=>m.type==='room'&&m.hostId===wb.id)).hostId,wb.id);
});
