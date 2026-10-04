/* Сборка архива для загрузки в консоль Яндекс Игр (npm run build).
   В архив попадает только то, что нужно самой игре: index.html в корне + иконки, на
   которые он ссылается. Карточные иконки/обложка лежат отдельно в assets/yandex/ и
   загружаются в консоль вручную. Архив проверяется на требования п.1.21/п.1.22. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
fs.mkdirSync(OUT, { recursive: true });

const files = [
  ['index.html', path.join(ROOT, 'index.html')],
  ['manifest.webmanifest', path.join(ROOT, 'manifest.webmanifest')],
  ['icon-192.png', path.join(ROOT, 'icon-192.png')],
  ['icon-512.png', path.join(ROOT, 'icon-512.png')],
];

/* ---------- валидация перед упаковкой ---------- */
let total = 0, ok = true;
for (const [name, p] of files) {
  if (!fs.existsSync(p)) { console.log('✗ отсутствует файл: ' + name); ok = false; continue; }
  const sz = fs.statSync(p).size; total += sz;
  if (/[^\x20-\x7e]/.test(name) || /\s/.test(name)) { console.log('✗ имя файла с пробелами/кириллицей: ' + name); ok = false; }
}
if (total > 100 * 1024 * 1024) { console.log('✗ размер > 100 МБ'); ok = false; }
if (!ok) process.exit(1);
console.log('файлов: ' + files.length + ', суммарно ' + (total / 1024).toFixed(0) + ' КБ (< 100 МБ) ✓');

/* ---------- ZIP (метод 8, deflate) ---------- */
function crc32(buf) {
  const T = crc32.T || (crc32.T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })());
  let c = -1; for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
const locals = [], centrals = [];
let offset = 0;
for (const [name, p] of files) {
  const data = fs.readFileSync(p);
  const crc = crc32(data);
  const def = zlib.deflateRawSync(data, { level: 9 });
  const nameB = Buffer.from(name, 'utf8');
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(8), u16(dosTime), u16(dosDate), u32(crc), u32(def.length), u32(data.length), u16(nameB.length), u16(0),
    nameB, def,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(dosTime), u16(dosDate), u32(crc), u32(def.length), u32(data.length),
    u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB,
  ]);
  locals.push(local); centrals.push(central);
  offset += local.length;
}
const centralBuf = Buffer.concat(centrals);
const eocd = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralBuf.length), u32(offset), u16(0),
]);
const zip = Buffer.concat([...locals, centralBuf, eocd]);
const outName = path.join(OUT, 'astro-hop-yandex.zip');
fs.writeFileSync(outName, zip);

/* распаковываем обратно для самопроверки */
const verify = unzip(outName);
const bad = files.filter(([n]) => Buffer.compare(verify[n], fs.readFileSync(path.join(ROOT, n))) !== 0);
if (bad.length) { console.log('✗ ошибка круговой проверки: ' + bad.map(b => b[0]).join(', ')); process.exit(1); }
console.log('✓ архив: ' + path.relative(ROOT, outName) + ' (' + (zip.length / 1024).toFixed(1) + ' КБ)');
console.log('✓ круговая распаковка совпадает с исходниками');

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function unzip(p) {
  const buf = fs.readFileSync(p); const out = {}; let pos = 0;
  while (buf.readUInt32LE(pos) === 0x04034b50) {
    const method = buf.readUInt16LE(pos + 8), csize = buf.readUInt32LE(pos + 18), nlen = buf.readUInt16LE(pos + 26), elen = buf.readUInt16LE(pos + 28);
    const name = buf.toString('utf8', pos + 30, pos + 30 + nlen);
    const start = pos + 30 + nlen + elen;
    const raw = buf.subarray(start, start + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    pos = start + csize;
  }
  return out;
}
