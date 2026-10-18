// OPL2 (YM3812) FM synthesiser and a DMX-style MUS player using DOOM's
// GENMIDI instrument bank, so DOOM's music sounds like it did on a DOS
// sound card.

const OPL_RATE = 49716;
// attenuation units are 0.1875 dB
const ATT_MAX = 511;
const AMP = new Float32Array(1024);
for (let i = 0; i < 1024; i++) AMP[i] = i >= ATT_MAX ? 0 : Math.pow(10, (-i * 0.1875) / 20);
const SIN_LEN = 1024;
const WAVES = [new Float32Array(SIN_LEN), new Float32Array(SIN_LEN), new Float32Array(SIN_LEN), new Float32Array(SIN_LEN)];
for (let i = 0; i < SIN_LEN; i++) {
  const s = Math.sin(((i + 0.5) * 2 * Math.PI) / SIN_LEN);
  WAVES[0][i] = s;
  WAVES[1][i] = s > 0 ? s : 0;
  WAVES[2][i] = Math.abs(s);
  WAVES[3][i] = (i & 0x100) === 0 ? Math.abs(s) : 0;
}
const MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
const KSL_BASE = [0, 9, 12, 13.875, 15, 16.125, 16.875, 17.625, 18, 18.75, 19.125, 19.5, 19.875, 20.25, 20.625, 21];
const KSL_SHIFT = [31, 1, 2, 0];

