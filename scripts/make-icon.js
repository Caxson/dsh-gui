'use strict';

/**
 * Generates the Dsh Desktop app icon with zero dependencies:
 * draws a 1024x1024 PNG (dark rounded square, gradient, glowing "D" monogram),
 * then shells out to `sips` + `iconutil` to assemble build/icon.icns.
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const BUILD = path.join(ROOT, 'build');

// Preferred pipeline: a generated source image (assets/icon-source.png) is
// processed by process-icon.py (resize 1024 + macOS rounded-corner mask).
// Without it, fall back to the built-in synthetic drawing below.
const SOURCE_IMAGE = path.join(ASSETS, 'icon-source.png');
const pngPath = path.join(ASSETS, 'icon-1024.png');

if (!fs.existsSync(SOURCE_IMAGE)) {

// ── minimal PNG encoder ──────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── drawing helpers ──────────────────────────────────────────────────────
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (d) => clamp01(0.5 - d); // 1px antialiased coverage from SDF

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

// ── composition ──────────────────────────────────────────────────────────
const SIZE = 1024;
const bgTop = hex('#0d1220');
const bgBottom = hex('#1c2747');
const glyphTop = hex('#bfe3ff');
const glyphBottom = hex('#5b7cff');
const glow = hex('#27408f');

const px = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const fx = x + 0.5;
    const fy = y + 0.5;
    const i = (y * SIZE + x) * 4;

    // rounded-square canvas
    const outer = smooth(sdRoundRect(fx, fy, 512, 512, 512, 512, 190));
    if (outer <= 0) continue;

    // background: vertical gradient + soft center glow
    const g = fy / SIZE;
    let r = lerp(bgTop[0], bgBottom[0], g);
    let gg = lerp(bgTop[1], bgBottom[1], g);
    let b = lerp(bgTop[2], bgBottom[2], g);
    const dist = Math.hypot(fx - 512, fy - 512);
    const glowAmt = clamp01(1 - dist / 430) ** 2 * 0.55;
    r = lerp(r, glow[0], glowAmt);
    gg = lerp(gg, glow[1], glowAmt);
    b = lerp(b, glow[2], glowAmt);

    // "D" monogram: vertical bar + right semicircular annulus
    const bar = smooth(sdRoundRect(fx, fy, 336, 512, 62, 252, 46));
    let arc = 0;
    if (fx >= 392) {
      const dOut = sdCircle(fx, fy, 400, 512, 246);
      const dIn = 148 - Math.hypot(fx - 400, fy - 512);
      arc = smooth(Math.max(dOut, dIn));
    }
    const glyph = clamp01(1 - (1 - bar) * (1 - arc));

    if (glyph > 0) {
      const gy = (fy - 220) / 600;
      const t = clamp01(gy);
      const gr = lerp(glyphTop[0], glyphBottom[0], t);
      const ggg = lerp(glyphTop[1], glyphBottom[1], t);
      const gb = lerp(glyphTop[2], glyphBottom[2], t);
      // small blue glow around the glyph
      const halo = smooth(sdRoundRect(fx, fy, 400, 512, 250, 280, 120)) * 0.22 * glyph;
      r = lerp(r, glow[0], halo);
      gg = lerp(gg, glow[1], halo);
      b = lerp(b, glow[2], halo);
      r = lerp(r, gr, glyph);
      gg = lerp(gg, ggg, glyph);
      b = lerp(b, gb, glyph);
    }

    // soft edge against transparency
    const edge = 1 - clamp01(outer * 1.6 - 0.7) * 0.12;
    px[i] = Math.round(r * edge);
    px[i + 1] = Math.round(gg * edge);
    px[i + 2] = Math.round(b * edge);
    px[i + 3] = Math.round(255 * outer);
  }
}

fs.mkdirSync(ASSETS, { recursive: true });
fs.writeFileSync(pngPath, encodePng(SIZE, SIZE, px));
console.log('wrote', pngPath);

} else {
  fs.mkdirSync(ASSETS, { recursive: true });
  execFileSync('python3', [path.join(__dirname, 'process-icon.py'), SOURCE_IMAGE, pngPath], {
    stdio: 'inherit',
  });
}

// ── icns via sips + iconutil ─────────────────────────────────────────────
fs.mkdirSync(BUILD, { recursive: true });
const iconset = path.join(BUILD, 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });

const sizes = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
];
for (const [s, name] of sizes) {
  execFileSync('sips', ['-z', String(s), String(s), pngPath, '--out', path.join(iconset, name)], {
    stdio: 'ignore',
  });
}
fs.copyFileSync(pngPath, path.join(iconset, 'icon_512x512@2x.png'));
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')], {
  stdio: 'ignore',
});
console.log('wrote', path.join(BUILD, 'icon.icns'));
