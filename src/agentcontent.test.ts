import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentMarker, buildUserContent, type DocumentInput, type ImageInput } from "./agent";

/**
 * These pin two conditions the Anthropic API rejects outright with a 400
 * rather than degrading gracefully — block ordering for document input, and
 * base64 that contains newlines. Both are the kind of thing that looks fine
 * in review and only fails against the live API, which is exactly what a
 * test is for.
 */

function image(overrides: Partial<ImageInput> = {}): ImageInput {
  return { mediaType: "image/png", data: "aW1hZ2U=", ...overrides };
}

function document(overrides: Partial<DocumentInput> = {}): DocumentInput {
  return { filename: "syllabus.pdf", data: "cGRm", ...overrides };
}

test("no attachments stays a plain string, exactly as before", () => {
  // Worth pinning: this is the overwhelmingly common case, and switching it
  // to a one-element block array would be a silent change to every request.
  assert.equal(buildUserContent("what's on today?", [], []), "what's on today?");
});

test("a document block comes before the text block", () => {
  const content = buildUserContent("what's the deadline?", [], [document()]);
  assert.ok(Array.isArray(content));
  assert.equal(content[0]?.type, "document");
  assert.equal(content[1]?.type, "text");
});

test("documents lead, then text, then images, with several of each", () => {
  const content = buildUserContent("read these", [image(), image()], [document(), document()]);
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    content.map((block) => block.type),
    ["document", "document", "text", "image", "image"],
  );
});

test("a document block carries pdf media type and the filename as its title", () => {
  const content = buildUserContent("?", [], [document({ filename: "kursplan.pdf" })]);
  assert.ok(Array.isArray(content));
  const block = content[0];
  assert.equal(block?.type, "document");
  assert.equal(block.source.type, "base64");
  assert.equal(block.source.media_type, "application/pdf");
  assert.equal(block.title, "kursplan.pdf");
});

test("base64 payloads carry no newlines — wrapped base64 is a hard 400", () => {
  // Buffer.toString("base64") never wraps, but this pins the contract at the
  // boundary so a future switch to some other encoder can't quietly break it.
  const pdfBytes = Buffer.from("%PDF-1.7\n" + "x".repeat(500));
  const content = buildUserContent("?", [], [{ filename: "a.pdf", data: pdfBytes.toString("base64") }]);
  assert.ok(Array.isArray(content));
  const block = content[0];
  assert.equal(block?.type, "document");
  assert.doesNotMatch(block.source.type === "base64" ? block.source.data : "", /[\r\n]/);
});

test("only text is persisted to history — never attachment bytes", () => {
  // The property that keeps a years-long conversation from re-sending old
  // image/PDF payloads on every future turn.
  const marker = attachmentMarker("look at this", [image({ data: "A".repeat(5000) })], []);
  assert.doesNotMatch(marker, /A{50}/, "image bytes must not reach stored history");
  assert.equal(marker, "look at this [1 image attached]");
});

test("the history marker names PDFs and pluralises images", () => {
  assert.equal(
    attachmentMarker("hi", [image(), image()], []),
    "hi [2 images attached]",
  );
  assert.equal(
    attachmentMarker("what does this say?", [], [document({ filename: "tenta.pdf" })]),
    "what does this say? [tenta.pdf attached]",
  );
  assert.equal(
    attachmentMarker("both", [image()], [document({ filename: "a.pdf" })]),
    "both [1 image, a.pdf attached]",
  );
  assert.equal(attachmentMarker("nothing attached", [], []), "nothing attached");
});
