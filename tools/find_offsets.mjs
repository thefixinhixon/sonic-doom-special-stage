// Dev tool: locate Sonic 2 (REV01) data blobs inside the user's ROM using the
// s2disasm source tree as a reference. Output is a JSON table of offsets that
// src/romdata.js embeds; no ROM data itself is written.
// usage: node tools/find_offsets.mjs <s2disasm dir> <rom>
import fs from 'node:fs';
import path from 'node:path';

const [disasm, romPath] = process.argv.slice(2);
const rom = fs.readFileSync(romPath);

function findAll(buf) {
  const hits = [];
  let i = -1;
  while ((i = rom.indexOf(buf, i + 1)) !== -1) hits.push(i);
  return hits;
}

const out = {};
function locate(name, file) {
  const data = fs.readFileSync(path.join(disasm, file));
  const hits = findAll(data);
  if (hits.length !== 1) console.error(`!! ${name}: ${hits.length} hits`);
  out[name] = { off: hits[0], len: data.length };
}

const frames = [];
for (let i = 1; i <= 17; i++) frames.push(`Slope up - Frame ${i}`);
for (let i = 1; i <= 4; i++) frames.push(`Straight path - Frame ${i}`);
for (let i = 1; i <= 17; i++) frames.push(`Slope down - Frame ${i}`);
for (let i = 1; i <= 11; i++) frames.push(`Curve right - Frame ${i}`);
for (let i = 1; i <= 7; i++) frames.push(`Begin curve right - Frame ${i}`);
out.trackFrames = frames.map((f) => {
  const data = fs.readFileSync(path.join(disasm, 'mappings/special stage', f + '.bin'));
  const hits = findAll(data);
  if (hits.length < 1) console.error('!! frame', f, hits.length);
  return { off: hits[0], len: data.length };
});

locate('artTrack', 'art/kosinski/SpecStag.kos');
locate('artBack', 'art/nemesis/Background art for special stage.nem');
locate('mapBack', 'mappings/misc/Main background mappings for special stage.eni');
locate('mapBackBottom', 'mappings/misc/Lower background mappings for special stage.eni');
locate('artStars', 'art/nemesis/Stars in special stage.nem');
locate('artRings', 'art/nemesis/Special stage ring art.nem');
locate('artFlatShadow', 'art/nemesis/Horizontal shadow from special stage.nem');
locate('artDiagShadow', 'art/nemesis/Diagonal shadow from special stage.nem');
locate('artSideShadow', 'art/nemesis/Vertical shadow from special stage.nem');
locate('artExplosion', 'art/nemesis/Explosion from special stage.nem');
locate('artBomb', 'art/nemesis/Bomb from special stage.nem');
locate('artEmerald', 'art/nemesis/Emerald from special stage.nem');
locate('perspective', 'misc/Special stage object perspective data.kos');
locate('layouts', 'misc/Special stage level layouts.nem');
locate('objectLocations', 'misc/Special stage object location lists.kos');
locate('palSSMain', 'art/palettes/Special Stage Main.bin');
for (let i = 1; i <= 7; i++) locate('palSS' + i, `art/palettes/Special Stage ${i}.bin`);
locate('palEmerald', 'art/palettes/SS Emerald.bin');
locate('sine', 'misc/sinewave.bin');

// Pattern-name lookup tables are dc.w lists in s2.asm; rebuild their bytes to search for them.
const asm = fs.readFileSync(path.join(disasm, 's2.asm'), 'utf8').split('\n');
function tableBytes(startLabel, endRe, pairs) {
  let i = asm.findIndex((l) => l.startsWith(startLabel + ':'));
  const words = [];
  const marks = {};
  for (i++; i < asm.length; i++) {
    const l = asm[i];
    if (endRe.test(l)) break;
    const m = /^(\w+):/.exec(l);
    if (m) marks[m[1]] = words.length;
    const body = l.split(';')[0];
    if (!/dc\.w/.test(body)) continue;
    const re = /make_block_tile\(\$([0-9A-F]+),(\d),(\d),(\d),(\d)\)(?:,\$([0-9A-F]+))?/g;
    let t;
    while ((t = re.exec(body))) {
      const [_, a, fx, fy, pal, pri, cnt] = t;
      words.push((pri << 15) | (pal << 13) | (fy << 12) | (fx << 11) | parseInt(a, 16));
      if (pairs) words.push(parseInt(cnt, 16));
    }
  }
  const b = Buffer.alloc(words.length * 2);
  words.forEach((w, k) => b.writeUInt16BE(w, k * 2));
  return { b, marks };
}
for (const [name, label, end, pairs, part2] of [
  ['pntUnc', 'SSPNT_UncLUT', /^SSPNT_RLELUT:|^;word_69E6/, false, 'SSPNT_UncLUT_Part2'],
  ['pntRLE', 'SSPNT_RLELUT', /^;unknown/, true, 'SSPNT_RLELUT_Part2'],
]) {
  const { b, marks } = tableBytes(label, end, pairs);
  const hits = findAll(b);
  if (hits.length !== 1) console.error(`!! ${name}: ${hits.length} hits, ${b.length} bytes`);
  out[name] = { off: hits[0], len: b.length, part2: (marks[part2] ?? -1) * 2 };
}

// Sound driver: find DecompressSoundDriver by its instruction pattern.
//   lea Snd_Driver(pc),a6 ; move.w #size,d7 ; moveq #0,d6 ; lea Z80_RAM,a5 ; moveq #0,d5 ; lea Z80_RAM,a4
const pat = Buffer.from('7C004BF900A000007A0049F900A00000', 'hex');
const ph = findAll(pat);
if (ph.length !== 1) console.error('!! driver pattern hits', ph.length);
const p = ph[0];
if (rom.readUInt16BE(p - 8) !== 0x4dfa || rom.readUInt16BE(p - 4) !== 0x3e3c) console.error('!! driver opcode mismatch');
const disp = rom.readInt16BE(p - 6);
out.soundDriver = { off: p - 6 + disp, len: rom.readUInt16BE(p - 2) };

console.log(JSON.stringify(out));
