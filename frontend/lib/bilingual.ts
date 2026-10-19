// A summary in two languages side by side: its lines (a heading, a bullet or a paragraph each) with their translation into
// another language, and the key words with their translations.
export type RowKind = "heading" | "bullet" | "numbered" | "paragraph";

export interface BilingualRow {
  kind: RowKind;
  source: string;
  // "" when the model did not translate this line.
  target: string;
  // False when a number of the line is not in its translation: the figure may have been changed.
  figuresKept: boolean;
}

export interface BilingualWord {
  word: string;
  translation: string;
}

export interface Bilingual {
  language: string;
  rows: BilingualRow[];
  vocabulary: BilingualWord[];
  // How many lines came back without a translation.
  missing: number;
  foundAt?: string;
  cached?: boolean;
}

// The mark put before a line: bullets and numbers keep their form in both languages.
export function linePrefix(row: BilingualRow, index: number): string {
  if (row.kind === "bullet") return "• ";
  if (row.kind === "numbered") return `${index}. `;
  return "";
}

// The number a numbered line has among the numbered lines before it (they count again after a heading or a paragraph).
export function numberedPositions(rows: readonly BilingualRow[]): number[] {
  let n = 0;
  return rows.map((row) => {
    if (row.kind === "numbered") {
      n += 1;
      return n;
    }
    n = 0;
    return 0;
  });
}

// Lines whose figures may have been changed in the translation, so the screen can say "check this one".
export function figureWarnings(rows: readonly BilingualRow[]): number {
  return rows.filter((row) => row.target && !row.figuresKept).length;
}

// The two languages as one Markdown text (the original line, then its translation), for copying into notes.
export function bilingualMarkdown(title: string, original: string, result: Bilingual): string {
  const lines = [`# ${title.replace(/\s+/g, " ").trim()}`, "", `${original} | ${result.language}`, ""];
  const positions = numberedPositions(result.rows);
  result.rows.forEach((row, i) => {
    const prefix = row.kind === "heading" ? "## " : linePrefix(row, positions[i]).replace("• ", "- ");
    lines.push(`${prefix}${row.source}`);
    if (row.target) lines.push(`${prefix.startsWith("##") ? "## " : prefix.replace(/^\d+\.\s/, "- ")}*${row.target}*`);
    lines.push("");
  });
  if (result.vocabulary.length > 0) {
    lines.push("## Vocabulary", "");
    for (const w of result.vocabulary) lines.push(`- ${w.word} = ${w.translation}`);
    lines.push("");
  }
  return lines.join("\n");
}
