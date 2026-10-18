// Zilog Z80 CPU core with cycle counts, enough for the Mega Drive sound CPU.
// Memory and I/O are callbacks: read(addr), write(addr, v).

const FLAG_C = 0x01;
const FLAG_N = 0x02;
const FLAG_PV = 0x04;
const FLAG_X = 0x08;
const FLAG_H = 0x10;
const FLAG_Y = 0x20;
const FLAG_Z = 0x40;
const FLAG_S = 0x80;

const SZ = new Uint8Array(256);
const SZP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let p = 0;
  for (let b = 0; b < 8; b++) p ^= (i >> b) & 1;
  SZ[i] = (i & 0x80) | (i === 0 ? FLAG_Z : 0) | (i & (FLAG_X | FLAG_Y));
  SZP[i] = SZ[i] | (p ? 0 : FLAG_PV);
}

// Base cycle counts
const CYC = [
  4, 10, 7, 6, 4, 4, 7, 4, 4, 11, 7, 6, 4, 4, 7, 4,
  8, 10, 7, 6, 4, 4, 7, 4, 12, 11, 7, 6, 4, 4, 7, 4,
  7, 10, 16, 6, 4, 4, 7, 4, 7, 11, 16, 6, 4, 4, 7, 4,
  7, 10, 13, 6, 11, 11, 10, 4, 7, 11, 13, 6, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  7, 7, 7, 7, 7, 7, 4, 7, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  5, 10, 10, 10, 10, 11, 7, 11, 5, 10, 10, 0, 10, 17, 7, 11,
  5, 10, 10, 11, 10, 11, 7, 11, 5, 4, 10, 11, 10, 0, 7, 11,
  5, 10, 10, 19, 10, 11, 7, 11, 5, 4, 10, 4, 10, 0, 7, 11,
  5, 10, 10, 4, 10, 11, 7, 11, 5, 6, 10, 4, 10, 0, 7, 11,
];

export class Z80 {
  constructor(read, write, inPort = () => 0xff, outPort = () => {}) {
    this.read = read;
    this.write = write;
    this.inPort = inPort;
    this.outPort = outPort;
    this.reset();
  }

  reset() {
    this.a = 0xff;
    this.f = 0xff;
    this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.a_ = this.f_ = this.b_ = this.c_ = this.d_ = this.e_ = this.h_ = this.l_ = 0;
    this.ix = this.iy = 0xffff;
    this.sp = 0xffff;
    this.pc = 0;
    this.i = 0;
    this.r = 0;
    this.iff1 = this.iff2 = 0;
    this.im = 0;
    this.halted = false;
    this.intLine = false;
    this.eiDelay = false;
    this.cycles = 0;
  }

  // ---------------------------------------------------------------- helpers
  rd16(a) {
    return this.read(a & 0xffff) | (this.read((a + 1) & 0xffff) << 8);
  }
  wr16(a, v) {
    this.write(a & 0xffff, v & 0xff);
    this.write((a + 1) & 0xffff, (v >> 8) & 0xff);
  }
  fetch() {
    const v = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }
  fetch16() {
    const v = this.rd16(this.pc);
    this.pc = (this.pc + 2) & 0xffff;
    return v;
  }
  fetchD() {
    const v = this.fetch();
    return v < 128 ? v : v - 256;
  }
  push(v) {
    this.sp = (this.sp - 2) & 0xffff;
    this.wr16(this.sp, v);
  }
  pop() {
    const v = this.rd16(this.sp);
    this.sp = (this.sp + 2) & 0xffff;
    return v;
  }
  get bc() {
    return (this.b << 8) | this.c;
  }
  set bc(v) {
    this.b = (v >> 8) & 0xff;
    this.c = v & 0xff;
  }
  get de() {
    return (this.d << 8) | this.e;
  }
  set de(v) {
    this.d = (v >> 8) & 0xff;
    this.e = v & 0xff;
  }
  get hl() {
    return (this.h << 8) | this.l;
  }
  set hl(v) {
    this.h = (v >> 8) & 0xff;
    this.l = v & 0xff;
  }
  get af() {
    return (this.a << 8) | this.f;
  }
  set af(v) {
    this.a = (v >> 8) & 0xff;
    this.f = v & 0xff;
  }

