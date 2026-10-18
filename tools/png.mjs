// Minimal PNG writer for headless render tests.
import zlib from 'node:zlib';
import fs from 'node:fs';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// rgba: Uint8Array/Uint8ClampedArray of w*h*4
export function writePNG(path, w, h, rgba, scale = 1) {
  const sw = w * scale;
  const sh = h * scale;
  const raw = Buffer.alloc((sw * 4 + 1) * sh);
  for (let y = 0; y < sh; y++) {
    raw[y * (sw * 4 + 1)] = 0;
    for (let x = 0; x < sw; x++) {
      const s = ((((y / scale) | 0) * w) + ((x / scale) | 0)) * 4;
      const d = y * (sw * 4 + 1) + 1 + x * 4;
      raw[d] = rgba[s];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + 2];
      raw[d + 3] = rgba[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(sw, 0);
  ihdr.writeUInt32BE(sh, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.writeFileSync(
    path,
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  );
}
