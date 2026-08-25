import { encodePng } from "./png";
import { getHabitDetail } from "./db/habits";
import { dayOfWeek } from "./time";
import { ToolError } from "./errors";

const CELL = 16;
const GAP = 4;
const STEP = CELL + GAP;

const BG: [number, number, number] = [255, 255, 255];
const EMPTY: [number, number, number] = [235, 235, 235];
const LOGGED: [number, number, number] = [64, 176, 96];
const LOGGED_TODAY: [number, number, number] = [90, 205, 125];

/**
 * Renders a GitHub-style contribution heatmap for one habit as a PNG,
 * columns are calendar weeks (Sunday-aligned), rows are days of the week.
 * Deliberately no text/labels baked into the image — that would need a font
 * renderer, which is exactly the kind of complexity a hand-rolled encoder
 * is meant to avoid. Claude's reply carries the context (habit name, window)
 * instead.
 */
export function renderHabitChart(name: string, days = 84): Buffer {
  const detail = getHabitDetail(name, days);
  if (!detail) throw new ToolError(`no habit called "${name}"`);

  const history = detail.history; // oldest -> newest
  if (history.length === 0) throw new ToolError(`no history for "${name}" yet`);

  const firstDow = dayOfWeek(history[0]!.day);
  const totalCells = firstDow + history.length;
  const weeks = Math.ceil(totalCells / 7);

  const width = weeks * STEP + GAP;
  const height = 7 * STEP + GAP;
  const pixels = Buffer.alloc(width * height * 4);

  const setPixel = (x: number, y: number, [r, g, b]: [number, number, number]): void => {
    const i = (y * width + x) * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = 255;
  };
  const fillCell = (col: number, row: number, color: [number, number, number]): void => {
    const x0 = GAP + col * STEP;
    const y0 = GAP + row * STEP;
    for (let dy = 0; dy < CELL; dy++) {
      for (let dx = 0; dx < CELL; dx++) setPixel(x0 + dx, y0 + dy, color);
    }
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) setPixel(x, y, BG);
  }

  // Padding cells before the first real day, so columns stay week-aligned.
  for (let i = 0; i < firstDow; i++) fillCell(0, i, EMPTY);

  history.forEach((entry, idx) => {
    const cellIndex = firstDow + idx;
    const col = Math.floor(cellIndex / 7);
    const row = cellIndex % 7;
    const isToday = idx === history.length - 1;
    fillCell(col, row, entry.logged ? (isToday ? LOGGED_TODAY : LOGGED) : EMPTY);
  });

  return encodePng(width, height, pixels);
}
