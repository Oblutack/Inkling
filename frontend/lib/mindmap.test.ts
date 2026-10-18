import { describe, expect, it } from "vitest";
import type { ProofSentence } from "../types";
import { buildTree, edgePath, escapeXml, layoutTree, MAX_NODES, sentenceForPoint, toSvg, wrapText, type MapNode } from "./mindmap";

const SUMMARY = `# Lease terms

## Money
- Rent is 950 euros per month.
- The deposit is 1,900 euros.
  - It is returned within 30 days.

## Ending the lease
1. Notice is 60 days.
2. Early exit costs two months' rent.`;

const shape = (node: MapNode): unknown => (node.children.length ? { [node.text]: node.children.map(shape) } : node.text);

describe("buildTree", () => {
  it("makes headings branches and bullets leaves, under the title", () => {
    const tree = buildTree("Lease terms", SUMMARY);
    expect(shape(tree.root)).toEqual({
      "Lease terms": [
        { Money: ["Rent is 950 euros per month.", { "The deposit is 1,900 euros.": ["It is returned within 30 days."] }] },
        { "Ending the lease": ["Notice is 60 days.", "Early exit costs two months' rent."] },
      ],
    });
    expect(tree.root.kind).toBe("root");
    expect(tree.root.children[0].kind).toBe("branch");
    expect(tree.root.children[0].children[1].kind).toBe("branch"); // a point with points under it
    expect(tree.root.children[0].children[0].kind).toBe("leaf");
    expect(tree.nodes).toBe(8);
    expect(tree.omitted).toBe(0);
  });

  it("does not repeat the title as a branch, but keeps a different first heading", () => {
    expect(buildTree("Lease terms", "# Lease terms\n- A point.").root.children.map((c) => c.text)).toEqual(["A point."]);
    expect(buildTree("lease terms!", "# Lease terms\n- A point.").root.children.map((c) => c.text)).toEqual(["A point."]);
    expect(buildTree("My file.pdf", "# Lease terms\n- A point.").root.children.map((c) => c.text)).toEqual(["Lease terms"]);
  });

  it("nests headings by level", () => {
    const tree = buildTree("T", "## A\n### A1\n- x\n### A2\n- y\n## B\n- z");
    expect(shape(tree.root)).toEqual({ T: [{ A: [{ A1: ["x"] }, { A2: ["y"] }] }, { B: ["z"] }] });
  });

  it("splits plain paragraphs into sentences when a summary has no structure", () => {
    const tree = buildTree("Notes", "The tenant pays rent monthly. The deposit is returned in 30 days. See clause 4.\n\nA second paragraph here.");
    expect(tree.root.children.map((c) => c.text)).toEqual([
      "The tenant pays rent monthly.",
      "The deposit is returned in 30 days.",
      "See clause 4.",
      "A second paragraph here.",
    ]);
  });

  it("drops citation marks and markdown marks", () => {
    const tree = buildTree("T", "- **Rent** is due [1] on the first.【2】");
    expect(tree.root.children[0].text).toBe("Rent is due on the first.");
  });

  it("is a single node for an empty summary, titled even when the title is empty", () => {
    const tree = buildTree("", "");
    expect(tree.nodes).toBe(1);
    expect(tree.root.text).toBe("Summary");
  });

  it("stops at the size limit and says how many points were left out", () => {
    const many = Array.from({ length: MAX_NODES + 20 }, (_, i) => `- Point number ${i}`).join("\n");
    const tree = buildTree("T", many);
    expect(tree.nodes).toBe(MAX_NODES);
    expect(tree.omitted).toBe(21);
    expect(tree.root.children).toHaveLength(MAX_NODES - 1);
  });

  it("limits the sentences of one long paragraph", () => {
    const paragraph = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} ends here.`).join(" ");
    const tree = buildTree("T", paragraph);
    expect(tree.root.children).toHaveLength(6);
    expect(tree.omitted).toBe(4);
  });
});

describe("wrapText", () => {
  it("breaks at words into lines that fit", () => {
    expect(wrapText("The deposit is returned within thirty days of moving out", 20)).toEqual([
      "The deposit is",
      "returned within",
      "thirty days of…",
    ]);
  });

  it("leaves a short text on one line", () => {
    expect(wrapText("Short point.")).toEqual(["Short point."]);
  });

  it("never lets a long word spill over", () => {
    const lines = wrapText("x".repeat(80), 20);
    expect(lines).toEqual(["x".repeat(19) + "…"]);
  });

  it("ends the last line with an ellipsis only when words were left out", () => {
    const cut = wrapText("one two three four five six seven eight nine ten eleven twelve thirteen", 20, 3);
    expect(cut).toHaveLength(3);
    expect(cut.at(-1)?.endsWith("…")).toBe(true);
    expect(wrapText("one two three four five six seven eight nine ten", 20, 3).at(-1)).toBe("nine ten");
    expect(wrapText("one two three", 20, 3)).toEqual(["one two three"]);
    expect(wrapText("", 20)).toEqual([""]);
  });
});

describe("layoutTree", () => {
  const layout = layoutTree(buildTree("Lease terms", SUMMARY));

  it("puts each level in its own column, going right", () => {
    const xs = (depth: number) => new Set(layout.nodes.filter((n) => n.depth === depth).map((n) => n.x));
    expect(xs(0).size).toBe(1);
    expect(xs(1).size).toBe(1);
    expect([...xs(1)][0]).toBeGreaterThan([...xs(0)][0]);
    expect([...xs(2)][0]).toBeGreaterThan([...xs(1)][0]);
  });

  it("never overlaps two nodes of a column", () => {
    for (const depth of [0, 1, 2, 3]) {
      const column = layout.nodes.filter((n) => n.depth === depth).sort((a, b) => a.y - b.y);
      for (let i = 1; i < column.length; i++) expect(column[i].y).toBeGreaterThanOrEqual(column[i - 1].y + column[i - 1].height);
    }
  });

  it("centres a branch on its children and fits everything in the picture", () => {
    const branch = layout.nodes.find((n) => n.node.text === "Money");
    const kids = layout.nodes.filter((n) => n.parent !== null && layout.nodes[n.parent] === branch);
    expect(kids).toHaveLength(2);
    const middle = (kids[0].y + kids[1].y + kids[1].height) / 2;
    expect(branch!.y + branch!.height / 2).toBeCloseTo(middle, 5);
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.width).toBeLessThanOrEqual(layout.width);
      expect(n.y + n.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("lays out the biggest map without overlaps", () => {
    const big = layoutTree(buildTree("T", Array.from({ length: 160 }, (_, i) => `## Section ${i % 9}\n- Point ${i}`).join("\n")));
    expect(big.nodes.length).toBeLessThanOrEqual(MAX_NODES);
    const column = big.nodes.filter((n) => n.depth === 2).sort((a, b) => a.y - b.y);
    for (let i = 1; i < column.length; i++) expect(column[i].y).toBeGreaterThanOrEqual(column[i - 1].y + column[i - 1].height);
  });
});

