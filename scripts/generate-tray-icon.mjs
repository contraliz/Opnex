import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const size = 32;
const scale = 4;
const pixels = new Uint8Array(size * scale * size * scale * 4);

function fillRoundedRectangle(x, y, width, height, radius, color) {
  const right = x + width;
  const bottom = y + height;
  for (let py = y; py < bottom; py += 1) {
    for (let px = x; px < right; px += 1) {
      const cx = Math.max(x + radius, Math.min(px + 0.5, right - radius));
      const cy = Math.max(y + radius, Math.min(py + 0.5, bottom - radius));
      if ((px + 0.5 - cx) ** 2 + (py + 0.5 - cy) ** 2 > radius ** 2) continue;
      const offset = (py * size * scale + px) * 4;
      pixels.set(color, offset);
    }
  }
}

function fillRectangle(x, y, width, height, color) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) pixels.set(color, (py * size * scale + px) * 4);
  }
}

fillRoundedRectangle(scale * 1, scale * 1, scale * 30, scale * 30, scale * 8, [85, 85, 85, 255]);
fillRoundedRectangle(scale * 2, scale * 2, scale * 28, scale * 28, scale * 7, [32, 32, 32, 255]);

const p = ['11110', '10001', '10001', '11110', '10000', '10000', '10000'];
const cell = scale * 3;
const left = Math.round(scale * 8.5);
const top = Math.round(scale * 5.5);
for (let row = 0; row < p.length; row += 1) {
  for (let column = 0; column < p[row].length; column += 1) {
    if (p[row][column] === '1') fillRectangle(left + column * cell, top + row * cell, cell, cell, [240, 240, 240, 255]);
  }
}

const rgba = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const output = (y * size + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      let total = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) total += pixels[((y * scale + sy) * size * scale + x * scale + sx) * 4 + channel];
      }
      rgba[output + channel] = Math.round(total / (scale * scale));
    }
  }
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}

const scanlines = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y += 1) rgba.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(scanlines)),
  chunk('IEND', Buffer.alloc(0)),
]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(scriptDirectory, '../desktop/tray-icon.png');
await writeFile(output, png);
console.log(`Generated ${output}`);
