"use client";
import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import type { CardProgress, QuizQuestion, StudyCard } from "../types";
import { API_URL, apiError } from "../lib/api";
import { downloadBlob } from "../lib/exportDoc";
import { cardsCsv, cardsFileName, shuffled } from "../lib/study";
import { useT } from "./I18nProvider";
import { actionButton, textButton } from "./styles";

type Kind = "flashcards" | "quiz";

interface StudyPanelProps {
  documentId: number;
  // The document's title, for the name of the downloaded cards.
  title: string;
  // Show the flashcards at once (they were just made, or are already kept, so this costs nothing).
  autoStart?: boolean;
}

interface Loaded {
  cards?: StudyCard[];
  questions?: QuizQuestion[];
}

// Flashcards and a quiz made from a document. Each is written once and kept, so opening it again is free.
export default function StudyPanel({ documentId, title, autoStart = false }: StudyPanelProps) {
  const t = useT();
  const [kind, setKind] = useState<Kind | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    async (which: Kind, regenerate = false) => {
      setKind(which);
      setError("");
      if (!regenerate && (which === "flashcards" ? loaded.cards : loaded.questions)) return;
      setLoading(true);
      try {
        const response = await axios.post<{ cards?: StudyCard[]; questions?: QuizQuestion[] }>(
          `${API_URL}/documents/${documentId}/study`,
          { kind: which, regenerate }
        );
        setLoaded((prev) =>
          which === "flashcards" ? { ...prev, cards: response.data.cards } : { ...prev, questions: response.data.questions }
        );
      } catch (err) {
        setError(apiError(err, t("study.failed")));
      } finally {
        setLoading(false);
      }
    },
    [documentId, loaded, t]
  );

  useEffect(() => {
    if (autoStart) void load("flashcards");
    // Only once, when the panel opens: later changes of `load` must not ask again.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mt-4 rounded-xl border border-ink/20 bg-canvas/50 p-4" data-testid="study">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => load("flashcards")} aria-pressed={kind === "flashcards"} className={`${actionButton} aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-accent-fg`}>
          {t("study.flashcards")}
        </button>
        <button type="button" onClick={() => load("quiz")} aria-pressed={kind === "quiz"} className={`${actionButton} aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-accent-fg`}>
          {t("study.quiz")}
        </button>
        {kind && !loading && (
          <button type="button" onClick={() => load(kind, true)} className={textButton}>
            {t("study.newOnes")}
          </button>
        )}
      </div>

      {!kind && <p className="mt-3 text-base text-ink/70">{t("study.intro")}</p>}
      {loading && (
        <p className="mt-3 text-base font-medium text-ink/70" role="status">
          {t("study.writing")}
        </p>
      )}
      {error && (
        <p className="mt-3 text-base font-medium text-danger" role="alert">
          {error}
        </p>
      )}
      {!loading && kind === "flashcards" && loaded.cards && <Flashcards key={loaded.cards[0]?.front} cards={loaded.cards} title={title} documentId={documentId} />}
      {!loading && kind === "quiz" && loaded.questions && <Quiz key={loaded.questions[0]?.question} questions={loaded.questions} />}
    </div>
  );
}

// ---- flashcards ----------------------------------------------------------------------------------------

