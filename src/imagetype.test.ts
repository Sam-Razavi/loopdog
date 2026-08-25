import assert from "node:assert/strict";
import { test } from "node:test";
import { sniffImageType } from "./imagetype";
import { encodePng } from "./png";

test("sniffs a real PNG by its signature", () => {
  const png = encodePng(1, 1, Buffer.alloc(4));
  assert.equal(sniffImageType(png), "image/png");
});

test("sniffs a JPEG by its SOI marker", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  assert.equal(sniffImageType(jpeg), "image/jpeg");
});

test("sniffs a GIF87a and GIF89a by their headers", () => {
  assert.equal(sniffImageType(Buffer.from("GIF87a" + "\0".repeat(4))), "image/gif");
  assert.equal(sniffImageType(Buffer.from("GIF89a" + "\0".repeat(4))), "image/gif");
});

test("sniffs a WebP by its RIFF....WEBP header", () => {
  const webp = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0, 0, 0, 0]), // file size, irrelevant here
    Buffer.from("WEBP"),
  ]);
  assert.equal(sniffImageType(webp), "image/webp");
});

test("returns null for content that isn't a recognized image format", () => {
  assert.equal(sniffImageType(Buffer.from("not an image, just text")), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
});

test("doesn't false-positive on a buffer too short to hold a real header", () => {
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50])), null); // truncated PNG signature
  assert.equal(sniffImageType(Buffer.from([0x52, 0x49, 0x46, 0x46])), null); // RIFF with no WEBP tag yet
});
