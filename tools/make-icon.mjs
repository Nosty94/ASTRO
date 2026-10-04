/* Генератор иконки для карточки Яндекс Игр (npm run assets).
   Исходная иконка игры — «бейдж» со скруглёнными углами и прозрачностью, а требования
   платформы (п.8.3.3) запрещают у иконки рамки и скруглённые углы: изображение должно
   заполнять квадрат целиком. Здесь исходник чуть увеличивается и композитится поверх
   фирменного фона игры, поэтому на выходе — полнокадровый квадрат 512×512 без альфы. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets', 'yandex');

/* ---------- PNG decode (RGBA / RGB / palette не нужны — исходник RGBA8) ---------- */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('не PNG');
  let pos = 8, idat = Buffer.alloc(0), w = 0, h = 0, depth = 0, ctype = 0;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    else if (type === 'IDAT') idat = Buffer.concat([idat, data]);
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('поддерживается только 8 бит/канал');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = zlib.inflateSync(idat), stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride)); p += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 255;
    }
    line.copy(out, y * stride);
  }
  return { w, h, ch, data: out };
}
/* ---------- PNG encode (RGB8, без альфы) ---------- */
function encodePng(w, h, rgb) {
  const stride = w * 3, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const chunks = [];
  const push = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    chunks.push(len, td, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  push('IHDR', ihdr);
  push('IDAT', zlib.deflateSync(raw, { level: 9 }));
  push('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) { CRC_TABLE = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC_TABLE[n] = c; } }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return c ^ -1;
}
const hx = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

function makeIcon(srcPath, size, scale) {
  const img = decodePng(fs.readFileSync(srcPath));
  const out = Buffer.alloc(size * size * 3);
  const A = hx('#1c2050'), B = hx('#0a0c22');      // фирменный фон игры (--bg-a / --bg-b)
  const sw = img.w * scale, sh = img.h * scale;
  const ox = (size - sw) / 2, oy = (size - sh) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(1, Math.hypot(x - size / 2, y - size / 2) / (size * 0.72));
      let r = A[0] + (B[0] - A[0]) * d, g = A[1] + (B[1] - A[1]) * d, b = A[2] + (B[2] - A[2]) * d;
      const sx = (x - ox) / scale, sy = (y - oy) / scale;
      if (sx >= 0 && sy >= 0 && sx < img.w - 1 && sy < img.h - 1) {
        const i = ((sy | 0) * img.w + (sx | 0)) * img.ch, a = img.ch === 4 ? img.data[i + 3] / 255 : 1;
        if (a > 0) { r = img.data[i] * a + r * (1 - a); g = img.data[i + 1] * a + g * (1 - a); b = img.data[i + 2] * a + b * (1 - a); }
      }
      const o = (y * size + x) * 3;
      out[o] = Math.round(r); out[o + 1] = Math.round(g); out[o + 2] = Math.round(b);
    }
  }
  return encodePng(size, size, out);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'icon-512.png'), makeIcon(path.join(ROOT, 'icon-512.png'), 512, 1.16));
fs.writeFileSync(path.join(OUT_DIR, 'icon-192.png'), makeIcon(path.join(ROOT, 'icon-192.png'), 192, 1.16));
console.log('готово:');
for (const f of fs.readdirSync(OUT_DIR)) {
  const st = fs.statSync(path.join(OUT_DIR, f));
  console.log('  assets/yandex/' + f + '  ' + (st.size / 1024).toFixed(1) + ' КБ');
}