function Flashcards({ cards, title, documentId }: { cards: StudyCard[]; title: string; documentId: number }) {
  const t = useT();
  // How well each card is known (only cards that were rated), kept by the server for spaced repetition.
  const [progress, setProgress] = useState<Record<string, CardProgress>>({});
  const [rating, setRating] = useState(false);
  const [rateError, setRateError] = useState("");
  useEffect(() => {
    let cancelled = false;
    axios
      .get<{ cards: CardProgress[] }>(`${API_URL}/documents/${documentId}/cards/progress`)
      .then((response) => {
        if (!cancelled) setProgress(Object.fromEntries(response.data.cards.map((c) => [c.front, c])));
      })
      .catch(() => {
        // Without the progress the cards still work; they just show no status.
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);
  const [order, setOrder] = useState(() => cards.map((_, i) => i));
  const [position, setPosition] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const card = cards[order[position]];

  const go = (delta: number) => {
    setPosition((p) => Math.min(order.length - 1, Math.max(0, p + delta)));
    setFlipped(false);
  };

  // Say whether the card was known: it comes back sooner or later, and the next card is shown.
  const rate = async (knew: boolean) => {
    setRating(true);
    setRateError("");
    try {
      const response = await axios.post<{ box: number; dueOn: string }>(`${API_URL}/documents/${documentId}/cards/review`, { front: card.front, knew });
      setProgress((prev) => ({ ...prev, [card.front]: { front: card.front, box: response.data.box, dueOn: response.data.dueOn, due: !knew } }));
      if (position < order.length - 1) go(1);
      else setFlipped(false);
    } catch (err) {
      setRateError(apiError(err, t("study.rateFailed")));
    } finally {
      setRating(false);
    }
  };
  const known = progress[card.front];
  const dueCount = Object.values(progress).filter((p) => p.due).length;

  return (
    <div className="mt-3" data-testid="flashcards">
      <button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        aria-label={flipped ? t("study.showQuestion") : t("study.showAnswer")}
        className="block min-h-44 w-full rounded-2xl border border-ink/30 bg-surface p-6 text-center text-xl shadow-sm hover:bg-ink/5"
        data-testid="flashcard"
      >
        <span className="block text-xs font-semibold uppercase tracking-widest text-ink/70">{flipped ? t("study.answer") : t("study.question")}</span>
        <span className="mt-2 block">{flipped ? card.back : card.front}</span>
      </button>
      <p className="muted mt-2 text-sm" data-testid="card-status">
        {!known
          ? t("study.status.new")
          : known.due
          ? t("study.status.due")
          : t("study.status.box", { box: known.box, date: new Date(known.dueOn + "T12:00:00").toLocaleDateString() })}
        {dueCount > 0 && <> · {t("study.dueCount", { n: dueCount })}</>}
      </p>
      {flipped && (
        <div className="mt-3 flex flex-wrap items-center gap-3" role="group" aria-label={t("study.rateHint")} data-testid="rate-card">
          <span className="text-sm font-medium">{t("study.rateHint")}</span>
          <button type="button" onClick={() => void rate(false)} disabled={rating} className={actionButton}>
            {t("study.missed")}
          </button>
          <button type="button" onClick={() => void rate(true)} disabled={rating} className="btn btn-primary btn-sm">
            {t("study.knew")}
          </button>
        </div>
      )}
      {rateError && (
        <p className="mt-2 text-sm font-medium text-danger" role="alert">
          {rateError}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium tabular-nums" data-testid="flashcard-position">
          {position + 1} / {order.length}
        </span>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => go(-1)} disabled={position === 0} className={actionButton}>
            {t("study.back")}
          </button>
          <button type="button" onClick={() => go(1)} disabled={position === order.length - 1} className={actionButton}>
            {t("study.next")}
          </button>
          <button
            type="button"
            onClick={() => {
              setOrder(shuffled(order));
              setPosition(0);
              setFlipped(false);
            }}
            className={textButton}
          >
            {t("study.shuffle")}
          </button>
          <button
            type="button"
            onClick={() => downloadBlob(new Blob([cardsCsv(cards)], { type: "text/csv;charset=utf-8" }), cardsFileName(title))}
            className={textButton}
          >
            {t("study.exportCsv")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- quiz ----------------------------------------------------------------------------------------------------

function Quiz({ questions }: { questions: QuizQuestion[] }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div className="mt-3" data-testid="quiz-result">
        <p className="text-xl font-semibold">
          {t("quiz.score", { score, total: questions.length })}
        </p>
        <button
          type="button"
          onClick={() => {
            setIndex(0);
            setChosen(null);
            setScore(0);
            setDone(false);
          }}
          className={`${actionButton} mt-3`}
        >
          {t("quiz.again")}
        </button>
      </div>
    );
  }

  const q = questions[index];
  const answered = chosen !== null;
  const choose = (i: number) => {
    if (answered) return;
    setChosen(i);
    if (i === q.answer) setScore((s) => s + 1);
  };

  return (
    <div className="mt-3" data-testid="quiz">
      <p className="text-xs font-semibold uppercase tracking-widest text-ink/70">
        {t("quiz.progress", { n: index + 1, total: questions.length })}
      </p>
      <p className="mt-1 text-xl font-semibold">{q.question}</p>
      <ul className="mt-3 space-y-2">
        {q.options.map((option, i) => {
          const right = answered && i === q.answer;
          const wrong = answered && i === chosen && i !== q.answer;
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => choose(i)}
                disabled={answered}
                className={`w-full rounded-lg border px-4 py-3 text-left text-base ${
                  right ? "border-accent bg-accent text-accent-fg" : wrong ? "border-danger text-danger" : "border-ink/40 hover:bg-ink/5"
                } disabled:cursor-default`}
              >
                {right && <span className="sr-only">{t("quiz.correctSr")}</span>}
                {wrong && <span className="sr-only">{t("quiz.wrongSr")}</span>}
                {option}
              </button>
            </li>
          );
        })}
      </ul>
      {answered && (
        <div className="mt-3" role="status">
          <p className="text-base font-semibold">{chosen === q.answer ? t("quiz.correct") : t("quiz.notQuite", { answer: q.options[q.answer] })}</p>
          {q.explanation && <p className="text-sm text-ink/70">{q.explanation}</p>}
          <button
            type="button"
            onClick={() => (index + 1 < questions.length ? (setIndex(index + 1), setChosen(null)) : setDone(true))}
            className={`${actionButton} mt-3`}
          >
            {index + 1 < questions.length ? t("quiz.next") : t("quiz.seeScore")}
          </button>
        </div>
      )}
    </div>
  );
}
