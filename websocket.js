'use strict';
// Small, dependency-free RFC 6455 server transport. Trusted-LAN scope only.
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const decoder = new TextDecoder('utf-8', { fatal: true });
class Peer extends EventEmitter {
  constructor(socket, head) {
    super(); this.socket = socket; this.buffer = Buffer.alloc(0); this.fragments = [];
    this.fragmentLength = 0; this.fragmentOpcode = 0; this.closed = false; this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', data => this.read(data));
    socket.on('error', () => this.finish());
    socket.on('close', () => this.finish());
    this.initialHead = head;
  }
  start() { if (this.initialHead?.length) this.read(this.initialHead); this.initialHead = null; }
  finish() { if (this.closed) return; this.closed = true; this.emit('close'); }
  frame(opcode, payload = Buffer.alloc(0)) {
    if (this.closed || this.socket.destroyed) return;
    payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let header;
    if (payload.length < 126) { header = Buffer.alloc(2); header[1] = payload.length; }
    else if (payload.length <= 65535) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    header[0] = 0x80 | opcode;
    if (this.socket.writableLength > 2 * 1024 * 1024) { this.socket.destroy(); return; }
    this.socket.write(Buffer.concat([header, payload]));
  }
  send(value) { this.frame(1, JSON.stringify(value)); }
  ping() { this.frame(9); }
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code); this.frame(8, Buffer.concat([p, Buffer.from(reason).subarray(0, 120)]));
    this.socket.end(); const timer = setTimeout(() => this.socket.destroy(), 1000); timer.unref();
  }
  fail(code = 1002) { this.close(code); this.buffer = Buffer.alloc(0); }
  read(data) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 2) {
      const a = this.buffer[0], b = this.buffer[1], fin = !!(a & 128), op = a & 15;
      if ((a & 112) || !(b & 128) || ![0, 1, 2, 8, 9, 10].includes(op)) return this.fail();
      let n = b & 127, offset = 2;
      if (n === 126) { if (this.buffer.length < 4) return; n = this.buffer.readUInt16BE(2); offset = 4; if (n < 126) return this.fail(); }
      else if (n === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2); if (big > 4096n) return this.fail(1009);
        n = Number(big); offset = 10; if (n < 65536) return this.fail();
      }
      if (op >= 8 && (!fin || n > 125)) return this.fail();
      if (n > 4096 || this.fragmentLength + n > 4096) return this.fail(1009);
      if (this.buffer.length < offset + 4 + n) return;
      const mask = this.buffer.subarray(offset, offset + 4), payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + n));
      this.buffer = this.buffer.subarray(offset + 4 + n);
      for (let i = 0; i < n; i++) payload[i] ^= mask[i & 3];
      if (op === 8) {
        if (n === 1) return this.fail();
        if (n >= 2) {
          const code = payload.readUInt16BE();
          if (!((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999))) return this.fail();
          try { decoder.decode(payload.subarray(2)); } catch { return this.fail(1007); }
        }
        this.frame(8, payload); this.socket.end(); return;
      }
      if (op === 9) { this.frame(10, payload); continue; }
      if (op === 10) { this.alive = true; continue; }
      if (op === 2) return this.fail(1003);
      if (op === 0) {
        if (!this.fragmentOpcode) return this.fail();
        this.fragments.push(payload); this.fragmentLength += n;
      } else {
        if (this.fragmentOpcode) return this.fail();
        this.fragments = [payload]; this.fragmentLength = n; this.fragmentOpcode = op;
      }
      if (fin) {
        const whole = Buffer.concat(this.fragments); this.fragments = []; this.fragmentLength = 0; this.fragmentOpcode = 0;
        try { const text = decoder.decode(whole); this.emit('message', text); } catch { return this.fail(1007); }
      }
    }
  }
}
function upgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      !req.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade') ||
      req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' ||
      !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return null;
  }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  return new Peer(socket, head);
}
module.exports = { upgrade };
