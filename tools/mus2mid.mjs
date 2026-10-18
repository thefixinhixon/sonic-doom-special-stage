// Convert DOOM MUS music to a Standard MIDI File (format 0), the same way
// source ports' mus2mid does: MUS channel 15 becomes MIDI channel 10 and
// MUS runs at 140 ticks per second.
// passes > 1 repeats the score, for rendering seamless loops.

const CTRL_MAP = [-1, 0x00, 0x01, 0x07, 0x0a, 0x0b, 0x5b, 0x5d, 0x40, 0x43];
const SYS_MAP = { 10: 0x78, 11: 0x7b, 12: 0x7e, 13: 0x7f, 14: 0x79 };

export function mus2mid(mus, passes = 1) {
  if (String.fromCharCode(...mus.subarray(0, 4)) !== 'MUS\x1a') throw new Error('not a MUS lump');
  const scoreLen = mus[4] | (mus[5] << 8);
  const scoreStart = mus[6] | (mus[7] << 8);
  const track = [];
  let delta = 0;
  const varlen = (v) => {
    const bytes = [v & 0x7f];
    while ((v >>= 7)) bytes.unshift((v & 0x7f) | 0x80);
    return bytes;
  };
  const emit = (...bytes) => {
    track.push(...varlen(delta), ...bytes);
    delta = 0;
  };
  // tempo: 500000 us per quarter with 70 ticks per quarter = 140 ticks/s
  emit(0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);
  const chanMap = new Array(16).fill(-1);
  const lastVol = new Array(16).fill(127);
  let nextChan = 0;
  const midiChan = (c) => {
    if (c === 15) return 9;
    if (chanMap[c] < 0) {
      chanMap[c] = nextChan++;
      if (nextChan === 9) nextChan++;
      // a fresh channel gets an "all notes off", as mus2mid does
      emit(0xb0 | chanMap[c], 0x7b, 0x00);
    }
    return chanMap[c];
  };
  for (let pass = 0; pass < passes; pass++) {
    let p = scoreStart;
    const end = scoreStart + scoreLen;
    let done = false;
    while (!done && p < end) {
      const ev = mus[p++];
      const type = (ev >> 4) & 7;
      const ch = midiChan(ev & 15);
      switch (type) {
        case 0:
          emit(0x80 | ch, mus[p++] & 0x7f, 0x40);
          break;
        case 1: {
          const b = mus[p++];
          if (b & 0x80) lastVol[ch] = mus[p++] & 0x7f;
          emit(0x90 | ch, b & 0x7f, lastVol[ch]);
          break;
        }
        case 2: {
          const v = mus[p++] * 64;
          emit(0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f);
          break;
        }
        case 3: {
          const sys = mus[p++];
          if (SYS_MAP[sys] !== undefined) emit(0xb0 | ch, SYS_MAP[sys], sys === 12 ? 16 : 0);
          break;
        }
        case 4: {
          const c = mus[p++];
          const v = mus[p++] & 0x7f;
          if (c === 0) emit(0xc0 | ch, v);
          else if (CTRL_MAP[c] !== undefined && CTRL_MAP[c] >= 0) emit(0xb0 | ch, CTRL_MAP[c], v);
          break;
        }
        case 6:
          done = true;
          break;
        default:
          break;
      }
      if (!done && ev & 0x80) {
        let t = 0;
        let b;
        do {
          b = mus[p++];
          t = t * 128 + (b & 0x7f);
        } while (b & 0x80);
        delta += t;
      }
    }
  }
  emit(0xff, 0x2f, 0x00);
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 70];
  const len = track.length;
  return Uint8Array.from([...header, 0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...track]);
}

// Length of one pass in MUS ticks (140 per second)
export function musTicks(mus) {
  const scoreLen = mus[4] | (mus[5] << 8);
  const scoreStart = mus[6] | (mus[7] << 8);
  let p = scoreStart;
  let ticks = 0;
  while (p < scoreStart + scoreLen) {
    const ev = mus[p++];
    const type = (ev >> 4) & 7;
    if (type === 6) break;
    p += type === 1 ? (mus[p] & 0x80 ? 2 : 1) : type === 4 ? 2 : type === 5 || type === 7 ? 0 : 1;
    if (ev & 0x80) {
      let t = 0;
      let b;
      do {
        b = mus[p++];
        t = t * 128 + (b & 0x7f);
      } while (b & 0x80);
      ticks += t;
    }
  }
  return ticks;
}
