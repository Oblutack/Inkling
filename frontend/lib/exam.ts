// Exam mode: a mock exam drawn from the quizzes of a person's study sets. The questions come from the server (mixed, with the
// options of each in a new order); marking is done here, and only the result is sent back to be kept.

export interface ExamQuestion {
  documentId: number;
  documentTitle: string;
  question: string;
  options: string[];
  // The index of the right option.
  answer: number;
  explanation: string;
}

// A study set that an exam can be made from: with a quiz already, or one that can be made for it.
export interface ExamSet {
  id: number;
  title: string;
  tags: string[];
  questions: number;
  canMake: boolean;
}

export interface ExamDraw {
  questions: ExamQuestion[];
  // How many questions the chosen sets hold in all.
  available: number;
  // Chosen sets with no quiz yet that one can be made for.
  missing: ExamSet[];
}

export const COUNT_CHOICES = [10, 20, 30, 40] as const;
export const MAX_QUESTIONS = 40;
export const SECONDS_PER_QUESTION = 60;

// The time allowed when a time limit is on: a minute a question.
export function timeLimit(questions: number): number {
  return questions * SECONDS_PER_QUESTION;
}

// "4:07", or "1:02:09" from an hour on.
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

// Whole seconds from `startedAt` to `now` (both in milliseconds); never negative.
export function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

export interface Breakdown {
  documentId: number;
  title: string;
  questions: number;
  correct: number;
}

export interface Missed {
  question: ExamQuestion;
  // The option chosen, or null when the question was left unanswered.
  chosen: number | null;
}

export interface Marked {
  correct: number;
  total: number;
  percent: number;
  answered: number;
  missed: Missed[];
  breakdown: Breakdown[];
}

export function percentOf(correct: number, total: number): number {
  return total > 0 ? Math.round((correct / total) * 100) : 0;
}

// Marks an exam: `answers[i]` is the option chosen for question i (null for none).
export function mark(questions: readonly ExamQuestion[], answers: ReadonlyArray<number | null>): Marked {
  const missed: Missed[] = [];
  const perSet = new Map<number, Breakdown>();
  let correct = 0;
  let answered = 0;
  questions.forEach((question, i) => {
    const chosen = answers[i] ?? null;
    if (chosen !== null) answered += 1;
    const entry = perSet.get(question.documentId) ?? { documentId: question.documentId, title: question.documentTitle, questions: 0, correct: 0 };
    entry.questions += 1;
    if (chosen === question.answer) {
      correct += 1;
      entry.correct += 1;
    } else {
      missed.push({ question, chosen });
    }
    perSet.set(question.documentId, entry);
  });
  const breakdown = [...perSet.values()].sort((a, b) => a.title.localeCompare(b.title) || a.documentId - b.documentId);
  return { correct, total: questions.length, percent: percentOf(correct, questions.length), answered, missed, breakdown };
}

// The sets of a collection (tag), with how many sets each has that an exam could use: the tags to choose from.
export function collectionsOf(sets: readonly ExamSet[]): Array<{ tag: string; sets: number }> {
  const counts = new Map<string, number>();
  for (const set of sets) for (const tag of set.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].map(([tag, n]) => ({ tag, sets: n })).sort((a, b) => b.sets - a.sets || a.tag.localeCompare(b.tag));
}

// The sets an exam on a collection would draw on.
export function setsOfCollection(sets: readonly ExamSet[], tag: string): ExamSet[] {
  return sets.filter((s) => s.tags.includes(tag));
}

// One question of a finished exam as the server keeps it: the question as it was asked, and the option chosen (null when it was left alone).
export interface KeptQuestion extends ExamQuestion {
  chosen: number | null;
}

// What is sent to be kept once an exam is finished: the score, how each set did, and every question as it was asked with what was
// chosen, so the exam can be opened again later.
export function resultBody(
  tag: string,
  documentIds: number[],
  marked: Marked,
  seconds: number,
  questions: readonly ExamQuestion[],
  answers: ReadonlyArray<number | null>
) {
  return {
    tag,
    documentIds,
    questions: marked.total,
    correct: marked.correct,
    seconds,
    breakdown: marked.breakdown,
    missed: marked.missed.map((m) => ({ documentId: m.question.documentId, question: m.question.question })),
    detail: questions.map((question, i): KeptQuestion => ({ ...question, chosen: answers[i] ?? null })),
  };
}

// A past exam in the list: when, what it was drawn from, how it went, and whether it can be opened with all of its questions.
export interface ExamRecord {
  id: number;
  tag: string;
  questions: number;
  correct: number;
  seconds: number;
  finishedAt: string;
  // How many sets it was drawn from, and whether its questions were kept (exams taken before that was added have only a score).
  sets?: number;
  hasDetail?: boolean;
}

// A past exam opened: the record, how each set did, the questions that were missed and, when they were kept, every question.
export interface PastExam extends ExamRecord {
  breakdown: Breakdown[];
  missed: Array<{ documentId: number; question: string }>;
  detail: KeptQuestion[] | null;
}

// A past exam laid out the way a finished one is, to be looked through again. `complete` is false for an exam taken before the
// questions were kept: then only the score, the sets and the text of the questions that were missed are known.
export function reopened(past: PastExam): { marked: Marked; complete: boolean } {
  if (past.detail && past.detail.length > 0) {
    const questions: ExamQuestion[] = past.detail.map(({ chosen: _chosen, ...question }) => question);
    return {
      marked: mark(
        questions,
        past.detail.map((d) => d.chosen)
      ),
      complete: true,
    };
  }
  const missed: Missed[] = past.missed.map((m) => ({
    question: { documentId: m.documentId, documentTitle: "", question: m.question, options: [], answer: -1, explanation: "" },
    chosen: null,
  }));
  return {
    marked: {
      correct: past.correct,
      total: past.questions,
      percent: percentOf(past.correct, past.questions),
      answered: past.questions,
      missed,
      breakdown: past.breakdown,
    },
    complete: false,
  };
}

// The scores of past exams, oldest first, as percentages (for a small chart of how a collection is going).
export function trend(records: readonly ExamRecord[]): number[] {
  return [...records].reverse().map((r) => percentOf(r.correct, r.questions));
}
