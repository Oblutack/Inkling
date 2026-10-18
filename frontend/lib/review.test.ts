import { describe, expect, it } from "vitest";
import { answer, currentCard, isFinished, MAX_MISSES, startSession } from "./review";

const card = (front: string, documentId = 1) => ({ documentId, front });

describe("a review session", () => {
  it("shows the cards in order, and is finished when each has been known", () => {
    let s = startSession([card("a"), card("b"), card("c")]);
    expect(currentCard(s)?.front).toBe("a");
    s = answer(s, true);
    expect(currentCard(s)?.front).toBe("b");
    s = answer(answer(s, true), true);
    expect(isFinished(s)).toBe(true);
    expect(s).toMatchObject({ finished: 3, total: 3, knewFirst: 3, missed: 0 });
  });

  it("brings a missed card round again at the back of the line", () => {
    let s = startSession([card("a"), card("b")]);
    s = answer(s, false);
    expect(s.queue.map((c) => c.front)).toEqual(["b", "a"]);
    s = answer(s, true);
    expect(currentCard(s)?.front).toBe("a");
    s = answer(s, true);
    expect(isFinished(s)).toBe(true);
    expect(s).toMatchObject({ finished: 2, knewFirst: 1, missed: 1 });
  });

  it("counts a card as missed once, however many times it is missed, and as known-first only if it never was", () => {
    let s = startSession([card("a")]);
    s = answer(answer(s, false), false);
    s = answer(s, true);
    expect(s).toMatchObject({ missed: 1, knewFirst: 0, finished: 1 });
  });

  it("gives up on a card for today after it has been missed too many times", () => {
    let s = startSession([card("a"), card("b")]);
    for (let i = 0; i <= MAX_MISSES; i++) {
      s = answer(s, false); // a
      if (currentCard(s)?.front === "b") s = answer(s, true);
    }
    expect(s.queue.map((c) => c.front)).not.toContain("a");
    expect(isFinished(s)).toBe(true);
    expect(s.finished).toBe(2);
  });

  it("tells apart the same text in two sets", () => {
    let s = startSession([card("same", 1), card("same", 2)]);
    s = answer(s, false);
    s = answer(s, true);
    s = answer(s, true);
    expect(isFinished(s)).toBe(true);
    expect(s.missed).toBe(1);
  });

  it("does nothing with an empty session", () => {
    const s = startSession([]);
    expect(isFinished(s)).toBe(true);
    expect(answer(s, true)).toBe(s);
    expect(currentCard(s)).toBeUndefined();
  });
});
