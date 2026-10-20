/**
 * 生成应用图标 resources/icon.ico。
 * 用纯 Node 写 PNG/ICO 字节，避免引入图形库依赖。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'resources');
mkdirSync(outDir, { recursive: true });

/* ---------- 最小 PNG 编码器 ---------- */

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 生成 RGBA 的 PNG。 */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 绘制 ---------- */

/** 画一个圆角方形 + "BS" 字样的图标（B站粉渐变）。 */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const cx = size / 2;
  const cy = size / 2;

  // 圆角矩形的有符号距离
  const roundedRectSdf = (x, y) => {
    const hw = size / 2 - size * 0.04;
    const qx = Math.abs(x - cx) - (hw - radius);
    const qy = Math.abs(y - cy) - (hw - radius);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = roundedRectSdf(x + 0.5, y + 0.5);
      const alpha = Math.max(0, Math.min(1, 0.5 - d));

      // 对角渐变：#FB7299 -> #FF9DB8
      const t = (x / size + y / size) / 2;
      let r = Math.round(0xfb + (0xff - 0xfb) * t);
      let g = Math.round(0x72 + (0x9d - 0x72) * t);
      let b = Math.round(0x99 + (0xb8 - 0x99) * t);

      // 画字母 B
      const bx = (x - size * 0.5) / size;
      const by = (y - size * 0.5) / size;
      const letter = letterMask(bx, by);
      if (letter > 0) {
        r = Math.round(r * (1 - letter) + 255 * letter);
        g = Math.round(g * (1 - letter) + 255 * letter);
        b = Math.round(b * (1 - letter) + 255 * letter);
      }

      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

/** 返回字母 "B" 的覆盖度（0-1），坐标系为 -0.5..0.5。 */
function letterMask(x, y) {
  // 用几个简单形状拼出 B
  const stem = x > -0.16 && x < -0.06 && y > -0.2 && y < 0.2 ? 1 : 0;
  const upper = x > -0.06 && x < 0.12 && y > -0.2 && y < 0.0 ? 1 : 0;
  const lower = x > -0.06 && x < 0.12 && y > 0.0 && y < 0.2 ? 1 : 0;
  // 挖掉两个孔
  const hole =
    (x > 0.0 && x < 0.07 && y > -0.13 && y < -0.07) ||
    (x > 0.0 && x < 0.07 && y > 0.07 && y < 0.13);
  const all = stem || upper || lower;
  return all && !hole ? 1 : 0;
}

/* ---------- ICO 封装 ---------- */

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const images = SIZES.map((size) => ({
  size,
  png: encodePng(size, size, drawIcon(size)),
}));

// ICO 头
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;
for (const img of images) {
  const entry = Buffer.alloc(16);
  entry[0] = img.size >= 256 ? 0 : img.size; // width (0 = 256)
  entry[1] = img.size >= 256 ? 0 : img.size; // height
  entry[2] = 0; // 调色板
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(img.png.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += img.png.length;
}

const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
writeFileSync(join(outDir, 'icon.ico'), ico);

// 另外存一张 PNG，Linux/macOS 与文档用
writeFileSync(join(outDir, 'icon.png'), encodePng(256, 256, drawIcon(256)));

console.log('✓ 图标已生成: resources/icon.ico (%d 字节) / resources/icon.png', ico.length);
