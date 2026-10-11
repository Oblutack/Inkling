// Summaries come back as Markdown. This reads the small part of it that summaries use (headings, lists, bold, italic,
// code, paragraphs) and draws it with DOM nodes, never as HTML: whatever the text says, it cannot add a tag, a link or
// a script to the page.

// Splits one line into pieces: { type: "text" | "strong" | "em" | "code", text }.
export function parseInline(line) {
  const pieces = [];
  // Underscores only count at the edge of a word, so snake_case_name stays as it is written.
  const pattern = /(\*\*[^*]+\*\*|(?<!\w)__[^_]+__(?!\w)|\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w)|`[^`]+`)/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > last) pieces.push({ type: "text", text: line.slice(last, match.index) });
    const raw = match[0];
    if (raw.startsWith("**") || raw.startsWith("__")) pieces.push({ type: "strong", text: raw.slice(2, -2) });
    else if (raw.startsWith("`")) pieces.push({ type: "code", text: raw.slice(1, -1) });
    else pieces.push({ type: "em", text: raw.slice(1, -1) });
    last = match.index + raw.length;
  }
  if (last < line.length) pieces.push({ type: "text", text: line.slice(last) });
  return pieces;
}

// Blocks: { type: "heading", level, inline } | { type: "list", ordered, items: [inline] } | { type: "paragraph", inline }.
export function parseMarkdown(markdown) {
  const blocks = [];
  let paragraph = [];
  let list = null;
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const endList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const bullet = /^\s{0,6}[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s{0,6}\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      endParagraph();
      endList();
    } else if (heading) {
      endParagraph();
      endList();
      blocks.push({ type: "heading", level: Math.min(heading[1].length, 6), inline: parseInline(heading[2]) });
    } else if (bullet || numbered) {
      endParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        endList();
        list = { type: "list", ordered, items: [] };
      }
      list.items.push(parseInline((bullet || numbered)[1]));
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      endParagraph();
      endList();
    } else {
      endList();
      paragraph.push(line.trim());
    }
  }
  endParagraph();
  endList();
  return blocks;
}

function drawInline(doc, parent, inline) {
  for (const piece of inline) {
    if (piece.type === "text") {
      parent.append(doc.createTextNode(piece.text));
    } else {
      const tag = { strong: "strong", em: "em", code: "code" }[piece.type];
      const element = doc.createElement(tag);
      element.textContent = piece.text;
      parent.append(element);
    }
  }
}

// Draws the blocks into `target` (replacing what was there). A heading is drawn one size smaller than it says, in a
// small panel: # and ## are both an h3, deeper ones an h4, so the page's own outline is not disturbed.
export function renderMarkdown(markdown, target, doc = target.ownerDocument) {
  const fragment = doc.createDocumentFragment();
  for (const block of parseMarkdown(markdown)) {
    if (block.type === "heading") {
      const heading = doc.createElement(block.level <= 2 ? "h3" : "h4");
      drawInline(doc, heading, block.inline);
      fragment.append(heading);
    } else if (block.type === "list") {
      const list = doc.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = doc.createElement("li");
        drawInline(doc, li, item);
        list.append(li);
      }
      fragment.append(list);
    } else {
      const p = doc.createElement("p");
      drawInline(doc, p, block.inline);
      fragment.append(p);
    }
  }
  target.replaceChildren(fragment);
}
