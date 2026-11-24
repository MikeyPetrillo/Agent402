// Image helpers the image routes share: the size a PNG or JPEG declares, read
// from its header without decoding, and a small real PNG built from pixels
// for published examples (a 300x300 white image with a red square in its
// lower right, columns 180-269 and rows 170-249), so no binary lives in the
// source.
import { deflateSync, crc32 as zlibCrc32 } from "node:zlib";

/** Width and height of a PNG or JPEG, or null. An animated PNG reads as null. */
export function imageSize(buf, format) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (format === "png") {
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    // An acTL chunk before the first IDAT marks an animated PNG.
    for (let off = 8; off + 8 <= buf.length;) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString("latin1", off + 4, off + 8);
      if (type === "acTL") return null;
      if (type === "IDAT") break;
      off += 12 + len;
    }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (format === "jpeg") {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    for (let off = 2; off + 9 < buf.length;) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }
  return null;
}

const crc32 = (buf) => zlibCrc32(buf) >>> 0;
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function examplePngBase64() {
  const W = 300, H = 300;
  const raw = Buffer.alloc((W * 3 + 1) * H, 255);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      if (x >= 180 && x < 270 && y >= 170 && y < 250) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = 220; raw[o + 1] = 40; raw[o + 2] = 40; }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
