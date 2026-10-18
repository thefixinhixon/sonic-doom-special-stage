// SN76489 PSG as found in the Mega Drive (Sega variant noise generator).

const VOLUMES = new Float32Array(16);
for (let i = 0; i < 15; i++) VOLUMES[i] = Math.pow(10, (-2 * i) / 20);
VOLUMES[15] = 0;

export class SN76489 {
  constructor(clock = 3579545) {
    this.clock = clock;
    this.reg = new Uint16Array(8); // tone0, vol0, tone1, vol1, tone2, vol2, noise, vol3
    this.reg[1] = this.reg[3] = this.reg[5] = this.reg[7] = 15;
    this.latch = 0;
    this.counter = new Float64Array(4);
    this.output = new Int8Array([1, 1, 1, 1]);
    this.lfsr = 0x8000;
  }

  write(v) {
    v &= 0xff;
    if (v & 0x80) {
      this.latch = (v >> 4) & 7;
      if (this.latch & 1 || this.latch === 6) {
        this.reg[this.latch] = (this.reg[this.latch] & 0x3f0) | (v & 0x0f);
        if (this.latch === 6) {
          this.reg[6] = v & 7;
          this.lfsr = 0x8000;
        }
      } else this.reg[this.latch] = (this.reg[this.latch] & 0x3f0) | (v & 0x0f);
    } else {
      if (this.latch & 1 || this.latch === 6) {
        if (this.latch === 6) {
          this.reg[6] = v & 7;
          this.lfsr = 0x8000;
        } else this.reg[this.latch] = v & 0x0f;
      } else this.reg[this.latch] = (this.reg[this.latch] & 0x0f) | ((v & 0x3f) << 4);
    }
  }

  // Render n samples at `rate`, adding into out (mono, scaled ~[-1,1]).
  render(out, offset, n, rate) {
    const step = this.clock / 16 / rate;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < 3; c++) {
        const period = this.reg[c * 2] || 1;
        this.counter[c] -= step;
        while (this.counter[c] <= 0) {
          this.counter[c] += period;
          this.output[c] = -this.output[c];
        }
        // periods 0/1 output a flat level on hardware
        s += (period <= 1 ? 1 : this.output[c]) * VOLUMES[this.reg[c * 2 + 1] & 15];
      }
      const nr = this.reg[6];
      const np = (nr & 3) === 3 ? this.reg[4] || 1 : 0x10 << (nr & 3);
      this.counter[3] -= step;
      while (this.counter[3] <= 0) {
        this.counter[3] += np;
        this.output[3] = -this.output[3];
        if (this.output[3] > 0) {
          const fb = nr & 4 ? ((this.lfsr & 1) ^ ((this.lfsr >> 3) & 1)) : this.lfsr & 1;
          this.lfsr = (this.lfsr >> 1) | (fb << 15);
        }
      }
      s += (this.lfsr & 1 ? 1 : -1) * VOLUMES[this.reg[7] & 15];
      out[offset + i] += s * 0.12;
    }
  }
}