  // 8-bit register access by index (0-7: B C D E H L (HL) A); idx regs substitute H/L
  getR(i, mode) {
    switch (i) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return mode === 1 ? this.ix >> 8 : mode === 2 ? this.iy >> 8 : this.h;
      case 5: return mode === 1 ? this.ix & 0xff : mode === 2 ? this.iy & 0xff : this.l;
      case 6: return this.read(this.hl);
      default: return this.a;
    }
  }
  setR(i, v, mode) {
    v &= 0xff;
    switch (i) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4:
        if (mode === 1) this.ix = (this.ix & 0xff) | (v << 8);
        else if (mode === 2) this.iy = (this.iy & 0xff) | (v << 8);
        else this.h = v;
        break;
      case 5:
        if (mode === 1) this.ix = (this.ix & 0xff00) | v;
        else if (mode === 2) this.iy = (this.iy & 0xff00) | v;
        else this.l = v;
        break;
      case 6: this.write(this.hl, v); break;
      default: this.a = v;
    }
  }
  getRP(i, mode) {
    switch (i) {
      case 0: return this.bc;
      case 1: return this.de;
      case 2: return mode === 1 ? this.ix : mode === 2 ? this.iy : this.hl;
      default: return this.sp;
    }
  }
  setRP(i, v, mode) {
    v &= 0xffff;
    switch (i) {
      case 0: this.bc = v; break;
      case 1: this.de = v; break;
      case 2:
        if (mode === 1) this.ix = v;
        else if (mode === 2) this.iy = v;
        else this.hl = v;
        break;
      default: this.sp = v;
    }
  }
  getRP2(i, mode) {
    return i === 3 ? this.af : this.getRP(i, mode);
  }
  setRP2(i, v, mode) {
    if (i === 3) this.af = v & 0xffff;
    else this.setRP(i, v, mode);
  }

  // ---------------------------------------------------------------- ALU
  add8(v, carry = 0) {
    const a = this.a;
    const r = a + v + carry;
    this.f = SZ[r & 0xff] | ((r >> 8) & FLAG_C) | ((a ^ v ^ r) & FLAG_H) | ((((a ^ ~v) & (a ^ r)) >> 5) & FLAG_PV);
    this.a = r & 0xff;
  }
  sub8(v, carry = 0, store = true) {
    const a = this.a;
    const r = a - v - carry;
    this.f = SZ[r & 0xff] | ((r >> 8) & FLAG_C) | FLAG_N | ((a ^ v ^ r) & FLAG_H) | ((((a ^ v) & (a ^ r)) >> 5) & FLAG_PV);
    if (store) this.a = r & 0xff;
    else this.f = (this.f & ~(FLAG_X | FLAG_Y)) | (v & (FLAG_X | FLAG_Y));
  }
  and8(v) {
    this.a &= v;
    this.f = SZP[this.a] | FLAG_H;
  }
  xor8(v) {
    this.a = (this.a ^ v) & 0xff;
    this.f = SZP[this.a];
  }
  or8(v) {
    this.a = (this.a | v) & 0xff;
    this.f = SZP[this.a];
  }
  alu(op, v) {
    switch (op) {
      case 0: return this.add8(v);
      case 1: return this.add8(v, this.f & FLAG_C);
      case 2: return this.sub8(v);
      case 3: return this.sub8(v, this.f & FLAG_C);
      case 4: return this.and8(v);
      case 5: return this.xor8(v);
      case 6: return this.or8(v);
      default: return this.sub8(v, 0, false);
    }
  }
  inc8(v) {
    const r = (v + 1) & 0xff;
    this.f = (this.f & FLAG_C) | SZ[r] | (r === 0x80 ? FLAG_PV : 0) | ((r & 0x0f) === 0 ? FLAG_H : 0);
    return r;
  }
  dec8(v) {
    const r = (v - 1) & 0xff;
    this.f = (this.f & FLAG_C) | SZ[r] | FLAG_N | (r === 0x7f ? FLAG_PV : 0) | ((r & 0x0f) === 0x0f ? FLAG_H : 0);
    return r;
  }
  add16(a, b) {
    const r = a + b;
    this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | ((r >> 16) & FLAG_C) | (((a ^ b ^ r) >> 8) & FLAG_H) | ((r >> 8) & (FLAG_X | FLAG_Y));
    return r & 0xffff;
  }
  adc16(v) {
    const hl = this.hl;
    const r = hl + v + (this.f & FLAG_C);
    this.f = ((r >> 8) & (FLAG_S | FLAG_X | FLAG_Y)) | ((r & 0xffff) === 0 ? FLAG_Z : 0) | ((r >> 16) & FLAG_C) |
      (((hl ^ v ^ r) >> 8) & FLAG_H) | ((((hl ^ ~v) & (hl ^ r)) >> 13) & FLAG_PV);
    this.hl = r & 0xffff;
  }
  sbc16(v) {
    const hl = this.hl;
    const r = hl - v - (this.f & FLAG_C);
    this.f = ((r >> 8) & (FLAG_S | FLAG_X | FLAG_Y)) | ((r & 0xffff) === 0 ? FLAG_Z : 0) | ((r >> 16) & FLAG_C) | FLAG_N |
      (((hl ^ v ^ r) >> 8) & FLAG_H) | ((((hl ^ v) & (hl ^ r)) >> 13) & FLAG_PV);
    this.hl = r & 0xffff;
  }
  rot(op, v) {
    let r;
    let c;
    switch (op) {
      case 0: c = v >> 7; r = ((v << 1) | c) & 0xff; break; // RLC
      case 1: c = v & 1; r = ((v >> 1) | (c << 7)) & 0xff; break; // RRC
      case 2: c = v >> 7; r = ((v << 1) | (this.f & FLAG_C)) & 0xff; break; // RL
      case 3: c = v & 1; r = ((v >> 1) | ((this.f & FLAG_C) << 7)) & 0xff; break; // RR
      case 4: c = v >> 7; r = (v << 1) & 0xff; break; // SLA
      case 5: c = v & 1; r = ((v >> 1) | (v & 0x80)) & 0xff; break; // SRA
      case 6: c = v >> 7; r = ((v << 1) | 1) & 0xff; break; // SLL
      default: c = v & 1; r = v >> 1; // SRL
    }
    this.f = SZP[r] | c;
    return r;
  }
  cond(cc) {
    switch (cc) {
      case 0: return !(this.f & FLAG_Z);
      case 1: return !!(this.f & FLAG_Z);
      case 2: return !(this.f & FLAG_C);
      case 3: return !!(this.f & FLAG_C);
      case 4: return !(this.f & FLAG_PV);
      case 5: return !!(this.f & FLAG_PV);
      case 6: return !(this.f & FLAG_S);
      default: return !!(this.f & FLAG_S);
    }
  }

  // ---------------------------------------------------------------- execution
  irq() {
    if (!this.iff1 || this.eiDelay) return 0;
    if (this.halted) {
      this.halted = false;
      this.pc = (this.pc + 1) & 0xffff;
    }
    this.iff1 = this.iff2 = 0;
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
    if (this.im === 2) {
      this.push(this.pc);
      this.pc = this.rd16((this.i << 8) | 0xff);
      return 19;
    }
    this.push(this.pc);
    this.pc = 0x38;
    return 13;
  }

  // Run at least n cycles; returns cycles actually run.
  run(n) {
    let done = 0;
    while (done < n) {
      if (this.intLine && this.iff1 && !this.eiDelay) done += this.irq();
      this.eiDelay = false;
      if (this.halted) {
        done += 4;
        continue;
      }
      done += this.step();
    }
    this.cycles += done;
    return done;
  }

  step() {
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
    const op = this.fetch();
    switch (op) {
      case 0xcb:
        return this.execCB();
      case 0xed:
        return this.execED();
      case 0xdd:
        return this.execIndex(1);
      case 0xfd:
        return this.execIndex(2);
      default:
        return this.exec(op, 0);
    }
  }

  // Main opcode table. mode: 0 = HL, 1 = IX, 2 = IY (for DD/FD prefixed ops).
  exec(op, mode) {
    let cyc = CYC[op];
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    // index-mode memory operand (HL) -> (IX+d)
    const memAddr = () => {
      if (mode === 0) return this.hl;
      const d = this.fetchD();
      cyc += 8;
      return ((mode === 1 ? this.ix : this.iy) + d) & 0xffff;
    };
    if (x === 1) {
      if (op === 0x76) {
        this.halted = true;
        this.pc = (this.pc - 1) & 0xffff;
        return 4;
      }
      if (z === 6) {
        const a = memAddr();
        this.setR(y, this.read(a), 0);
      } else if (y === 6) {
        const a = memAddr();
        this.write(a, this.getR(z, 0));
      } else this.setR(y, this.getR(z, mode), mode);
      return cyc;
    }
    if (x === 2) {
      if (z === 6) this.alu(y, this.read(memAddr()));
      else this.alu(y, this.getR(z, mode));
      return cyc;
    }
    switch (op) {
      case 0x00: return cyc;
      case 0x01: case 0x11: case 0x21: case 0x31:
        this.setRP(y >> 1, this.fetch16(), mode);
        return cyc;
      case 0x02: this.write(this.bc, this.a); return cyc;
      case 0x12: this.write(this.de, this.a); return cyc;
      case 0x22: this.wr16(this.fetch16(), this.getRP(2, mode)); return cyc;
      case 0x32: this.write(this.fetch16(), this.a); return cyc;
      case 0x0a: this.a = this.read(this.bc); return cyc;
      case 0x1a: this.a = this.read(this.de); return cyc;
      case 0x2a: this.setRP(2, this.rd16(this.fetch16()), mode); return cyc;
      case 0x3a: this.a = this.read(this.fetch16()); return cyc;
      case 0x03: case 0x13: case 0x23: case 0x33:
        this.setRP(y >> 1, this.getRP(y >> 1, mode) + 1, mode);
        return cyc;
      case 0x0b: case 0x1b: case 0x2b: case 0x3b:
        this.setRP(y >> 1, this.getRP(y >> 1, mode) - 1, mode);
        return cyc;
      case 0x09: case 0x19: case 0x29: case 0x39: {
        const hl = this.getRP(2, mode);
        this.setRP(2, this.add16(hl, this.getRP(y >> 1, mode)), mode);
        return cyc;
      }
      case 0x04: case 0x0c: case 0x14: case 0x1c: case 0x24: case 0x2c: case 0x3c:
        this.setR(y, this.inc8(this.getR(y, mode)), mode);
        return cyc;
      case 0x05: case 0x0d: case 0x15: case 0x1d: case 0x25: case 0x2d: case 0x3d:
        this.setR(y, this.dec8(this.getR(y, mode)), mode);
        return cyc;
      case 0x34: {
        const a = memAddr();
        if (mode) cyc -= 0; // (IX+d) inc is 23 total
        this.write(a, this.inc8(this.read(a)));
        return cyc;
      }
      case 0x35: {
        const a = memAddr();
        this.write(a, this.dec8(this.read(a)));
        return cyc;
      }
      case 0x06: case 0x0e: case 0x16: case 0x1e: case 0x26: case 0x2e: case 0x3e:
        this.setR(y, this.fetch(), mode);
        return cyc;
      case 0x36: {
        const a = memAddr();
        if (mode) cyc -= 3; // LD (IX+d),n is 19
        this.write(a, this.fetch());
        return cyc;
      }
      case 0x07: {
        const c = this.a >> 7;
        this.a = ((this.a << 1) | c) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | c | (this.a & (FLAG_X | FLAG_Y));
        return cyc;
      }
      case 0x0f: {
        const c = this.a & 1;
        this.a = ((this.a >> 1) | (c << 7)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | c | (this.a & (FLAG_X | FLAG_Y));
        return cyc;
      }
      case 0x17: {
        const c = this.a >> 7;
        this.a = ((this.a << 1) | (this.f & FLAG_C)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | c | (this.a & (FLAG_X | FLAG_Y));
        return cyc;
      }
      case 0x1f: {
        const c = this.a & 1;
        this.a = ((this.a >> 1) | ((this.f & FLAG_C) << 7)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | c | (this.a & (FLAG_X | FLAG_Y));
        return cyc;
      }
      case 0x08: {
        let t = this.a; this.a = this.a_; this.a_ = t;
        t = this.f; this.f = this.f_; this.f_ = t;
        return cyc;
      }
      case 0x10: {
        this.b = (this.b - 1) & 0xff;
        const d = this.fetchD();
        if (this.b) {
          this.pc = (this.pc + d) & 0xffff;
          return 13;
        }
        return 8;
      }
      case 0x18: {
        const d = this.fetchD();
        this.pc = (this.pc + d) & 0xffff;
        return cyc;
      }
      case 0x20: case 0x28: case 0x30: case 0x38: {
        const d = this.fetchD();
        if (this.cond(y - 4)) {
          this.pc = (this.pc + d) & 0xffff;
          return 12;
        }
        return 7;
      }
      case 0x27: {
        // DAA
        let a = this.a;
        let corr = 0;
        let carry = this.f & FLAG_C;
        if (this.f & FLAG_H || (a & 0x0f) > 9) corr |= 0x06;
        if (carry || a > 0x99) {
          corr |= 0x60;
          carry = FLAG_C;
        }
        let h;
        if (this.f & FLAG_N) {
          h = this.f & FLAG_H && (a & 0x0f) < 6 ? FLAG_H : 0;
          a = (a - corr) & 0xff;
        } else {
          h = (a & 0x0f) > 9 ? FLAG_H : 0;
          a = (a + corr) & 0xff;
        }
        this.a = a;
        this.f = SZP[a] | carry | h | (this.f & FLAG_N);
        return cyc;
      }
      case 0x2f:
        this.a ^= 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV | FLAG_C)) | FLAG_H | FLAG_N | (this.a & (FLAG_X | FLAG_Y));
        return cyc;
      case 0x37:
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | FLAG_C | (this.a & (FLAG_X | FLAG_Y));
        return cyc;
      case 0x3f: {
        const c = this.f & FLAG_C;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (c ? FLAG_H : FLAG_C) | (this.a & (FLAG_X | FLAG_Y));
        return cyc;
      }
      // x = 3
      case 0xc0: case 0xc8: case 0xd0: case 0xd8: case 0xe0: case 0xe8: case 0xf0: case 0xf8:
        if (this.cond(y)) {
          this.pc = this.pop();
          return 11;
        }
        return 5;
      case 0xc1: case 0xd1: case 0xe1: case 0xf1:
        this.setRP2(y >> 1, this.pop(), mode);
        return cyc;
      case 0xc9:
        this.pc = this.pop();
        return cyc;
      case 0xd9: {
        let t;
        t = this.b; this.b = this.b_; this.b_ = t;
        t = this.c; this.c = this.c_; this.c_ = t;
        t = this.d; this.d = this.d_; this.d_ = t;
        t = this.e; this.e = this.e_; this.e_ = t;
        t = this.h; this.h = this.h_; this.h_ = t;
        t = this.l; this.l = this.l_; this.l_ = t;
        return cyc;
      }
      case 0xe9:
        this.pc = this.getRP(2, mode);
        return cyc;
      case 0xf9:
        this.sp = this.getRP(2, mode);
        return cyc;
      case 0xc2: case 0xca: case 0xd2: case 0xda: case 0xe2: case 0xea: case 0xf2: case 0xfa: {
        const a = this.fetch16();
        if (this.cond(y)) this.pc = a;
        return cyc;
      }
      case 0xc3:
        this.pc = this.fetch16();
        return cyc;
      case 0xd3:
        this.outPort((this.a << 8) | this.fetch(), this.a);
        return cyc;
      case 0xdb:
        this.a = this.inPort((this.a << 8) | this.fetch());
        return cyc;
      case 0xe3: {
        const v = this.rd16(this.sp);
        this.wr16(this.sp, this.getRP(2, mode));
        this.setRP(2, v, mode);
        return cyc;
      }
      case 0xeb: {
        let t = this.d; this.d = this.h; this.h = t;
        t = this.e; this.e = this.l; this.l = t;
        return cyc;
      }
      case 0xf3:
        this.iff1 = this.iff2 = 0;
        return cyc;
      case 0xfb:
        this.iff1 = this.iff2 = 1;
        this.eiDelay = true;
        return cyc;
      case 0xc4: case 0xcc: case 0xd4: case 0xdc: case 0xe4: case 0xec: case 0xf4: case 0xfc: {
        const a = this.fetch16();
        if (this.cond(y)) {
          this.push(this.pc);
          this.pc = a;
          return 17;
        }
        return 10;
      }
      case 0xc5: case 0xd5: case 0xe5: case 0xf5:
        this.push(this.getRP2(y >> 1, mode));
        return cyc;
      case 0xcd: {
        const a = this.fetch16();
        this.push(this.pc);
        this.pc = a;
        return cyc;
      }
      case 0xc6: case 0xce: case 0xd6: case 0xde: case 0xe6: case 0xee: case 0xf6: case 0xfe:
        this.alu(y, this.fetch());
        return cyc;
      case 0xc7: case 0xcf: case 0xd7: case 0xdf: case 0xe7: case 0xef: case 0xf7: case 0xff:
        this.push(this.pc);
        this.pc = y * 8;
        return cyc;
    }
    return cyc;
  }

  execCB() {
    const op = this.fetch();
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    const v = this.getR(z, 0);
    let cyc = z === 6 ? 15 : 8;
    if (x === 0) this.setR(z, this.rot(y, v), 0);
    else if (x === 1) {
      const bit = v & (1 << y);
      this.f = (this.f & FLAG_C) | FLAG_H | (bit ? bit & FLAG_S : FLAG_Z | FLAG_PV) | (v & (FLAG_X | FLAG_Y));
      if (z === 6) cyc = 12;
    } else if (x === 2) this.setR(z, v & ~(1 << y), 0);
    else this.setR(z, v | (1 << y), 0);
    return cyc;
  }

  // DDCB/FDCB d op
  execIndexCB(mode) {
    const d = this.fetchD();
    const op = this.fetch();
    const addr = ((mode === 1 ? this.ix : this.iy) + d) & 0xffff;
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    const v = this.read(addr);
    let r;
    if (x === 1) {
      const bit = v & (1 << y);
      this.f = (this.f & FLAG_C) | FLAG_H | (bit ? bit & FLAG_S : FLAG_Z | FLAG_PV) | ((addr >> 8) & (FLAG_X | FLAG_Y));
      return 20;
    }
    if (x === 0) r = this.rot(y, v);
    else if (x === 2) r = v & ~(1 << y);
    else r = v | (1 << y);
    this.write(addr, r);
    if (z !== 6) this.setR(z, r, 0);
    return 23;
  }

  execIndex(mode) {
    const op = this.fetch();
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
    if (op === 0xcb) return this.execIndexCB(mode);
    if (op === 0xdd) return this.execIndex(1) + 4;
    if (op === 0xfd) return this.execIndex(2) + 4;
    if (op === 0xed) return this.execED() + 4;
    // ops that use H/L/(HL) get the index register; others behave as unprefixed
    return this.exec(op, mode) + 4;
  }

  execED() {
    const op = this.fetch();
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
    const y = (op >> 3) & 7;
    switch (op) {
      case 0x40: case 0x48: case 0x50: case 0x58: case 0x60: case 0x68: case 0x70: case 0x78: {
        const v = this.inPort(this.bc);
        if (y !== 6) this.setR(y, v, 0);
        this.f = (this.f & FLAG_C) | SZP[v];
        return 12;
      }
      case 0x41: case 0x49: case 0x51: case 0x59: case 0x61: case 0x69: case 0x71: case 0x79:
        this.outPort(this.bc, y === 6 ? 0 : this.getR(y, 0));
        return 12;
      case 0x42: case 0x52: case 0x62: case 0x72:
        this.sbc16(this.getRP(y >> 1, 0));
        return 15;
      case 0x4a: case 0x5a: case 0x6a: case 0x7a:
        this.adc16(this.getRP(y >> 1, 0));
        return 15;
      case 0x43: case 0x53: case 0x63: case 0x73:
        this.wr16(this.fetch16(), this.getRP(y >> 1, 0));
        return 20;
      case 0x4b: case 0x5b: case 0x6b: case 0x7b:
        this.setRP(y >> 1, this.rd16(this.fetch16()), 0);
        return 20;
      case 0x44: case 0x4c: case 0x54: case 0x5c: case 0x64: case 0x6c: case 0x74: case 0x7c: {
        const v = this.a;
        this.a = 0;
        this.sub8(v);
        return 8;
      }
      case 0x45: case 0x55: case 0x5d: case 0x65: case 0x6d: case 0x75: case 0x7d:
        this.iff1 = this.iff2;
        this.pc = this.pop();
        return 14;
      case 0x4d:
        this.pc = this.pop();
        return 14;
      case 0x46: case 0x4e: case 0x66: case 0x6e:
        this.im = 0;
        return 8;
      case 0x56: case 0x76:
        this.im = 1;
        return 8;
      case 0x5e: case 0x7e:
        this.im = 2;
        return 8;
      case 0x47:
        this.i = this.a;
        return 9;
      case 0x4f:
        this.r = this.a;
        return 9;
      case 0x57:
        this.a = this.i;
        this.f = (this.f & FLAG_C) | SZ[this.a] | (this.iff2 ? FLAG_PV : 0);
        return 9;
      case 0x5f:
        this.a = this.r;
        this.f = (this.f & FLAG_C) | SZ[this.a] | (this.iff2 ? FLAG_PV : 0);
        return 9;
      case 0x67: {
        const m = this.read(this.hl);
        this.write(this.hl, ((m >> 4) | (this.a << 4)) & 0xff);
        this.a = (this.a & 0xf0) | (m & 0x0f);
        this.f = (this.f & FLAG_C) | SZP[this.a];
        return 18;
      }
      case 0x6f: {
        const m = this.read(this.hl);
        this.write(this.hl, ((m << 4) | (this.a & 0x0f)) & 0xff);
        this.a = (this.a & 0xf0) | (m >> 4);
        this.f = (this.f & FLAG_C) | SZP[this.a];
        return 18;
      }
      // block transfer
      case 0xa0: case 0xa8: case 0xb0: case 0xb8: {
        const v = this.read(this.hl);
        this.write(this.de, v);
        const inc = op & 8 ? -1 : 1;
        this.hl = (this.hl + inc) & 0xffff;
        this.de = (this.de + inc) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        const n = (v + this.a) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_C)) | (this.bc ? FLAG_PV : 0) | (n & FLAG_X) | ((n << 4) & FLAG_Y);
        if (op >= 0xb0 && this.bc) {
          this.pc = (this.pc - 2) & 0xffff;
          return 21;
        }
        return 16;
      }
      case 0xa1: case 0xa9: case 0xb1: case 0xb9: {
        const v = this.read(this.hl);
        const r = (this.a - v) & 0xff;
        const inc = op & 8 ? -1 : 1;
        this.hl = (this.hl + inc) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        this.f = (this.f & FLAG_C) | (SZ[r] & ~(FLAG_X | FLAG_Y)) | FLAG_N | ((this.a ^ v ^ r) & FLAG_H) | (this.bc ? FLAG_PV : 0);
        if (op >= 0xb0 && this.bc && r !== 0) {
          this.pc = (this.pc - 2) & 0xffff;
          return 21;
        }
        return 16;
      }
      case 0xa2: case 0xaa: case 0xb2: case 0xba: {
        const v = this.inPort(this.bc);
        this.write(this.hl, v);
        this.hl = (this.hl + (op & 8 ? -1 : 1)) & 0xffff;
        this.b = (this.b - 1) & 0xff;
        this.f = SZ[this.b] | FLAG_N;
        if (op >= 0xb0 && this.b) {
          this.pc = (this.pc - 2) & 0xffff;
          return 21;
        }
        return 16;
      }
      case 0xa3: case 0xab: case 0xb3: case 0xbb: {
        const v = this.read(this.hl);
        this.b = (this.b - 1) & 0xff;
        this.outPort(this.bc, v);
        this.hl = (this.hl + (op & 8 ? -1 : 1)) & 0xffff;
        this.f = SZ[this.b] | FLAG_N;
        if (op >= 0xb0 && this.b) {
          this.pc = (this.pc - 2) & 0xffff;
          return 21;
        }
        return 16;
      }
    }
    return 8;
  }
}
