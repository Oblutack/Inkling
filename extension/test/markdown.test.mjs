import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInline, parseMarkdown, renderMarkdown } from "../lib/markdown.js";

test("bold, italic and code are found inside a line", () => {
  assert.deepEqual(parseInline("A **bold** and _soft_ and `code` end"), [
    { type: "text", text: "A " },
    { type: "strong", text: "bold" },
    { type: "text", text: " and " },
    { type: "em", text: "soft" },
    { type: "text", text: " and " },
    { type: "code", text: "code" },
    { type: "text", text: " end" },
  ]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ type: "text", text: "2 * 3 * 4" }]); // a sum is not italic
  assert.deepEqual(parseInline("snake_case_name"), [{ type: "text", text: "snake_case_name" }]);
});

test("headings, lists and paragraphs become blocks", () => {
  const blocks = parseMarkdown("## Summary\n\nHeat pumps **move** heat\nnot make it.\n\n- one\n- two\n\n1. first\n2) second\n");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading", "paragraph", "list", "list"],
  );
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[1].inline.map((p) => p.text).join(""), "Heat pumps move heat not make it."); // lines of a paragraph join
  assert.deepEqual(
    blocks[2].items.map((i) => i[0].text),
    ["one", "two"],
  );
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[3].ordered, true);
});

test("a list ends where the text goes on, and a rule between sections is dropped", () => {
  const blocks = parseMarkdown("- a\n- b\nafter\n\n---\n\nend");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["list", "paragraph", "paragraph"],
  );
});

test("Windows line endings and nothing at all are fine", () => {
  assert.equal(parseMarkdown("# T\r\n\r\ntext\r\n").length, 2);
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown(undefined), []);
});

// A very small stand-in for the page, enough to see what would be drawn.
function fakeDocument() {
  const make = (tag) => ({ tag, children: [], textContent: "", append(...n) { this.children.push(...n); }, replaceChildren(f) { this.children = f.children; } });
  return {
    createElement: make,
    createTextNode: (text) => ({ tag: "#text", text }),
    createDocumentFragment: () => make("#fragment"),
  };
}

function outline(node) {
  if (node.tag === "#text") return node.text;
  const inner = (node.children || []).map(outline).join("");
  return node.textContent ? `<${node.tag}>${node.textContent}</${node.tag}>` : node.tag === "#fragment" ? inner : `<${node.tag}>${inner}</${node.tag}>`;
}

test("it is drawn with elements, and markup in the text stays text", () => {
  const doc = fakeDocument();
  const target = doc.createElement("div");
  renderMarkdown("# Title\n\nSee <script>alert(1)</script> and **bold** [link](http://evil.example)\n\n* item <b>x</b>", target, doc);
  assert.equal(
    outline(target),
    "<div><h3>Title</h3><p>See <script>alert(1)</script> and <strong>bold</strong> [link](http://evil.example)</p><ul><li>item <b>x</b></li></ul></div>",
  );
  // the angle brackets are only ever characters of a text node: no element but the ones above was made
  const tags = new Set();
  (function walk(n) {
    tags.add(n.tag);
    (n.children || []).forEach(walk);
  })(target);
  assert.deepEqual([...tags].sort(), ["#text", "div", "h3", "li", "p", "strong", "ul"]);
});

test("deep headings stay small", () => {
  const doc = fakeDocument();
  const target = doc.createElement("div");
  renderMarkdown("### Third\n\n###### Sixth", target, doc);
  assert.equal(outline(target), "<div><h4>Third</h4><h4>Sixth</h4></div>");
});
