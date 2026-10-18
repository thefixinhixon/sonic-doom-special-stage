// YM2612 (OPN2) FM synthesiser, structured after the MAME/Genesis Plus GX
// implementation. Runs at the chip's native rate (clock / 144).

const FREQ_SH = 16;
const EG_SH = 16;
const FREQ_MASK = (1 << FREQ_SH) - 1;
const ENV_BITS = 10;
const ENV_LEN = 1 << ENV_BITS;
const ENV_STEP = 128.0 / ENV_LEN;
const MAX_ATT_INDEX = ENV_LEN - 1;
const MIN_ATT_INDEX = 0;
const SIN_BITS = 10;
const SIN_LEN = 1 << SIN_BITS;
const SIN_MASK = SIN_LEN - 1;
const TL_RES_LEN = 256;
const TL_TAB_LEN = 13 * 2 * TL_RES_LEN;
const ENV_QUIET = TL_TAB_LEN >> 3;

const EG_ATT = 4;
const EG_DEC = 3;
const EG_SUS = 2;
const EG_REL = 1;
const EG_OFF = 0;

const tlTab = new Int32Array(TL_TAB_LEN);
const sinTab = new Uint32Array(SIN_LEN);
(() => {
  for (let x = 0; x < TL_RES_LEN; x++) {
    let m = (1 << 16) / Math.pow(2, ((x + 1) * (ENV_STEP / 4.0)) / 8.0);
    m = Math.floor(m);
    let n = m | 0;
    n >>= 4;
    if (n & 1) n = (n >> 1) + 1;
    else n >>= 1;
    n <<= 2;
    tlTab[x * 2] = n;
    tlTab[x * 2 + 1] = -n;
    for (let i = 1; i < 13; i++) {
      tlTab[x * 2 + i * 2 * TL_RES_LEN] = tlTab[x * 2] >> i;
      tlTab[x * 2 + 1 + i * 2 * TL_RES_LEN] = -(tlTab[x * 2] >> i);
    }
  }
  for (let i = 0; i < SIN_LEN; i++) {
    const m = Math.sin(((i * 2 + 1) * Math.PI) / SIN_LEN);
    let o = m > 0 ? (8 * Math.log(1 / m)) / Math.log(2) : (8 * Math.log(-1 / m)) / Math.log(2);
    o /= ENV_STEP / 4;
    let n = Math.floor(2 * o);
    if (n & 1) n = (n >> 1) + 1;
    else n >>= 1;
    sinTab[i] = n * 2 + (m >= 0 ? 0 : 1);
  }
})();

