// Rasterizes the app icon to PNG without dependencies (simple supersampled shapes).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const inRoundRect = (x, y, rx, ry, w, h, r) => {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r), cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const segDist = (px, py, ax, ay, bx, by) => {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
};
function color(x, y, full) {
  // coordinates in 512 space
  if (!full && !inRoundRect(x, y, 0, 0, 512, 512, 112)) return null;
  const a = (-12 * Math.PI) / 180, cx = 280, cy = 256;
  const rx = cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), ry = cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a);
  let c = [0x1d, 0x4e, 0xd8];
  if (inRoundRect(rx, ry, 150, 96, 260, 320, 36)) c = [0x93, 0xc5, 0xfd];
  if (inRoundRect(x, y, 102, 112, 260, 320, 36)) c = [255, 255, 255];
  if (Math.min(segDist(x, y, 168, 272, 220, 324), segDist(x, y, 220, 324, 316, 212)) <= 20) c = [0x16, 0xa3, 0x4a];
  return c;
}
function png(size, full) {
  const ss = 3, raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = color(((x + (sx + 0.5) / ss) / size) * 512, ((y + (sy + 0.5) / ss) / size) * 512, full);
        if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = n ? r / n : 0; raw[o + 1] = n ? g / n : 0; raw[o + 2] = n ? b / n : 0; raw[o + 3] = Math.round((n / (ss * ss)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync('public/icon-192.png', png(192, false));
writeFileSync('public/icon-512.png', png(512, true));
writeFileSync('public/apple-touch-icon.png', png(180, true));
