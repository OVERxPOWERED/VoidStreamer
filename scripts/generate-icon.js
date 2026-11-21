const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 256;
const RADIUS = 48;
const pixels = Buffer.alloc(SIZE * SIZE * 4);

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // Alpha blend over black background
  const srcA = a / 255;
  const dstA = 1 - srcA;
  pixels[i]     = Math.round(r * srcA + pixels[i] * dstA);
  pixels[i + 1] = Math.round(g * srcA + pixels[i + 1] * dstA);
  pixels[i + 2] = Math.round(b * srcA + pixels[i + 2] * dstA);
  pixels[i + 3] = 255;
}

function dist(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

function roundRect(x1, y1, x2, y2, r, fill) {
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      let inside = false;
      if (x >= x1 + r && x <= x2 - r && y >= y1 && y <= y2) inside = true;
      else if (y >= y1 + r && y <= y2 - r && x >= x1 && x <= x2) inside = true;
      else {
        // Check corners
        const corners = [
          [x1 + r, y1 + r], [x2 - r, y1 + r],
          [x1 + r, y2 - r], [x2 - r, y2 - r]
        ];
        for (const [cx, cy] of corners) {
          if (dist(x, y, cx, cy) <= r) { inside = true; break; }
        }
      }
      if (inside) setPixel(x, y, fill[0], fill[1], fill[2], fill[3] ?? 255);
    }
  }
}

function triangle(x1, y1, x2, y2, x3, y3, fill) {
  const minX = Math.max(0, Math.floor(Math.min(x1, x2, x3)));
  const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(x1, x2, x3)));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2, y3)));
  const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(y1, y2, y3)));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2);
      const d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3);
      const d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1);
      const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      if (!(hasNeg && hasPos)) {
        // Anti-alias at edges
        let alpha = fill[3] ?? 255;
        const edgeDist = Math.min(Math.abs(d1), Math.abs(d2), Math.abs(d3)) /
          Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
        if (edgeDist < 1) alpha = Math.round(alpha * Math.max(edgeDist, 0.3));
        setPixel(x, y, fill[0], fill[1], fill[2], alpha);
      }
    }
  }
}

// Draw rounded rect background
roundRect(0, 0, SIZE - 1, SIZE - 1, RADIUS, [8, 10, 24, 255]);
roundRect(1, 1, SIZE - 2, SIZE - 2, RADIUS - 1, [12, 14, 32, 255]);

// Gradient colors: Emerald #10b981 -> Cyan #06b6d4 -> Magenta #d946ef
const gradient = [
  [16, 185, 129],   // Emerald
  [6, 182, 212],    // Cyan
  [217, 70, 239],   // Magenta
];

// Draw the "V" letter with gradient
// V shape: two diagonal lines meeting at bottom center
const vLeftTopX = 62, vLeftTopY = 58;
const vRightTopX = 194, vRightTopY = 58;
const vBottomX = 128, vBottomY = 198;
const vStroke = 24;

for (let y = vLeftTopY; y <= vBottomY; y++) {
  const t = (y - vLeftTopY) / (vBottomY - vLeftTopY);
  const leftX = vLeftTopX + (vBottomX - vLeftTopX) * t;
  const rightX = vRightTopX + (vBottomX - vRightTopX) * t;

  for (let x = Math.floor(leftX) - vStroke; x <= Math.ceil(rightX) + vStroke; x++) {
    // Distance from left stroke center
    const leftDist = Math.abs((x - leftX));
    // Distance from right stroke center
    const rightDist = Math.abs((x - rightX));

    const halfStroke = vStroke / 2;

    // Anti-aliasing
    let alpha = 0;
    if (leftDist < halfStroke + 1) {
      alpha = Math.min(alpha + Math.round(255 * Math.min(1, (halfStroke + 1 - leftDist))), 255);
    }
    if (rightDist < halfStroke + 1) {
      alpha = Math.min(alpha + Math.round(255 * Math.min(1, (halfStroke + 1 - rightDist))), 255);
    }
    alpha = Math.min(alpha, 255);

    if (alpha > 0) {
      // Map Y position to gradient color
      const gy = t;
      let r, g, b;
      if (gy < 0.5) {
        const gt = gy * 2;
        r = Math.round(gradient[0][0] + (gradient[1][0] - gradient[0][0]) * gt);
        g = Math.round(gradient[0][1] + (gradient[1][1] - gradient[0][1]) * gt);
        b = Math.round(gradient[0][2] + (gradient[1][2] - gradient[0][2]) * gt);
      } else {
        const gt = (gy - 0.5) * 2;
        r = Math.round(gradient[1][0] + (gradient[2][0] - gradient[1][0]) * gt);
        g = Math.round(gradient[1][1] + (gradient[2][1] - gradient[1][1]) * gt);
        b = Math.round(gradient[1][2] + (gradient[2][2] - gradient[1][2]) * gt);
      }
      setPixel(x, y, r, g, b, alpha);
    }
  }
}

// Encode as PNG
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeData = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData));
  return Buffer.concat([len, typeData, crc]);
}

// PNG filter: each row prefixed with filter byte 0 (None)
const rawData = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  rawData[y * (SIZE * 4 + 1)] = 0; // filter: none
  pixels.copy(rawData, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const compressed = zlib.deflateSync(rawData, { level: 9 });

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type: RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
  chunk('IHDR', ihdr),
  chunk('IDAT', compressed),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, '..', 'icon.png');
fs.writeFileSync(outPath, png);
console.log('Icon created:', outPath, `(${png.length} bytes)`);
