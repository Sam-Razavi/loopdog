import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, encodePng } from "./png";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Walks a PNG buffer's chunk list, verifying each length/CRC along the way. */
function readChunks(png: Buffer): { type: string; data: Buffer }[] {
  assert.deepEqual(png.subarray(0, 8), SIGNATURE, "PNG signature");
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    const declaredCrc = png.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(png.subarray(offset + 4, offset + 8 + length));
    assert.equal(actualCrc, declaredCrc, `CRC mismatch on ${type} chunk`);
    chunks.push({ type, data });
    offset += 8 + length + 4;
  }
  return chunks;
}

test("encodePng produces a well-formed PNG: signature, IHDR, IDAT, IEND in order", () => {
  const width = 2;
  const height = 2;
  const pixels = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255, // row 0: red, green
    0, 0, 255, 255, 255, 255, 0, 255, // row 1: blue, yellow
  ]);
  const png = encodePng(width, height, pixels);
  const chunks = readChunks(png);
  assert.deepEqual(
    chunks.map((c) => c.type),
    ["IHDR", "IDAT", "IEND"],
  );
});

test("IHDR encodes the correct width, height, bit depth and color type", () => {
  const width = 12;
  const height = 7;
  const pixels = Buffer.alloc(width * height * 4);
  const [ihdr] = readChunks(encodePng(width, height, pixels));
  assert.equal(ihdr!.data.readUInt32BE(0), width);
  assert.equal(ihdr!.data.readUInt32BE(4), height);
  assert.equal(ihdr!.data[8], 8, "bit depth");
  assert.equal(ihdr!.data[9], 6, "color type: RGBA");
});

test("IEND chunk is empty", () => {
  const png = encodePng(1, 1, Buffer.alloc(4));
  const [, , iend] = readChunks(png);
  assert.equal(iend!.data.length, 0);
});

test("crc32 is deterministic and sensitive to its input", () => {
  const a = crc32(Buffer.from("hello"));
  const b = crc32(Buffer.from("hello"));
  const c = crc32(Buffer.from("world"));
  assert.equal(a, b);
  assert.notEqual(a, c);
});
