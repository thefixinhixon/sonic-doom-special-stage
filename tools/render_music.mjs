// Render Sonic 2 music through the emulated sound hardware to a WAV file.
// usage: node tools/render_music.mjs <rom> <songId hex> <seconds> <out.wav>
import fs from 'node:fs';
import { SoundMachine } from '../src/audio/smps.js';

const [romPath, idHex = '92', secs = '10', out = 'out.wav'] = process.argv.slice(2);
const rate = 44100;
const rom = new Uint8Array(fs.readFileSync(romPath));
const m = new SoundMachine(rom, rate);
const total = Math.floor(+secs * rate);
const L = new Float32Array(total);
const R = new Float32Array(total);
const block = 512;
const t0 = Date.now();
// let the driver boot for a few frames, then request the song
const bl = new Float32Array(block), br = new Float32Array(block);
for (let i = 0; i < 10; i++) m.render(bl, br, block);
m.play(parseInt(idHex, 16));
for (let p = 0; p < total; p += block) {
  const n = Math.min(block, total - p);
  m.render(bl, br, n);
  L.set(bl.subarray(0, n), p);
  R.set(br.subarray(0, n), p);
}
const ms = Date.now() - t0;
let peak = 0, rms = 0;
for (let i = 0; i < total; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); rms += L[i] * L[i]; }
console.log(`rendered ${secs}s in ${ms}ms (${((+secs * 1000) / ms).toFixed(1)}x realtime), peak ${peak.toFixed(3)}, rms ${Math.sqrt(rms / total).toFixed(4)}`);
console.log('z80 pc', m.z80.pc.toString(16), 'queue', m.ram[0x1b88].toString(16));
const buf = Buffer.alloc(44 + total * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(rate, 24);
buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(total * 4, 40);
for (let i = 0; i < total; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
}
fs.writeFileSync(out, buf);
