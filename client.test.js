'use strict';
// Browser-logic smoke tests with a small DOM stub; not a browser rendering test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup(protocol = 'http:') {
  const html = fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context2d = new Proxy({}, {get:(o,k) => o[k] || (()=>{})});
  class Element {
    constructor(tag='DIV') { this.tagName=tag; this.listeners={}; this.children=[]; this.style={setProperty(){}}; this.classList={toggle(){}};this.value='';this.checked=false; }
    addEventListener(k,fn){this.listeners[k]=fn;}
    append(...v){this.children.push(...v);} replaceChildren(...v){this.children=v;}
    setAttribute(){} getContext(){return context2d;} setPointerCapture(){} blur(){}
    querySelectorAll(){return ['slots','difficulty','target','speed','fillBots','powerups'].map(id=>els.get(id));}
  }
  const els = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
  for (const [k,v] of Object.entries({playerName:'Alice',slots:'6',difficulty:'normal',target:'10',speed:'115'})) els.get(k).value=v;
  els.get('fillBots').checked=true;
  const listeners={};
  class FakeWS {
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=0;this.listeners={};this.sent=[];FakeWS.last=this;}
    addEventListener(k,fn){this.listeners[k]=fn;}
    emit(k,value){if(k==='open')this.readyState=1;this.listeners[k]?.(value);}
    send(s){this.sent.push(JSON.parse(s));}
    close(){this.readyState=3;this.emit('close',{});}
  }
  const sandbox={console,performance,location:{protocol,host:'192.168.1.8:3000',origin:'http://192.168.1.8:3000',hostname:'192.168.1.8'},
    document:{getElementById:id=>els.get(id),createElement:tag=>new Element(tag.toUpperCase()),addEventListener(k,fn){listeners[k]=fn;}},
    window:{addEventListener(k,fn){listeners[k]=fn;}},navigator:{},matchMedia:()=>({matches:false}),WebSocket:FakeWS,
    requestAnimationFrame(){},setInterval(){},setTimeout(){},clearTimeout(){}};
  const context=vm.createContext(sandbox);vm.runInContext(code,context);
  return {els,listeners,context,FakeWS,context2d};
}
test('client loads, joins, renders state and sends steering without getting stuck',()=>{
  const {els,listeners,context,FakeWS}=setup();
  vm.runInContext('connect(false)',context);const ws=FakeWS.last;ws.emit('open',{});
  assert.equal(ws.sent[0].type,'join');assert.equal(ws.sent[0].name,'Alice');
  const message=m=>ws.emit('message',{data:JSON.stringify(m)});
  message({type:'welcome',id:'p1',token:'secret'});
  const players=[{id:'p1',name:'Alice',color:'#ff32cb',bot:false,ready:false,connected:true,score:0},{id:'p2',name:'Bluebell',color:'#00e5df',bot:true,ready:true,connected:true,score:0}];
  message({type:'room',phase:'lobby',hostId:'p1',settings:{slots:2,fillBots:true,difficulty:'normal',target:10,speed:115},players,round:0,remaining:0});
  assert.equal(els.get('joinPanel').hidden,true);assert.equal(els.get('slots').disabled,false);assert.equal(els.get('players').children.length,2);
  els.get('readyButton').listeners.click();assert.equal(ws.sent.at(-1).ready,true);
  const heads=players.map((p,i)=>({id:p.id,x:100+i*200,y:100,angle:0,alive:true,score:0}));
  message({type:'reset',players,heads});message({type:'state',phase:'playing',heads,segments:[['p1',100,100,102,100]],remaining:0});
  vm.runInContext('draw(performance.now())',context);
  assert.equal(els.get('overlay').hidden,true);assert.equal(els.get('left').disabled,false);
  listeners.keydown({key:'ArrowLeft',target:{tagName:'BODY'},preventDefault(){}});assert.equal(ws.sent.at(-1).steer,-1);
  listeners.blur();assert.equal(ws.sent.at(-1).steer,0);
  listeners.keydown({key:'a',target:{tagName:'INPUT'},preventDefault(){throw new Error('Should not intercept typing');}});
  message({type:'state',phase:'playing',heads:heads.map(h=>({...h,alive:false,score:1})),segments:[],remaining:0});
  assert.equal(els.get('left').disabled,true);
});
test('client shows exactly six cached icons, timers and rare-drop guidance without per-frame DOM churn',()=>{
  const {els,context,FakeWS,context2d}=setup();vm.runInContext('connect(false)',context);const ws=FakeWS.last;ws.emit('open',{});
  const message=m=>ws.emit('message',{data:JSON.stringify(m)}), {POWERUPS}=require('./game');
  message({type:'welcome',id:'p1',powerCatalog:POWERUPS});assert.equal(els.get('powerGuide').children.length,6);assert.equal(vm.runInContext('iconCache.size',context),6);
  const players=[{id:'p1',name:'Alice',color:'#ff32cb',connected:true,ready:true,score:0}];
  message({type:'room',phase:'playing',hostId:'p1',settings:{slots:2,fillBots:true,powerups:true,target:10,speed:115,difficulty:'normal'},players,round:1,remaining:0});
  const heads=[{id:'p1',x:200,y:200,angle:0,alive:true,score:0,radius:2.5,effects:[{kind:'speedSelf',name:'Speed Up',remaining:2.5}]}];
  message({type:'reset',players,heads,items:[],trailVersion:0});
  let clears=0;context2d.fillRect=()=>clears++;
  message({type:'state',phase:'playing',heads,items:[{id:'i1',kind:'wrapAll',x:400,y:400}],rebuild:false,trailVersion:0,segments:[['p1',200,200,203,200,5]],events:[{text:'Alice collected Speed Up'}],remaining:0});
  assert.equal(clears,0);assert.equal(els.get('effectChips').children[0].textContent,'Speed Up 3s');assert.equal(els.get('powerEvent').textContent,'Alice collected Speed Up');assert.match(els.get('powerReadout').textContent,/Rare drops/);
  let writes=0;const left=els.get('left'),disabled=left.disabled;Object.defineProperty(left,'disabled',{get:()=>disabled,set:()=>writes++});
  for(let i=0;i<20;i++)vm.runInContext('draw(performance.now())',context);assert.equal(writes,0);assert.equal(els.get('powerups').disabled,true);
  message({type:'room',phase:'lobby',hostId:'p1',settings:{slots:2,fillBots:true,powerups:true,target:10,speed:115,difficulty:'normal'},players,round:0,remaining:0});
  assert.equal(els.get('powerups').disabled,false);els.get('powerups').checked=false;els.get('settings').listeners.change();assert.equal(ws.sent.at(-1).powerups,false);
  message({type:'state',phase:'playing',heads:heads.map(h=>({...h,effects:[]})),items:[],segments:[],remaining:0});assert.equal(els.get('effectChips').children.length,0);
});
test('opening the client as a file gives startup guidance instead of trying a connection',()=>{
  const {els,context,FakeWS}=setup('file:');vm.runInContext('connect(false)',context);
  assert.match(els.get('joinError').textContent,/npm start/);assert.equal(FakeWS.last,undefined);
});
