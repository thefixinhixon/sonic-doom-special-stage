// Render a DOOM MUS track through the OPL2 emulator to WAV.
// usage: node tools/render_mus.mjs <wad> <lump> <seconds> <out.wav>
import fs from 'node:fs';
import { Wad } from '../src/doom/wad.js';
import { MusPlayer } from '../src/audio/opl.js';

const [wadPath, lump = 'D_E1M1', secs = '10', out = 'mus.wav'] = process.argv.slice(2);
const wad = new Wad(new Uint8Array(fs.readFileSync(wadPath)));
const rate = 44100;
const p = new MusPlayer(wad.lump('GENMIDI'), rate);
p.play(wad.lump(lump));
const total = Math.floor(+secs * rate);
const L = new Float32Array(total), R = new Float32Array(total);
const bl = new Float32Array(512), br = new Float32Array(512);
const t0 = Date.now();
for (let pos = 0; pos < total; pos += 512) {
  const n = Math.min(512, total - pos);
  p.render(bl, br, n);
  L.set(bl.subarray(0, n), pos);
  R.set(br.subarray(0, n), pos);
}
let peak = 0, rms = 0;
for (let i = 0; i < total; i++) { peak = Math.max(peak, Math.abs(L[i])); rms += L[i] * L[i]; }
console.log(`${lump}: ${secs}s in ${Date.now() - t0}ms, peak ${peak.toFixed(3)} rms ${Math.sqrt(rms / total).toFixed(4)}`);
const buf = Buffer.alloc(44 + total * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(total * 2, 40);
for (let i = 0; i < total; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 2);
fs.writeFileSync(out, buf);
