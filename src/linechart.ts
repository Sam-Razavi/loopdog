import { encodePng } from "./png";
import { getMetricHistory } from "./db/metrics";
import { ToolError } from "./errors";

const WIDTH = 280;
const HEIGHT = 140;
const MARGIN = 14;

const BG: [number, number, number] = [255, 255, 255];
const LINE: [number, number, number] = [64, 130, 200];
const DOT: [number, number, number] = [30, 90, 160];

function setPixel(
  pixels: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  [r, g, b]: [number, number, number],
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
  pixels[i + 3] = 255;
}

/** Bresenham's line algorithm, drawn two pixels tall for visibility at this scale. */
function drawLine(
  pixels: Buffer,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: [number, number, number],
): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const sx = x < ex ? 1 : -1;
  const dy = -Math.abs(ey - y);
  const sy = y < ey ? 1 : -1;
  let err = dx + dy;

  while (true) {
    setPixel(pixels, width, height, x, y, color);
    setPixel(pixels, width, height, x, y + 1, color); // thicken slightly
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function drawDot(
  pixels: Buffer,
  width: number,
  height: number,
  cx: number,
  cy: number,
  color: [number, number, number],
): void {
  const x0 = Math.round(cx) - 1;
  const y0 = Math.round(cy) - 1;
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) setPixel(pixels, width, height, x0 + dx, y0 + dy, color);
  }
}

/**
 * Renders a trend line for a numeric metric as a PNG — points evenly spaced
 * along x in day order (gaps between logged days aren't spatially
 * represented, just skipped), y scaled to the value range in view. No
 * axis labels baked in, same reasoning as the habit heatmap in chart.ts: a
 * font renderer is real complexity a hand-rolled encoder is meant to avoid.
 * Claude's reply carries the actual numbers.
 */
export function renderMetricChart(name: string, days = 30): Buffer {
  const history = getMetricHistory(name, days);
  if (!history) throw new ToolError(`no metric called "${name}"`);

  const points = history.history.filter(
    (h): h is { day: string; value: number } => h.value !== null,
  );
  if (points.length === 0) throw new ToolError(`no history for "${name}" yet`);

  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) setPixel(pixels, WIDTH, HEIGHT, x, y, BG);
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1; // flat line: avoid divide-by-zero

  const plotW = WIDTH - MARGIN * 2;
  const plotH = HEIGHT - MARGIN * 2;
  const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;
  const toXY = (index: number, value: number): [number, number] => [
    MARGIN + index * stepX,
    MARGIN + plotH - ((value - min) / range) * plotH,
  ];

  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = toXY(i, points[i]!.value);
    const [x1, y1] = toXY(i + 1, points[i + 1]!.value);
    drawLine(pixels, WIDTH, HEIGHT, x0, y0, x1, y1, LINE);
  }
  points.forEach((point, i) => {
    const [x, y] = toXY(i, point.value);
    drawDot(pixels, WIDTH, HEIGHT, x, y, DOT);
  });

  return encodePng(WIDTH, HEIGHT, pixels);
}
