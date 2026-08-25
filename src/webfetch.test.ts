import assert from "node:assert/strict";
import { test } from "node:test";
import { extractReadableText } from "./webfetch";

test("extracts the title from a <title> tag", () => {
  const { title } = extractReadableText("<html><head><title>Hello World</title></head></html>");
  assert.equal(title, "Hello World");
});

test("title is null when there is no <title> tag", () => {
  const { title } = extractReadableText("<html><body>no title here</body></html>");
  assert.equal(title, null);
});

test("strips <script> and <style> blocks entirely, including their content", () => {
  const html = `
    <html><head><style>body { color: red; }</style></head>
    <body>
      <script>console.log("should not appear");</script>
      <p>Real content.</p>
    </body></html>
  `;
  const { text } = extractReadableText(html);
  assert.ok(!text.includes("color: red"));
  assert.ok(!text.includes("should not appear"));
  assert.ok(text.includes("Real content."));
});

test("strips remaining tags, leaving only text", () => {
  const { text } = extractReadableText("<p>One <b>two</b> <i>three</i></p>");
  assert.equal(text, "One two three");
});

test("decodes common HTML entities", () => {
  const { text } = extractReadableText(
    "<p>Tom &amp; Jerry &lt;3 &quot;cats&quot; &#39;n&#39; dogs&nbsp;here</p>",
  );
  assert.equal(text, `Tom & Jerry <3 "cats" 'n' dogs here`);
});

test("collapses runs of whitespace into single spaces", () => {
  const { text } = extractReadableText("<p>one\n\n\n   two\t\tthree</p>");
  assert.equal(text, "one two three");
});

test("truncates long text and reports it", () => {
  const long = "a".repeat(9000);
  const { text, truncated } = extractReadableText(`<p>${long}</p>`);
  assert.equal(truncated, true);
  assert.equal(text.length, 8000);
});

test("does not truncate text under the cap", () => {
  const { text, truncated } = extractReadableText("<p>short</p>");
  assert.equal(truncated, false);
  assert.equal(text, "short");
});
