import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { englishT } from "./i18n";
import { bs } from "./i18n/bs";
import { de } from "./i18n/de";
import { en } from "./i18n/en";
import { es } from "./i18n/es";
import { fr } from "./i18n/fr";
import { GROUP_ORDER, KINDS, groupItems, itemLabel, kindLabelKey, type ChecklistItem } from "./checklist";

const item = (id: string, status: ChecklistItem["status"]): ChecklistItem => ({ id, status, value: "", quote: "", page: null, reason: "" });

// The checklists are defined in the AI service. Every item it can ask about must have a name in every language.
function itemsInTheAIService(): Record<string, string[]> {
  const source = readFileSync(join(__dirname, "..", "..", "python-ai-service", "checklists.py"), "utf8");
  const out: Record<string, string[]> = {};
  for (const block of source.matchAll(/^ {4}"(\w+)": \[\r?\n([\s\S]*?)^ {4}\],/gm)) {
    out[block[1]] = [...block[2].matchAll(/Item\(\s*"(\w+)"/g)].map((m) => m[1]);
  }
  return out;
}

describe("the checklists of the AI service", () => {
  const defined = itemsInTheAIService();

  it("are the kinds the web app offers", () => {
    expect(Object.keys(defined).sort()).toEqual([...KINDS].sort());
    for (const kind of KINDS) expect(defined[kind].length, kind).toBeGreaterThanOrEqual(8);
  });

  it("have a name for every item, and a kind name, in every language", () => {
    for (const [code, table] of Object.entries({ en, es, de, fr, bs })) {
      const record = table as Record<string, string>;
      for (const kind of KINDS) {
        expect(record[kindLabelKey(kind)]?.trim(), `${code}: ${kind}`).toBeTruthy();
        for (const id of defined[kind]) expect(record[`checklist.item.${kind}.${id}`]?.trim(), `${code}: ${kind}.${id}`).toBeTruthy();
      }
    }
  });

  it("have no name that no item uses", () => {
    const named = Object.keys(en).filter((k) => k.startsWith("checklist.item."));
    const used = KINDS.flatMap((kind) => defined[kind].map((id) => `checklist.item.${kind}.${id}`));
    expect(named.sort()).toEqual(used.sort());
  });
});

describe("itemLabel", () => {
  it("is the name in the person's language", () => {
    expect(itemLabel("lease", "deposit", englishT)).toBe("Security deposit");
  });

  it("is made from the id when the item is not known yet", () => {
    expect(itemLabel("lease", "early_notice", englishT)).toBe("Early notice");
    expect(itemLabel("mortgage", "rate", englishT)).toBe("Rate");
  });
});

describe("groupItems", () => {
  it("puts what is missing first, then what is unclear, then what was found, each in the order of the list", () => {
    const grouped = groupItems([item("a", "found"), item("b", "missing"), item("c", "unclear"), item("d", "missing"), item("e", "found")]);
    expect(grouped.missing.map((i) => i.id)).toEqual(["b", "d"]);
    expect(grouped.unclear.map((i) => i.id)).toEqual(["c"]);
    expect(grouped.found.map((i) => i.id)).toEqual(["a", "e"]);
    expect(GROUP_ORDER).toEqual(["missing", "unclear", "found"]);
  });

  it("has an empty group for nothing", () => {
    expect(groupItems([])).toEqual({ missing: [], unclear: [], found: [] });
  });
});