describe("edgePath", () => {
  it("runs from the right edge of the parent to the left edge of the child", () => {
    const layout = layoutTree(buildTree("T", "- a"));
    const [root, leaf] = layout.nodes;
    const path = edgePath(root, leaf);
    expect(path.startsWith(`M${root.x + root.width},`)).toBe(true);
    expect(path.endsWith(`${leaf.x},${leaf.y + leaf.height / 2}`)).toBe(true);
  });
});

describe("toSvg", () => {
  it("is a standalone picture with every point in it", () => {
    const svg = toSvg(layoutTree(buildTree("Lease terms", SUMMARY)), "Lease terms");
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain("<title>Lease terms</title>");
    expect(svg).toContain("Rent is 950 euros per month.");
    expect(svg.match(/<rect /g)).toHaveLength(9); // the white background and the eight nodes
    expect(svg).not.toContain("var(--");
  });

  it("cannot be bent by markup in the text", () => {
    const svg = toSvg(layoutTree(buildTree('<script>alert(1)</script> & "x"', "- <img src=x onerror=alert(1)>")), "<b>t</b>");
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<img");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;script&gt;");
  });
});

describe("escapeXml", () => {
  it("escapes the characters of markup", () => {
    expect(escapeXml(`a & b < c > "d"`)).toBe("a &amp; b &lt; c &gt; &quot;d&quot;");
  });
});

describe("sentenceForPoint", () => {
  const sentence = (text: string, support: ProofSentence["support"] = "strong"): ProofSentence => ({
    text,
    kind: "claim",
    support,
    coverage: 0.9,
    missingNumbers: [],
    elsewhereNumbers: [],
    passages: [],
  });
  const sentences = [
    sentence("Rent is 950 euros per month."),
    sentence("The deposit is 1,900 euros."),
    sentence("Notice is 60 days."),
    sentence("Early exit costs two months' rent."),
  ];

  it("finds the same sentence whatever the marks and capitals", () => {
    expect(sentenceForPoint("rent is 950 euros per month", sentences)).toBe(sentences[0]);
    expect(sentenceForPoint("The deposit is 1,900 euros. [2]", sentences)).toBe(sentences[1]);
  });

  it("finds a sentence inside a point that holds two", () => {
    expect(sentenceForPoint("Notice is 60 days. It must be in writing.", sentences)).toBe(sentences[2]);
  });

  it("finds a close paraphrase by its words", () => {
    expect(sentenceForPoint("Early exit costs two months rent plus fees", sentences)).toBe(sentences[3]);
  });

  it("finds nothing for what is not there", () => {
    expect(sentenceForPoint("The tenant may keep a cat", sentences)).toBeNull();
    expect(sentenceForPoint("", sentences)).toBeNull();
    expect(sentenceForPoint("Rent", [])).toBeNull();
  });
});