const EG_INC = Uint8Array.from([
  0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 2, 2, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 4, 4, 2, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 8, 4, 4, 4, 8, 4, 8, 4, 8, 4, 8, 4, 8, 4, 8, 8, 8, 4, 8, 8, 8,
  8, 8, 8, 8, 8, 8, 8, 8, 16, 16, 16, 16, 16, 16, 16, 16, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const EG_RATE_SELECT = new Uint8Array(128);
const EG_RATE_SHIFT = new Uint8Array(128);
(() => {
  for (let i = 0; i < 32; i++) {
    EG_RATE_SELECT[i] = 18 * 8;
    EG_RATE_SHIFT[i] = 0;
  }
  for (let i = 0; i < 48; i++) {
    EG_RATE_SELECT[32 + i] = (i & 3) * 8;
    EG_RATE_SHIFT[32 + i] = 11 - (i >> 2);
  }
  for (let i = 0; i < 16; i++) {
    EG_RATE_SELECT[80 + i] = (i < 12 ? 4 + i : 16) * 8;
    EG_RATE_SHIFT[80 + i] = 0;
  }
  for (let i = 0; i < 32; i++) {
    EG_RATE_SELECT[96 + i] = 16 * 8;
    EG_RATE_SHIFT[96 + i] = 0;
  }
})();

const DT_TAB = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 8, 8,
  1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 16, 16, 16,
  2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 20, 22, 22, 22, 22,
];
const FK_TABLE = [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 3, 3];
const SL_TABLE = [];
for (let i = 0; i < 16; i++) SL_TABLE.push((i === 15 ? 31 : i) * 32);
const LFO_SAMPLES_PER_STEP = [108, 77, 71, 67, 62, 44, 8, 5];
const LFO_AMS_SHIFT = [8, 3, 1, 0];
// vibrato depth in cents for PMS 0..7
const PMS_CENTS = [0, 3.4, 6.7, 10, 14, 20, 40, 80];

// detune in phase-increment units (freqbase = 1 at the native rate)
const DT = [];
for (let d = 0; d < 8; d++) DT.push(new Int32Array(32));
for (let d = 0; d < 4; d++) {
  for (let i = 0; i < 32; i++) {
    const rate = (DT_TAB[d * 32 + i] * SIN_LEN * (1 << FREQ_SH)) / (1 << 20);
    DT[d][i] = rate;
    DT[d + 4][i] = -rate;
  }
}
const FN_TABLE = new Uint32Array(4096);
for (let i = 0; i < 4096; i++) FN_TABLE[i] = i * 32 * (1 << (FREQ_SH - 10));
const FN_MAX = Math.floor((0x20000 * (1 << (FREQ_SH - 10))) / 1);

class Slot {
  constructor() {
    this.dt = DT[0];
    this.ksrShift = 3;
    this.ar = 0;
    this.d1r = 0;
    this.d2r = 0;
    this.rr = 0;
    this.ksr = 0;
    this.mul = 1;
    this.phase = 0;
    this.incr = -1;
    this.state = EG_OFF;
    this.tl = 0;
    this.volume = MAX_ATT_INDEX;
    this.sl = 0;
    this.volOut = MAX_ATT_INDEX;
    this.egShAr = 0;
    this.egSelAr = 0;
    this.egShD1r = 0;
    this.egSelD1r = 0;
    this.egShD2r = 0;
    this.egSelD2r = 0;
    this.egShRr = 0;
    this.egSelRr = 0;
    this.key = 0;
    this.amMask = 0;
  }
}

class Channel {
  constructor() {
    this.slots = [new Slot(), new Slot(), new Slot(), new Slot()]; // register order: OP1, OP3, OP2, OP4
    this.algo = 0;
    this.fb = 0;
    this.op1Out = [0, 0];
    this.memValue = 0;
    this.pms = 0;
    this.ams = 8;
    this.fc = 0;
    this.kcode = 0;
    this.blockFnum = 0;
    this.panL = true;
    this.panR = true;
  }
}

export class YM2612 {
  constructor() {
    this.ch = Array.from({ length: 6 }, () => new Channel());
    this.addr = [0, 0];
    this.fnH = 0;
    this.sl3FnH = 0;
    this.sl3 = { fc: [0, 0, 0], kcode: [0, 0, 0], blockFnum: [0, 0, 0] };
    this.mode = 0;
    this.egCnt = 1;
    this.egTimer = 0;
    this.lfoOn = false;
    this.lfoCnt = 0;
    this.lfoTimer = 0;
    this.lfoStep = LFO_SAMPLES_PER_STEP[0];
    this.lfoAM = 0;
    this.lfoPM = 0;
    this.dacOut = 0;
    this.dacEn = false;
    this.regs = new Uint8Array(0x200);
    this.out = [0, 0, 0, 0, 0, 0];
  }

  write(port, v) {
    v &= 0xff;
    switch (port & 3) {
      case 0:
        this.addr[0] = v;
        break;
      case 2:
        this.addr[1] = v;
        break;
      case 1:
        this.writeReg(this.addr[0], v);
        break;
      case 3:
        if (this.addr[1] >= 0x30) this.writeReg(this.addr[1] | 0x100, v);
        break;
    }
  }

  read() {
    return 0; // never busy, timers unused by the sound driver
  }

  writeReg(r, v) {
    this.regs[r] = v;
    if (r < 0x30) {
      switch (r) {
        case 0x22:
          this.lfoOn = (v & 8) !== 0;
          this.lfoStep = LFO_SAMPLES_PER_STEP[v & 7];
          if (!this.lfoOn) {
            this.lfoCnt = 0;
            this.lfoTimer = 0;
            this.lfoAM = 0;
            this.lfoPM = 0;
          }
          break;
        case 0x27:
          if ((v ^ this.mode) & 0x40) this.ch[2].fc = 0; // force refresh
          this.mode = v;
          this.refreshCh(this.ch[2], 2);
          break;
        case 0x28: {
          let c = v & 3;
          if (c === 3) return;
          if (v & 4) c += 3;
          const ch = this.ch[c];
          const keys = [0x10, 0x40, 0x20, 0x80]; // OP1, OP3, OP2, OP4 key bits in register order
          for (let s = 0; s < 4; s++) {
            if (v & keys[s]) this.keyOn(ch, s);
            else this.keyOff(ch, s);
          }
          break;
        }
        case 0x2a:
          this.dacOut = (v - 0x80) << 6;
          break;
        case 0x2b:
          this.dacEn = (v & 0x80) !== 0;
          break;
      }
      return;
    }
    const c = r & 3;
    if (c === 3) return;
    const chIdx = c + (r & 0x100 ? 3 : 0);
    const ch = this.ch[chIdx];
    const slot = ch.slots[(r >> 2) & 3];
    switch (r & 0xf0) {
      case 0x30:
        slot.mul = v & 0x0f ? (v & 0x0f) * 2 : 1;
        slot.dt = DT[(v >> 4) & 7];
        ch.slots[0].incr = -1;
        break;
      case 0x40:
        slot.tl = (v & 0x7f) << (ENV_BITS - 7);
        this.updateVolOut(slot);
        break;
      case 0x50: {
        const old = slot.ksrShift;
        slot.ksrShift = 3 - (v >> 6);
        slot.ar = v & 0x1f ? 32 + ((v & 0x1f) << 1) : 0;
        if (old !== slot.ksrShift) ch.slots[0].incr = -1;
        this.refreshRates(slot);
        break;
      }
      case 0x60:
        slot.amMask = v & 0x80 ? ~0 : 0;
        slot.d1r = v & 0x1f ? 32 + ((v & 0x1f) << 1) : 0;
        this.refreshRates(slot);
        break;
      case 0x70:
        slot.d2r = v & 0x1f ? 32 + ((v & 0x1f) << 1) : 0;
        this.refreshRates(slot);
        break;
      case 0x80:
        slot.sl = SL_TABLE[v >> 4];
        slot.rr = 34 + ((v & 0x0f) << 2);
        this.refreshRates(slot);
        break;
      case 0x90:
        break; // SSG-EG not emulated
      case 0xa0:
        switch ((r >> 2) & 3) {
          case 0: {
            const fn = ((this.fnH & 7) << 8) + v;
            const blk = this.fnH >> 3;
            ch.kcode = (blk << 2) | FK_TABLE[fn >> 7];
            ch.fc = FN_TABLE[fn * 2] >> (7 - blk);
            ch.blockFnum = (blk << 11) | fn;
            ch.slots[0].incr = -1;
            break;
          }
          case 1:
            this.fnH = v & 0x3f;
            break;
          case 2:
            if (r < 0x100) {
              const fn = ((this.sl3FnH & 7) << 8) + v;
              const blk = this.sl3FnH >> 3;
              this.sl3.kcode[c] = (blk << 2) | FK_TABLE[fn >> 7];
              this.sl3.fc[c] = FN_TABLE[fn * 2] >> (7 - blk);
              this.sl3.blockFnum[c] = (blk << 11) | fn;
              this.ch[2].slots[0].incr = -1;
            }
            break;
          case 3:
            if (r < 0x100) this.sl3FnH = v & 0x3f;
            break;
        }
        break;
      case 0xb0:
        switch ((r >> 2) & 3) {
          case 0: {
            const fb = (v >> 3) & 7;
            ch.algo = v & 7;
            ch.fb = fb ? fb + 6 : 0;
            break;
          }
          case 1:
            ch.panL = (v & 0x80) !== 0;
            ch.panR = (v & 0x40) !== 0;
            ch.ams = LFO_AMS_SHIFT[(v >> 4) & 3];
            ch.pms = v & 7;
            break;
        }
        break;
    }
  }

  refreshRates(slot) {
    const ksr = slot.ksr;
    const ar = slot.ar + ksr;
    if (ar < 32 + 62) {
      slot.egShAr = EG_RATE_SHIFT[ar];
      slot.egSelAr = EG_RATE_SELECT[ar];
    } else {
      slot.egShAr = 0;
      slot.egSelAr = 17 * 8;
    }
    slot.egShD1r = EG_RATE_SHIFT[slot.d1r + ksr];
    slot.egSelD1r = EG_RATE_SELECT[slot.d1r + ksr];
    slot.egShD2r = EG_RATE_SHIFT[slot.d2r + ksr];
    slot.egSelD2r = EG_RATE_SELECT[slot.d2r + ksr];
    slot.egShRr = EG_RATE_SHIFT[slot.rr + ksr];
    slot.egSelRr = EG_RATE_SELECT[slot.rr + ksr];
  }

  keyOn(ch, s) {
    const slot = ch.slots[s];
    if (!slot.key) {
      slot.key = 1;
      slot.phase = 0;
      this.refreshSlot(ch, slot, this.slotKc(ch, s));
      if (slot.ar + slot.ksr < 32 + 62) {
        slot.state = EG_ATT;
        if (slot.volume <= MIN_ATT_INDEX) slot.state = EG_DEC;
      } else {
        slot.volume = MIN_ATT_INDEX;
        slot.state = EG_DEC;
      }
      this.updateVolOut(slot);
    }
  }
  keyOff(ch, s) {
    const slot = ch.slots[s];
    if (slot.key) {
      slot.key = 0;
      if (slot.state > EG_REL) slot.state = EG_REL;
    }
  }

  updateVolOut(slot) {
    slot.volOut = slot.volume + slot.tl;
  }

  // channel 3 special mode: OP1, OP2, OP3 take their frequency from A9, AA, A8
  slotKc(ch, s) {
    if (ch === this.ch[2] && this.mode & 0xc0 && s !== 3) {
      const idx = s === 0 ? 1 : s === 2 ? 2 : 0; // OP1->A9, OP2->AA, OP3->A8
      return { fc: this.sl3.fc[idx], kc: this.sl3.kcode[idx] };
    }
    return { fc: ch.fc, kc: ch.kcode };
  }

  refreshSlot(ch, slot, { fc, kc }) {
    let f = fc + slot.dt[kc];
    if (f < 0) f += FN_MAX;
    let incr = (f * slot.mul) >> 1;
    if (ch.pms && this.lfoOn) {
      const tri = this.lfoPM < 16 ? this.lfoPM : 31 - this.lfoPM; // 0..15
      const dev = (tri / 15) * 2 - 1;
      incr = Math.floor(incr * Math.pow(2, (dev * PMS_CENTS[ch.pms]) / 1200));
    }
    slot.incr = incr;
    const ksr = kc >> slot.ksrShift;
    if (slot.ksr !== ksr) {
      slot.ksr = ksr;
      this.refreshRates(slot);
    }
  }

  refreshCh(ch) {
    for (let s = 0; s < 4; s++) this.refreshSlot(ch, ch.slots[s], this.slotKc(ch, s));
  }

  advanceEG() {
    this.egTimer++;
    if (this.egTimer < 3) return;
    this.egTimer = 0;
    this.egCnt++;
    if (this.egCnt === 4096) this.egCnt = 1;
    const cnt = this.egCnt;
    for (const ch of this.ch) {
      for (const slot of ch.slots) {
        switch (slot.state) {
          case EG_ATT:
            if (!(cnt & ((1 << slot.egShAr) - 1))) {
              slot.volume += (~slot.volume * EG_INC[slot.egSelAr + ((cnt >> slot.egShAr) & 7)]) >> 4;
              if (slot.volume <= MIN_ATT_INDEX) {
                slot.volume = MIN_ATT_INDEX;
                slot.state = EG_DEC;
              }
              this.updateVolOut(slot);
            }
            break;
          case EG_DEC:
            if (!(cnt & ((1 << slot.egShD1r) - 1))) {
              slot.volume += EG_INC[slot.egSelD1r + ((cnt >> slot.egShD1r) & 7)];
              if (slot.volume >= slot.sl) slot.state = EG_SUS;
              this.updateVolOut(slot);
            }
            break;
          case EG_SUS:
            if (!(cnt & ((1 << slot.egShD2r) - 1))) {
              slot.volume += EG_INC[slot.egSelD2r + ((cnt >> slot.egShD2r) & 7)];
              if (slot.volume >= MAX_ATT_INDEX) slot.volume = MAX_ATT_INDEX;
              this.updateVolOut(slot);
            }
            break;
          case EG_REL:
            if (!(cnt & ((1 << slot.egShRr) - 1))) {
              slot.volume += EG_INC[slot.egSelRr + ((cnt >> slot.egShRr) & 7)];
              if (slot.volume >= MAX_ATT_INDEX) {
                slot.volume = MAX_ATT_INDEX;
                slot.state = EG_OFF;
              }
              this.updateVolOut(slot);
            }
            break;
        }
      }
    }
  }

  advanceLFO() {
    if (!this.lfoOn) return;
    if (++this.lfoTimer >= this.lfoStep) {
      this.lfoTimer = 0;
      this.lfoCnt = (this.lfoCnt + 1) & 127;
      this.lfoAM = this.lfoCnt < 64 ? (this.lfoCnt ^ 63) << 1 : (this.lfoCnt & 63) << 1;
      const pm = this.lfoCnt >> 2;
      if (pm !== this.lfoPM) {
        this.lfoPM = pm;
        for (const ch of this.ch) if (ch.pms) ch.slots[0].incr = -1;
      }
    }
  }

  // Generate one native-rate sample; returns [left, right] (~14-bit each)
  clock(outLR) {
    let l = 0;
    let r = 0;
    for (let c = 0; c < 6; c++) {
      const ch = this.ch[c];
      if (ch.slots[0].incr === -1) this.refreshCh(ch);
      let out;
      if (c === 5 && this.dacEn) out = this.dacOut;
      else out = this.chanCalc(ch);
      if (out > 8191) out = 8191;
      else if (out < -8192) out = -8192;
      if (ch.panL) l += out;
      if (ch.panR) r += out;
    }
    this.advanceLFO();
    this.advanceEG();
    outLR[0] = l;
    outLR[1] = r;
  }

  chanCalc(ch) {
    const am = this.lfoAM >> ch.ams;
    const s = ch.slots; // [OP1, OP3, OP2, OP4]
    let c1 = 0;
    let m2 = 0;
    let c2 = 0;
    let mem = 0;
    let carrier = 0;
    // restore delayed sample into its destination
    const memDest = ch.algo <= 3 || ch.algo === 5 ? (ch.algo === 3 ? 'c2' : 'm2') : 'mem';
    if (memDest === 'm2') m2 = ch.memValue;
    else if (memDest === 'c2') c2 = ch.memValue;
    const vol = (sl) => sl.volOut + (am & sl.amMask);

    // OP1 with feedback
    let fbIn = ch.op1Out[0] + ch.op1Out[1];
    ch.op1Out[0] = ch.op1Out[1];
    const op1 = ch.op1Out[0];
    switch (ch.algo) {
      case 0: case 3: case 4: case 6:
        c1 += op1;
        break;
      case 1:
        mem += op1;
        break;
      case 2:
        c2 += op1;
        break;
      case 5:
        mem = c1 = c2 = op1;
        break;
      default:
        carrier += op1;
    }
    ch.op1Out[1] = 0;
    let eg = vol(s[0]);
    if (eg < ENV_QUIET) {
      if (!ch.fb) fbIn = 0;
      ch.op1Out[1] = this.opCalc1(s[0].phase, eg, fbIn << ch.fb);
    }
    // OP3 (M2)
    eg = vol(s[1]);
    if (eg < ENV_QUIET) {
      const v = this.opCalc(s[1].phase, eg, m2);
      switch (ch.algo) {
        case 0: case 1: case 2: case 3: c2 += v; break;
        case 4: c2 += v; break;
        default: carrier += v;
      }
    }
    // OP2 (C1)
    eg = vol(s[2]);
    if (eg < ENV_QUIET) {
      const v = this.opCalc(s[2].phase, eg, c1);
      switch (ch.algo) {
        case 0: case 1: case 2: case 3: mem += v; break;
        default: carrier += v;
      }
    }
    // OP4 (C2)
    eg = vol(s[3]);
    if (eg < ENV_QUIET) carrier += this.opCalc(s[3].phase, eg, c2);
    ch.memValue = mem;
    for (let i = 0; i < 4; i++) s[i].phase = (s[i].phase + s[i].incr) >>> 0;
    return carrier;
  }

  opCalc(phase, env, pm) {
    const p = (env << 3) + sinTab[(((phase & ~FREQ_MASK) + (pm << 15)) >> FREQ_SH) & SIN_MASK];
    return p >= TL_TAB_LEN ? 0 : tlTab[p];
  }
  opCalc1(phase, env, pm) {
    const p = (env << 3) + sinTab[(((phase & ~FREQ_MASK) + pm) >> FREQ_SH) & SIN_MASK];
    return p >= TL_TAB_LEN ? 0 : tlTab[p];
  }
}
