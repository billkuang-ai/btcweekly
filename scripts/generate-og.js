/**
 * generate-og.js
 * Generates a static 1200×630 OG image for BTC Weekly.
 * Run: node scripts/generate-og.js
 */

const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

// Register Black Han Sans (latin subset — covers A–Z needed for "BTC WEEKLY")
const fontPath = path.join(
  __dirname,
  '../node_modules/@fontsource/black-han-sans/files/black-han-sans-latin-400-normal.woff2'
);
GlobalFonts.registerFromPath(fontPath, 'Black Han Sans');

const W = 1200;
const H = 630;

const ORANGE        = '#F7931A';
const ORANGE_BRIGHT = '#FFAA3A';
const ORANGE_SOFT   = '#FFBE5C';
const ORANGE_MIST   = '#FFD48C';
const ORANGE_PALE   = '#FFE8BE';
const DARK          = '#1C1208';
const MUTED         = '#A08060';

const canvas = createCanvas(W, H);
const ctx    = canvas.getContext('2d');

// ── Background ──
ctx.fillStyle = DARK;
ctx.fillRect(0, 0, W, H);

// ── Top accent bar ──
ctx.fillStyle = ORANGE;
ctx.fillRect(0, 0, W, 8);

// ── Subtle bottom gradient band ──
const grad = ctx.createLinearGradient(0, H - 120, 0, H);
grad.addColorStop(0, 'rgba(247,147,26,0)');
grad.addColorStop(1, 'rgba(247,147,26,0.08)');
ctx.fillStyle = grad;
ctx.fillRect(0, H - 120, W, 120);

// ── "BTC" wordmark ──
const btcSize = 148;
ctx.font = `${btcSize}px "Black Han Sans"`;
ctx.textBaseline = 'alphabetic';

const btcX = 80;
const btcY = 310;

const shadows = [
  { dx: 4, dy: 4, color: ORANGE_MIST },
  { dx: 3, dy: 3, color: ORANGE_SOFT },
  { dx: 2, dy: 2, color: ORANGE_BRIGHT },
];
for (const { dx, dy, color } of shadows) {
  ctx.fillStyle = color;
  ctx.fillText('BTC', btcX + dx, btcY + dy);
}
ctx.fillStyle = ORANGE;
ctx.fillText('BTC', btcX, btcY);

// ── "WEEKLY" wordmark — outline style ──
const weeklySize = 148;
ctx.font = `${weeklySize}px "Black Han Sans"`;

const weeklyX = btcX + ctx.measureText('BTC').width + 10;
const weeklyY = btcY;

const weeklyShadows = [
  { dx: 5, dy: 5, color: ORANGE_MIST },
  { dx: 3, dy: 3, color: ORANGE_PALE },
];
for (const { dx, dy, color } of weeklyShadows) {
  ctx.fillStyle = color;
  ctx.fillText('WEEKLY', weeklyX + dx, weeklyY + dy);
}
// Outline (stroke)
ctx.strokeStyle = ORANGE;
ctx.lineWidth = 3;
ctx.strokeText('WEEKLY', weeklyX, weeklyY);
// Fill with dark so it reads as outlined
ctx.fillStyle = DARK;
ctx.fillText('WEEKLY', weeklyX, weeklyY);
// Re-stroke on top for clean edge
ctx.strokeText('WEEKLY', weeklyX, weeklyY);

// ── Tagline ──
ctx.font = '500 28px "Black Han Sans"';
ctx.fillStyle = MUTED;
ctx.fillText('BALANCED  ·  TRUSTED  ·  CONCISE', btcX, btcY + 60);

// ── URL ──
ctx.font = '26px "Black Han Sans"';
ctx.fillStyle = ORANGE;
ctx.fillText('btcweekly.org', btcX, H - 48);

// ── Save ──
const outDir = path.join(__dirname, '../src');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'og.png');
const buffer = canvas.toBuffer('image/png');
fs.writeFileSync(outPath, buffer);
console.log(`✓ OG image written to ${outPath} (${W}×${H})`);