// envelope tables (after MAME's fmopl)
const EG_INC = Uint8Array.from([
  0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 2, 2, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 4, 4, 2, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4, 8, 8, 8, 8, 8, 8, 8, 8, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const EG_SEL = new Uint8Array(96);
const EG_SH = new Uint8Array(96);
for (let i = 0; i < 16; i++) {
  EG_SEL[i] = 14 * 8;
  EG_SH[i] = 0;
}
for (let r = 0; r < 16; r++) {
  for (let k = 0; k < 4; k++) {
    const i = 16 + r * 4 + k;
    if (r <= 12) {
      EG_SEL[i] = k * 8;
      EG_SH[i] = 12 - r;
    } else if (r === 13) {
      EG_SEL[i] = (4 + k) * 8;
      EG_SH[i] = 0;
    } else if (r === 14) {
      EG_SEL[i] = (8 + k) * 8;
      EG_SH[i] = 0;
    } else {
      EG_SEL[i] = 12 * 8;
      EG_SH[i] = 0;
    }
  }
}
for (let i = 80; i < 96; i++) {
  EG_SEL[i] = 12 * 8;
  EG_SH[i] = 0;
}

const EG_OFF = 0;
const EG_REL = 1;
const EG_SUS = 2;
const EG_DEC = 3;
const EG_ATT = 4;

class Op {
  constructor() {
    this.am = false;
    this.vib = false;
    this.egType = false;
    this.ksrBit = false;
    this.mul = 1;
    this.kslShift = 31;
    this.tl = 0;
    this.ar = 0;
    this.dr = 0;
    this.sl = 0;
    this.rr = 0;
    this.wave = 0;
    this.phase = 0;
    this.state = EG_OFF;
    this.vol = ATT_MAX;
    this.ksr = 0;
    this.ksl = 0;
    this.key = false;
    this.arRaw = 0;
  }
}

class Chan {
  constructor() {
    this.ops = [new Op(), new Op()];
    this.fnum = 0;
    this.block = 0;
    this.fb = 0;
    this.add = false;
    this.fbOut = [0, 0];
  }
}

const OP_OFFSETS = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21];

export class OPL2 {
  constructor(rate) {
    this.rate = rate;
    this.ch = Array.from({ length: 9 }, () => new Chan());
    this.wse = false;
    this.nts = false;
    this.amDeep = false;
    this.vibDeep = false;
    this.egAcc = 0;
    this.egCnt = 0;
    this.amPhase = 0;
    this.vibPhase = 0;
  }

  opFor(reg) {
    const off = reg & 0x1f;
    const idx = OP_OFFSETS.indexOf(off);
    if (idx < 0) return null;
    const chan = (idx % 3) + Math.floor(idx / 6) * 3;
    const which = Math.floor(idx / 3) % 2;
    return { ch: this.ch[chan], op: this.ch[chan].ops[which] };
  }

  write(reg, v) {
    reg &= 0xff;
    v &= 0xff;
    if (reg === 0x01) {
      this.wse = (v & 0x20) !== 0;
      return;
    }
    if (reg === 0x08) {
      this.nts = (v & 0x40) !== 0;
      return;
    }
    if (reg === 0xbd) {
      this.amDeep = (v & 0x80) !== 0;
      this.vibDeep = (v & 0x40) !== 0;
      return;
    }
    if (reg >= 0x20 && reg < 0xa0) {
      const t = this.opFor(reg);
      if (!t) return;
      const o = t.op;
      switch (reg & 0xe0) {
        case 0x20:
          o.am = (v & 0x80) !== 0;
          o.vib = (v & 0x40) !== 0;
          o.egType = (v & 0x20) !== 0;
          o.ksrBit = (v & 0x10) !== 0;
          o.mul = MULT[v & 15];
          this.updateKey(t.ch);
          break;
        case 0x40:
          o.kslShift = KSL_SHIFT[v >> 6];
          o.tl = (v & 0x3f) << 2;
          this.updateKey(t.ch);
          break;
        case 0x60:
          o.arRaw = v >> 4;
          o.ar = v >> 4 ? 16 + ((v >> 4) << 2) : 0;
          o.dr = v & 15 ? 16 + ((v & 15) << 2) : 0;
          break;
        case 0x80:
          o.sl = (v >> 4) === 15 ? 31 * 16 : (v >> 4) * 16;
          o.rr = v & 15 ? 16 + ((v & 15) << 2) : 0;
          break;
      }
      return;
    }
    if (reg >= 0xe0 && reg < 0xf6) {
      const t = this.opFor(reg);
      if (t) t.op.wave = this.wse ? v & 3 : 0;
      return;
    }
    const c = reg & 0x0f;
    if (c > 8) return;
    const ch = this.ch[c];
    switch (reg & 0xf0) {
      case 0xa0:
        ch.fnum = (ch.fnum & 0x300) | v;
        this.updateKey(ch);
        break;
      case 0xb0: {
        ch.fnum = (ch.fnum & 0xff) | ((v & 3) << 8);
        ch.block = (v >> 2) & 7;
        const on = (v & 0x20) !== 0;
        for (const o of ch.ops) {
          if (on && !o.key) this.keyOn(o);
          else if (!on && o.key) this.keyOff(o);
        }
        this.updateKey(ch);
        break;
      }
      case 0xc0:
        ch.fb = (v >> 1) & 7;
        ch.add = (v & 1) !== 0;
        break;
    }
  }

  updateKey(ch) {
    const kcode = (ch.block << 1) | ((ch.fnum >> (this.nts ? 8 : 9)) & 1);
    const kslDb = Math.max(0, KSL_BASE[ch.fnum >> 6] - 3 * (7 - ch.block));
    for (const o of ch.ops) {
      o.ksr = o.ksrBit ? kcode : kcode >> 2;
      // table is in 0.09375 dB units; KSL 1/2/3 = 3/1.5/6 dB per octave
      o.ksl = o.kslShift === 31 ? 0 : Math.round(kslDb / 0.09375) >> o.kslShift;
    }
  }

  keyOn(o) {
    o.key = true;
    o.phase = 0;
    if (o.arRaw === 15) {
      o.vol = 0;
      o.state = EG_DEC;
    } else o.state = EG_ATT;
  }
  keyOff(o) {
    o.key = false;
    if (o.state > EG_REL) o.state = EG_REL;
  }

  stepEG() {
    this.egCnt++;
    const cnt = this.egCnt;
    for (const ch of this.ch) {
      for (const o of ch.ops) {
        let rate;
        switch (o.state) {
          case EG_ATT: {
            rate = o.ar + o.ksr;
            const sh = EG_SH[rate];
            if (!(cnt & ((1 << sh) - 1))) {
              o.vol += (~o.vol * EG_INC[EG_SEL[rate] + ((cnt >> sh) & 7)]) >> 3;
              if (o.vol <= 0) {
                o.vol = 0;
                o.state = EG_DEC;
              }
            }
            break;
          }
          case EG_DEC: {
            rate = o.dr + o.ksr;
            const sh = EG_SH[rate];
            if (!(cnt & ((1 << sh) - 1))) {
              o.vol += EG_INC[EG_SEL[rate] + ((cnt >> sh) & 7)];
              if (o.vol >= o.sl) o.state = EG_SUS;
            }
            break;
          }
          case EG_SUS:
            if (o.egType) break;
          // percussive sound: fall through to release behaviour
          // eslint-disable-next-line no-fallthrough
          case EG_REL: {
            rate = o.rr + o.ksr;
            const sh = EG_SH[rate];
            if (!(cnt & ((1 << sh) - 1))) {
              o.vol += EG_INC[EG_SEL[rate] + ((cnt >> sh) & 7)];
              if (o.vol >= ATT_MAX) {
                o.vol = ATT_MAX;
                o.state = EG_OFF;
              }
            }
            break;
          }
        }
      }
    }
  }

  render(out, offset, n) {
    const egStep = OPL_RATE / this.rate;
    const amInc = 3.7 / this.rate;
    const vibInc = 6.1 / this.rate;
    for (let i = 0; i < n; i++) {
      this.egAcc += egStep;
      while (this.egAcc >= 1) {
        this.egAcc -= 1;
        this.stepEG();
      }
      this.amPhase = (this.amPhase + amInc) % 1;
      this.vibPhase = (this.vibPhase + vibInc) % 1;
      const amTri = this.amPhase < 0.5 ? this.amPhase * 2 : 2 - this.amPhase * 2;
      const amAtt = Math.round(amTri * (this.amDeep ? 4.8 : 1.0) / 0.1875);
      const vibCents = Math.sin(this.vibPhase * 2 * Math.PI) * (this.vibDeep ? 14 : 7);
      const vibMul = Math.pow(2, vibCents / 1200);
      let s = 0;
      for (const ch of this.ch) {
        const m = ch.ops[0];
        const c = ch.ops[1];
        if (m.state === EG_OFF && c.state === EG_OFF) continue;
        const baseHz = (ch.fnum * OPL_RATE * Math.pow(2, ch.block)) / (1 << 20);
        // modulator with feedback
        const fbPhase = ch.fb ? ((ch.fbOut[0] + ch.fbOut[1]) * Math.pow(2, ch.fb - 7)) : 0;
        const mHz = baseHz * m.mul * (m.vib ? vibMul : 1);
        m.phase = (m.phase + mHz / this.rate) % 1;
        const mAtt = m.vol + m.tl + m.ksl + (m.am ? amAtt : 0);
        const mIdx = ((((m.phase + fbPhase) % 1) + 1) % 1) * SIN_LEN;
        const mOut = WAVES[m.wave][mIdx | 0] * AMP[Math.min(1023, mAtt)];
        ch.fbOut[0] = ch.fbOut[1];
        ch.fbOut[1] = mOut;
        const cHz = baseHz * c.mul * (c.vib ? vibMul : 1);
        c.phase = (c.phase + cHz / this.rate) % 1;
        const cAtt = c.vol + c.tl + c.ksl + (c.am ? amAtt : 0);
        const pm = ch.add ? 0 : mOut * 4; // full-scale modulator = 4 cycles (8 pi)
        const cIdx = ((((c.phase + pm) % 1) + 1) % 1) * SIN_LEN;
        const cOut = WAVES[c.wave][cIdx | 0] * AMP[Math.min(1023, cAtt)];
        s += ch.add ? cOut + mOut : cOut;
      }
      out[offset + i] = s * 0.18;
    }
  }
}

// ------------------------------------------------------------------ GENMIDI
export function parseGenmidi(data) {
  const sig = String.fromCharCode(...data.subarray(0, 8));
  if (sig !== '#OPL_II#') return null;
  const instrs = [];
  const op = (o) => ({ tremolo: data[o], attack: data[o + 1], sustain: data[o + 2], waveform: data[o + 3], scale: data[o + 4], level: data[o + 5] });
  for (let i = 0; i < 175; i++) {
    const o = 8 + i * 36;
    const flags = data[o] | (data[o + 1] << 8);
    const voices = [];
    for (let v = 0; v < 2; v++) {
      const vo = o + 4 + v * 16;
      const base = data[vo + 14] | (data[vo + 15] << 8);
      voices.push({ mod: op(vo), feedback: data[vo + 6], car: op(vo + 7), baseNote: (base << 16) >> 16 });
    }
    instrs.push({ flags, fineTuning: data[o + 2], fixedNote: data[o + 3], voices });
  }
  return instrs;
}

// DMX volume curve (from Chocolate Doom's i_oplmusic.c)
const VOLUME_MAP = [
  0, 1, 3, 5, 6, 8, 10, 11, 13, 14, 16, 17, 19, 20, 22, 23, 25, 26, 27, 29, 30, 32, 33, 34, 36, 37, 39, 41, 43, 45, 47, 49,
  50, 52, 54, 55, 57, 59, 60, 61, 63, 64, 66, 67, 68, 69, 71, 72, 73, 74, 75, 76, 77, 79, 80, 81, 82, 83, 84, 84, 85, 86,
  87, 88, 89, 90, 91, 92, 92, 93, 94, 95, 96, 96, 97, 98, 99, 99, 100, 101, 101, 102, 103, 103, 104, 105, 105, 106, 107, 107, 108, 109,
  109, 110, 110, 111, 112, 112, 113, 113, 114, 114, 115, 115, 116, 117, 117, 118, 118, 119, 119, 120, 120, 121, 121, 122, 122, 123, 123, 123, 124, 124, 125, 125,
  126, 126, 127, 127,
];

const MUS_PERCUSSION = 15;
const VOICE_OPS = [];
for (let c = 0; c < 9; c++) {
  const mod = (c % 3) + Math.floor(c / 3) * 8;
  VOICE_OPS.push([mod, mod + 3]);
}

// ------------------------------------------------------------------ MUS player
export class MusPlayer {
  constructor(genmidiData, rate) {
    this.rate = rate;
    this.instrs = parseGenmidi(genmidiData);
    this.opl = new OPL2(rate);
    this.opl.write(0x01, 0x20);
    this.opl.write(0x08, 0x40);
    this.voices = Array.from({ length: 9 }, (_, i) => ({ index: i, free: true, channel: -1, key: 0, note: 0, instr: null, instrVoice: 0, noteVolume: 0, age: 0, regVolume: -1 }));
    this.clock = 0;
    this.mus = null;
    this.gain = 1;
    this.fadeRate = 0;
    this.buf = null;
  }

  play(mus, loop = true) {
    this.stopAll();
    const sig = String.fromCharCode(...mus.subarray(0, 4));
    if (sig !== 'MUS\x1a') return;
    const scoreLen = mus[4] | (mus[5] << 8);
    const scoreStart = mus[6] | (mus[7] << 8);
    this.mus = mus;
    this.scoreStart = scoreStart;
    this.scoreEnd = scoreStart + scoreLen;
    this.pos = scoreStart;
    this.loop = loop;
    this.wait = 0;
    this.gain = 1;
    this.fadeRate = 0;
    this.channels = Array.from({ length: 16 }, () => ({ instrument: 0, volume: 100, lastVolume: 127, bend: 0, pan: 64 }));
    this.tickAcc = 0;
  }

  stop() {
    this.stopAll();
    this.mus = null;
  }

  fade() {
    this.fadeRate = 1 / (this.rate * 1.5);
  }

  stopAll() {
    for (const v of this.voices) if (!v.free) this.voiceOff(v);
  }

  // ---------------------------------------------------------------- OPL voice handling
  loadInstrument(v, instr, iv) {
    const data = instr.voices[iv];
    const [m, c] = VOICE_OPS[v.index];
    const w = (r, val) => this.opl.write(r, val);
    const opRegs = (off, o, level) => {
      w(0x40 + off, level | (o.scale & 0xc0));
      w(0x20 + off, o.tremolo);
      w(0x60 + off, o.attack);
      w(0x80 + off, o.sustain);
      w(0xe0 + off, o.waveform);
    };
    // carrier starts silent until SetVoiceVolume; in additive mode so does the modulator
    const modulating = (data.feedback & 1) === 0;
    opRegs(c, data.car, 0x3f);
    opRegs(m, data.mod, modulating ? data.mod.level : 0x3f);
    w(0xc0 + v.index, data.feedback | 0x30);
    v.instr = instr;
    v.instrVoice = iv;
    v.regVolume = -1;
  }

  setVoiceVolume(v, volume) {
    v.noteVolume = volume;
    const data = v.instr.voices[v.instrVoice];
    const ch = this.channels[v.channel];
    const midiVolume = 2 * (VOLUME_MAP[Math.min(127, ch.volume)] + 1);
    const full = (VOLUME_MAP[Math.min(127, volume)] * midiVolume) >> 9;
    const car = 0x3f - full;
    if (car !== v.regVolume) {
      v.regVolume = car;
      const [m, c] = VOICE_OPS[v.index];
      this.opl.write(0x40 + c, car | (data.car.scale & 0xc0));
      if (data.feedback & 1 && data.mod.level !== 0x3f) {
        const modVol = Math.max(data.mod.level, car);
        this.opl.write(0x40 + m, modVol | (data.mod.scale & 0xc0));
      }
    }
  }

  frequencyFor(v) {
    let note = v.note;
    const instr = v.instr;
    if (!(instr.flags & 1)) note += instr.voices[v.instrVoice].baseNote;
    while (note < 0) note += 12;
    while (note > 95) note -= 12;
    let idx = 64 + 32 * note + this.channels[v.channel].bend;
    if (v.instrVoice !== 0) idx += (instr.fineTuning >> 1) - 64;
    if (idx < 0) idx = 0;
    // index steps are 1/32 semitone; DMX's frequency table puts index 64
    // (note 0) at fnum 0x158 block 0, i.e. C0 = 16.35 Hz
    const semis = (idx - 64) / 32;
    const hz = ((0x158 * OPL_RATE) / (1 << 20)) * Math.pow(2, semis / 12);
    let block = 0;
    let fnum = (hz * (1 << 20)) / OPL_RATE;
    while (fnum >= 1024 && block < 7) {
      fnum /= 2;
      block++;
    }
    fnum = Math.min(1023, Math.round(fnum));
    return (block << 10) | fnum;
  }

  updateFrequency(v) {
    const f = this.frequencyFor(v);
    this.opl.write(0xa0 + v.index, f & 0xff);
    this.opl.write(0xb0 + v.index, (f >> 8) | (v.free ? 0 : 0x20));
  }

  voiceOff(v) {
    const f = this.frequencyFor(v);
    this.opl.write(0xb0 + v.index, (f >> 8) & 0x1f);
    v.free = true;
  }

  freeVoice() {
    let best = null;
    for (const v of this.voices) if (v.free && (!best || v.age < best.age)) best = v;
    return best;
  }

  // ReplaceExistingVoice (DMX 1.9): drop a second voice, or the voice on the
  // highest-numbered channel
  replaceVoice() {
    const used = this.voices.filter((v) => !v.free).sort((a, b) => a.age - b.age);
    let result = 0;
    for (let i = 0; i < used.length; i++) {
      if (used[i].instrVoice !== 0 || used[i].channel >= used[result].channel) result = i;
    }
    if (used.length) this.voiceOff(used[result]);
  }

  noteOn(chn, key, volume) {
    const ch = this.channels[chn];
    let instr;
    let note = key;
    if (chn === MUS_PERCUSSION) {
      if (key < 35 || key > 81) return;
      instr = this.instrs[128 + key - 35];
      note = 60;
    } else instr = this.instrs[ch.instrument];
    if (!instr) return;
    if (instr.flags & 1) note = instr.fixedNote;
    const count = instr.flags & 4 ? 2 : 1;
    if (!this.freeVoice()) this.replaceVoice();
    for (let iv = 0; iv < count; iv++) {
      const v = this.freeVoice();
      if (!v) break;
      v.free = false;
      v.channel = chn;
      v.key = key;
      v.note = note;
      v.age = this.clock++;
      if (v.instr !== instr || v.instrVoice !== iv) this.loadInstrument(v, instr, iv);
      this.setVoiceVolume(v, volume);
      this.updateFrequency(v);
    }
  }

  noteOff(chn, key) {
    for (const v of this.voices) if (!v.free && v.channel === chn && v.key === key) this.voiceOff(v);
  }

  // ---------------------------------------------------------------- MUS events
  readEvent() {
    const d = this.mus;
    const ev = d[this.pos++];
    const type = (ev >> 4) & 7;
    const chn = ev & 15;
    const ch = this.channels[chn];
    switch (type) {
      case 0:
        this.noteOff(chn, d[this.pos++] & 0x7f);
        break;
      case 1: {
        const b = d[this.pos++];
        if (b & 0x80) ch.lastVolume = d[this.pos++] & 0x7f;
        this.noteOn(chn, b & 0x7f, ch.lastVolume);
        break;
      }
      case 2:
        ch.bend = (d[this.pos++] >> 1) - 64;
        for (const v of this.voices) if (!v.free && v.channel === chn) this.updateFrequency(v);
        break;
      case 3: {
        const sys = d[this.pos++];
        if (sys === 10 || sys === 11) for (const v of this.voices) if (!v.free && v.channel === chn) this.voiceOff(v);
        break;
      }
      case 4: {
        const ctrl = d[this.pos++];
        const val = d[this.pos++] & 0x7f;
        if (ctrl === 0) ch.instrument = val;
        else if (ctrl === 3) {
          ch.volume = val;
          for (const v of this.voices) if (!v.free && v.channel === chn) this.setVoiceVolume(v, v.noteVolume);
        } else if (ctrl === 4) ch.pan = val;
        break;
      }
      case 6:
        // end of score
        if (this.loop) {
          this.pos = this.scoreStart;
          this.stopAll();
        } else {
          this.stopAll();
          this.mus = null;
        }
        return;
      default:
        break;
    }
    if (ev & 0x80) {
      let t = 0;
      let b;
      do {
        b = d[this.pos++];
        t = t * 128 + (b & 0x7f);
      } while (b & 0x80);
      this.wait += t;
    }
  }

  tick() {
    if (!this.mus) return;
    let guard = 0;
    while (this.mus && this.wait <= 0 && guard++ < 1000) {
      if (this.pos >= this.scoreEnd) {
        if (this.loop) {
          this.pos = this.scoreStart;
          this.stopAll();
        } else {
          this.mus = null;
          break;
        }
      }
      this.readEvent();
    }
    this.wait--;
  }

  render(left, right, n) {
    if (!this.buf || this.buf.length < n) this.buf = new Float32Array(n);
    const buf = this.buf;
    let done = 0;
    const tickLen = this.rate / 140;
    while (done < n) {
      if (this.tickAcc <= 0) {
        this.tick();
        this.tickAcc += tickLen;
      }
      const chunk = Math.min(n - done, Math.ceil(this.tickAcc));
      this.opl.render(buf, done, chunk);
      this.tickAcc -= chunk;
      done += chunk;
    }
    for (let i = 0; i < n; i++) {
      if (this.fadeRate) {
        this.gain -= this.fadeRate;
        if (this.gain <= 0) {
          this.gain = 0;
          this.fadeRate = 0;
          this.stop();
        }
      }
      const s = buf[i] * this.gain;
      left[i] = s;
      right[i] = s;
    }
  }
}
