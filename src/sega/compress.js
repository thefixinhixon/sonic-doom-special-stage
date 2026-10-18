// Decompressors for the formats Sonic 2 stores its data in.
// All take a Uint8Array (usually the ROM) and a start offset.

// Kosinski: LZSS with 16-bit little-endian descriptor fields.
export function kosinski(src, pos) {
  const out = [];
  let desc = src[pos] | (src[pos + 1] << 8);
  pos += 2;
  let bits = 16;
  const bit = () => {
    const b = desc & 1;
    desc >>>= 1;
    if (--bits === 0) {
      desc = src[pos] | (src[pos + 1] << 8);
      pos += 2;
      bits = 16;
    }
    return b;
  };
  for (;;) {
    if (bit()) {
      out.push(src[pos++]);
      continue;
    }
    let count, offset;
    if (bit()) {
      const lo = src[pos++];
      const hi = src[pos++];
      offset = (((hi & 0xf8) << 5) | lo) - 0x2000;
      count = hi & 7;
      if (count === 0) {
        count = src[pos++];
        if (count === 0) break;
        if (count === 1) continue;
        count += 1;
      } else {
        count += 2;
      }
    } else {
      count = (bit() << 1) | bit();
      count += 2;
      offset = src[pos++] - 0x100;
    }
    const start = out.length + offset;
    for (let i = 0; i < count; i++) out.push(out[start + i]);
  }
  return Uint8Array.from(out);
}

// Nemesis: Huffman-coded nibble runs, optionally XOR-delta encoded per row.
// Output is raw 4bpp tile data (32 bytes per 8x8 tile).
export function nemesis(src, pos) {
  const header = (src[pos] << 8) | src[pos + 1];
  pos += 2;
  const xorMode = (header & 0x8000) !== 0;
  const tiles = header & 0x7fff;
  const codeTable = new Map(); // key: (len<<8)|code -> {nib, cnt}
  let b = src[pos++];
  let nib = 0;
  while (b !== 0xff) {
    if (b & 0x80) {
      nib = b & 0x0f;
      b = src[pos++];
    }
    const cnt = ((b & 0x70) >> 4) + 1;
    const len = b & 0x0f;
    const code = src[pos++];
    codeTable.set((len << 8) | code, { nib, cnt });
    b = src[pos++];
  }

  let bitBuf = 0;
  let bitCnt = 0;
  const readBit = () => {
    if (bitCnt === 0) {
      bitBuf = src[pos++];
      bitCnt = 8;
    }
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  };
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  };

  const totalRows = tiles * 8;
  const out = new Uint8Array(tiles * 32);
  let row = 0;
  let rowVal = 0;
  let prevRow = 0;
  let nibInRow = 0;
  const emit = (n) => {
    rowVal = ((rowVal << 4) | n) >>> 0;
    if (++nibInRow === 8) {
      let v = rowVal;
      if (xorMode) v = (v ^ prevRow) >>> 0;
      prevRow = v;
      const o = row * 4;
      out[o] = v >>> 24;
      out[o + 1] = (v >>> 16) & 0xff;
      out[o + 2] = (v >>> 8) & 0xff;
      out[o + 3] = v & 0xff;
      row++;
      rowVal = 0;
      nibInRow = 0;
    }
  };

  while (row < totalRows) {
    let code = 0;
    let len = 0;
    let entry = null;
    while (len < 8) {
      code = (code << 1) | readBit();
      len++;
      if (len === 6 && code === 0x3f) break;
      entry = codeTable.get((len << 8) | code);
      if (entry) break;
    }
    let cnt, n;
    if (entry) {
      cnt = entry.cnt;
      n = entry.nib;
    } else {
      cnt = readBits(3) + 1;
      n = readBits(4);
    }
    for (let i = 0; i < cnt && row < totalRows; i++) emit(n);
  }
  return out;
}

// Enigma: compressed plane mappings. Returns an array of 16-bit pattern names.
export function enigma(src, pos, baseTile = 0) {
  const packetLen = src[pos];
  const mask = src[pos + 1];
  let inc = ((src[pos + 2] << 8) | src[pos + 3]) + baseTile;
  const common = ((src[pos + 4] << 8) | src[pos + 5]) + baseTile;
  pos += 6;
  let bitBuf = 0;
  let bitCnt = 0;
  const readBit = () => {
    if (bitCnt === 0) {
      bitBuf = src[pos++];
      bitCnt = 8;
    }
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  };
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  };
  const inline = () => {
    let v = 0;
    if (mask & 0x10) v |= readBit() << 15;
    if (mask & 0x08) v |= readBit() << 14;
    if (mask & 0x04) v |= readBit() << 13;
    if (mask & 0x02) v |= readBit() << 12;
    if (mask & 0x01) v |= readBit() << 11;
    v |= readBits(packetLen);
    return (v + baseTile) & 0xffff;
  };
  const out = [];
  for (;;) {
    let type;
    if (readBit()) type = 4 | readBits(2);
    else type = readBit();
    const count = readBits(4) + 1;
    switch (type) {
      case 0:
        for (let i = 0; i < count; i++) out.push(inc++ & 0xffff);
        break;
      case 1:
        for (let i = 0; i < count; i++) out.push(common & 0xffff);
        break;
      case 4: {
        const v = inline();
        for (let i = 0; i < count; i++) out.push(v);
        break;
      }
      case 5: {
        let v = inline();
        for (let i = 0; i < count; i++) out.push(v++ & 0xffff);
        break;
      }
      case 6: {
        let v = inline();
        for (let i = 0; i < count; i++) out.push(v-- & 0xffff);
        break;
      }
      case 7:
        if (count === 16) return Uint16Array.from(out);
        for (let i = 0; i < count; i++) out.push(inline());
        break;
    }
  }
}

// Saxman: LZSS variant used for the Z80 sound driver and music.
export function saxman(src, pos, size) {
  const end = pos + size;
  const out = [];
  let desc = 0;
  while (pos < end) {
    desc >>>= 1;
    if (!(desc & 0x100)) {
      if (pos >= end) break;
      desc = src[pos++] | 0xff00;
    }
    if (desc & 1) {
      if (pos >= end) break;
      out.push(src[pos++]);
      continue;
    }
    if (pos + 1 >= end + 1) break;
    const lo = src[pos++];
    const hi = src[pos++];
    const count = (hi & 0x0f) + 3;
    let offset = (((hi & 0xf0) << 4) | lo) + 0x12;
    offset &= 0xfff;
    const len = out.length;
    offset += len & 0xf000;
    if (offset > len) offset -= 0x1000;
    if (offset < 0) {
      for (let i = 0; i < count; i++) out.push(0);
    } else {
      for (let i = 0; i < count; i++) out.push(out[offset + i] ?? 0);
    }
  }
  return Uint8Array.from(out);
}
