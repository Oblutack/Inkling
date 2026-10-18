import { describe, expect, it } from "vitest";
import { collectionsOf, elapsedSeconds, formatClock, mark, percentOf, resultBody, setsOfCollection, timeLimit, trend, type ExamQuestion, type ExamSet } from "./exam";

const q = (documentId: number, title: string, answer: number, text = `Q${documentId}-${answer}`): ExamQuestion => ({
  documentId,
  documentTitle: title,
  question: text,
  options: ["a", "b", "c", "d"],
  answer,
  explanation: "Because.",
});

describe("formatClock", () => {
  it("shows minutes and seconds, and hours from an hour on", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7)).toBe("0:07");
    expect(formatClock(247)).toBe("4:07");
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3729)).toBe("1:02:09");
  });

  it("is never negative", () => {
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("timeLimit and elapsedSeconds", () => {
  it("allows a minute for each question", () => {
    expect(timeLimit(10)).toBe(600);
    expect(timeLimit(40)).toBe(2400);
  });

  it("counts whole seconds and never goes backwards", () => {
    expect(elapsedSeconds(1000, 1999)).toBe(0);
    expect(elapsedSeconds(1000, 2000)).toBe(1);
    expect(elapsedSeconds(5000, 1000)).toBe(0);
  });
});

describe("percentOf", () => {
  it("rounds, and an empty exam is zero", () => {
    expect(percentOf(7, 10)).toBe(70);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(0, 0)).toBe(0);
  });
});

describe("mark", () => {
  const questions = [q(1, "Biology", 0), q(1, "Biology", 2), q(2, "Chemistry", 1), q(2, "Chemistry", 3)];

  it("scores right answers, and lists what was wrong or left blank with what was chosen", () => {
    const marked = mark(questions, [0, 1, null, 3]);
    expect(marked.correct).toBe(2);
    expect(marked.total).toBe(4);
    expect(marked.percent).toBe(50);
    expect(marked.answered).toBe(3);
    expect(marked.missed.map((m) => [m.question.question, m.chosen])).toEqual([
      ["Q1-2", 1],
      ["Q2-1", null],
    ]);
  });

  it("breaks the score down by set, in the order of their titles", () => {
    const marked = mark([q(2, "Chemistry", 1), q(1, "Biology", 0), q(1, "Biology", 2)], [1, 0, 0]);
    expect(marked.breakdown).toEqual([
      { documentId: 1, title: "Biology", questions: 2, correct: 1 },
      { documentId: 2, title: "Chemistry", questions: 1, correct: 1 },
    ]);
  });

  it("takes missing answers as blank", () => {
    const marked = mark(questions, []);
    expect(marked.correct).toBe(0);
    expect(marked.answered).toBe(0);
    expect(marked.missed).toHaveLength(4);
  });

  it("handles no questions", () => {
    expect(mark([], [])).toMatchObject({ correct: 0, total: 0, percent: 0 });
  });
});

describe("collections", () => {
  const sets: ExamSet[] = [
    { id: 1, title: "A", tags: ["law", "year1"], questions: 5, canMake: true },
    { id: 2, title: "B", tags: ["law"], questions: 0, canMake: true },
    { id: 3, title: "C", tags: [], questions: 3, canMake: false },
  ];

  it("lists the tags with how many sets each holds, the biggest first", () => {
    expect(collectionsOf(sets)).toEqual([
      { tag: "law", sets: 2 },
      { tag: "year1", sets: 1 },
    ]);
  });

  it("finds the sets of one", () => {
    expect(setsOfCollection(sets, "law").map((s) => s.id)).toEqual([1, 2]);
    expect(setsOfCollection(sets, "none")).toEqual([]);
  });
});

describe("resultBody", () => {
  it("sends the score, the breakdown and only which questions were missed", () => {
    const marked = mark([q(1, "Biology", 0), q(1, "Biology", 2)], [0, 3]);
    expect(resultBody("law", [1], marked, 95)).toEqual({
      tag: "law",
      documentIds: [1],
      questions: 2,
      correct: 1,
      seconds: 95,
      breakdown: [{ documentId: 1, title: "Biology", questions: 2, correct: 1 }],
      missed: [{ documentId: 1, question: "Q1-2" }],
    });
  });
});

describe("trend", () => {
  it("turns the newest-first history into percentages, oldest first", () => {
    const record = (id: number, correct: number) => ({ id, tag: "x", questions: 10, correct, seconds: 60, finishedAt: "2026-10-18T10:00:00Z" });
    expect(trend([record(3, 9), record(2, 7), record(1, 5)])).toEqual([50, 70, 90]);
    expect(trend([])).toEqual([]);
  });
});
