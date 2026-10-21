"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";
import { useI18n } from "../../components/I18nProvider";
import { actionButton, fieldClass } from "../../components/styles";
import { API_URL, apiError } from "../../lib/api";
import {
  collectionsOf,
  COUNT_CHOICES,
  elapsedSeconds,
  formatClock,
  mark,
  percentOf,
  reopened,
  resultBody,
  setsOfCollection,
  timeLimit,
  trend,
  type ExamDraw,
  type ExamQuestion,
  type ExamRecord,
  type ExamSet,
  type Marked,
  type PastExam,
} from "../../lib/exam";
import PageTitle from "../../components/PageTitle";
import DrawnCheck from "../../components/DrawnCheck";

type Phase = "setup" | "run" | "results";
type Source = "collection" | "sets";

interface Run {
  questions: ExamQuestion[];
  answers: Array<number | null>;
  index: number;
  startedAt: number;
  // Seconds allowed, or null with no time limit.
  limit: number | null;
  // A run on the questions that were missed: it is not added to the history.
  practice: boolean;
  tag: string;
  documentIds: number[];
}

interface Finished {
  marked: Marked;
  seconds: number;
  timeUp: boolean;
  practice: boolean;
  tag: string;
  documentIds: number[];
  // Set when this is an exam from the past that has been opened again (and whether all of its questions were kept).
  past?: { id: number; finishedAt: string; complete: boolean };
}

const PAST_PAGE = 30;

const LETTERS = ["A", "B", "C", "D"];

// A mock exam: questions drawn from the quizzes of the person's study sets (a collection, or sets picked one by one), a timer
// if they want one, and no hint of the answers until the end. Then the score, the time, how each set did, the questions that
// were missed with their explanations, and the history of earlier exams on the same collection.
export default function ExamPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const { t, language } = useI18n();

  const [phase, setPhase] = useState<Phase>("setup");
  const [sets, setSets] = useState<ExamSet[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [source, setSource] = useState<Source>("collection");
  const [tag, setTag] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [count, setCount] = useState<number>(20);
  const [limitOn, setLimitOn] = useState(false);
  const [busy, setBusy] = useState<"" | "start" | "make">("");
  const [makeProgress, setMakeProgress] = useState({ done: 0, total: 0 });
  const [setupError, setSetupError] = useState("");
  const [draw, setDraw] = useState<ExamDraw | null>(null);

  const [run, setRun] = useState<Run | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [finished, setFinished] = useState<Finished | null>(null);
  const [history, setHistory] = useState<ExamRecord[]>([]);
  // The exams taken before, newest first: shown on the setup screen, where one can be opened again or deleted.
  const [past, setPast] = useState<ExamRecord[]>([]);
  const [pastMore, setPastMore] = useState(false);
  const [pastError, setPastError] = useState("");
  const [opening, setOpening] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [saveError, setSaveError] = useState("");
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (!authLoading && !user) router.push("/login");
  }, [authLoading, user, router]);

  const loadSets = useCallback(async () => {
    setLoadError("");
    try {
      const response = await axios.get<{ sets: ExamSet[] }>(`${API_URL}/exams/sources`);
      setSets(response.data.sets);
      const collections = collectionsOf(response.data.sets);
      setTag((current) => current || collections[0]?.tag || "");
      if (collections.length === 0) setSource("sets");
    } catch (err) {
      setLoadError(apiError(err, t("exam.loadFailed")));
    }
  }, [t]);

  useEffect(() => {
    if (user) void loadSets();
  }, [user, loadSets]);

  const loadPast = useCallback(
    async (offset = 0) => {
      setPastError("");
      try {
        const response = await axios.get<{ results: ExamRecord[] }>(`${API_URL}/exams/results`, { params: { limit: PAST_PAGE, offset } });
        const page = response.data.results;
        setPast((current) => (offset === 0 ? page : [...current, ...page]));
        setPastMore(page.length === PAST_PAGE);
      } catch (err) {
        setPastError(apiError(err, t("exam.pastLoadFailed")));
      }
    },
    [t]
  );

  useEffect(() => {
    if (user) void loadPast();
  }, [user, loadPast]);

  // Opens an exam from the past: laid out like a result that has just been marked, to be looked through again.
  const openPast = async (id: number) => {
    setOpening(id);
    setPastError("");
    try {
      const response = await axios.get<{ result: PastExam }>(`${API_URL}/exams/results/${id}`);
      const exam = response.data.result;
      const { marked, complete } = reopened(exam);
      const documentIds = [...new Set(exam.detail ? exam.detail.map((d) => d.documentId) : exam.breakdown.map((b) => b.documentId))];
      setHistory([]);
      setSaveError("");
      setFinished({
        marked,
        seconds: exam.seconds,
        timeUp: false,
        practice: false,
        tag: exam.tag,
        documentIds,
        past: { id: exam.id, finishedAt: exam.finishedAt, complete },
      });
      setPhase("results");
    } catch (err) {
      setPastError(apiError(err, t("exam.openFailed")));
    } finally {
      setOpening(null);
    }
  };

  const deletePast = async (id: number) => {
    setPastError("");
    try {
      await axios.delete(`${API_URL}/exams/results/${id}`);
      setPast((current) => current.filter((h) => h.id !== id));
    } catch (err) {
      setPastError(apiError(err, t("exam.deleteFailed")));
    } finally {
      setDeleting(null);
    }
  };

  const collections = useMemo(() => collectionsOf(sets ?? []), [sets]);
  const chosen: { tag: string; documentIds: number[] } | null =
    source === "collection"
      ? tag
        ? { tag, documentIds: setsOfCollection(sets ?? [], tag).map((s) => s.id) }
        : null
      : picked.length > 0
        ? { tag: "", documentIds: picked }
        : null;

  const begin = (questions: ExamQuestion[], practice: boolean, tagUsed: string, documentIds: number[]) => {
    setRun({
      questions,
      answers: questions.map(() => null),
      index: 0,
      startedAt: Date.now(),
      limit: limitOn ? timeLimit(questions.length) : null,
      practice,
      tag: tagUsed,
      documentIds,
    });
    setNow(Date.now());
    setConfirmFinish(false);
    setFinished(null);
    setSaveError("");
    setAnnouncement("");
    setPhase("run");
  };

  const drawExam = async (): Promise<ExamDraw | null> => {
    if (!chosen) return null;
    const body = chosen.tag ? { tag: chosen.tag, count } : { documentIds: chosen.documentIds, count };
    const response = await axios.post<ExamDraw>(`${API_URL}/exams`, body);
    setDraw(response.data);
    return response.data;
  };

  const start = async () => {
    if (!chosen) return;
    setBusy("start");
    setSetupError("");
    setDraw(null);
    try {
      const drawn = await drawExam();
      if (drawn && drawn.questions.length > 0 && drawn.missing.length === 0) {
        begin(drawn.questions, false, chosen.tag, [...new Set(drawn.questions.map((q) => q.documentId))]);
      }
    } catch (err) {
      setSetupError(apiError(err, t("exam.startFailed")));
    } finally {
      setBusy("");
    }
  };

  // Makes the quizzes the chosen sets lack, one after another (each uses one chat question), then draws again.
  const makeQuizzes = async () => {
    if (!draw) return;
    setBusy("make");
    setSetupError("");
    setMakeProgress({ done: 0, total: draw.missing.length });
    try {
      for (const [i, set] of draw.missing.entries()) {
        await axios.post(`${API_URL}/documents/${set.id}/study`, { kind: "quiz" });
        setMakeProgress({ done: i + 1, total: draw.missing.length });
      }
      await loadSets();
      await drawExam();
    } catch (err) {
      setSetupError(apiError(err, t("exam.makeFailed")));
      await loadSets();
    } finally {
      setBusy("");
    }
  };

  const startWithWhatThereIs = () => {
    if (!draw || !chosen || draw.questions.length === 0) return;
    begin(draw.questions, false, chosen.tag, [...new Set(draw.questions.map((q) => q.documentId))]);
  };

  // ---- taking the exam ---------------------------------------------------------------------------------------------

  const elapsed = run ? elapsedSeconds(run.startedAt, now) : 0;
  const remaining = run && run.limit !== null ? Math.max(0, run.limit - elapsed) : null;

  const finish = useCallback(
    async (current: Run, timeUp: boolean) => {
      const spent = Math.min(elapsedSeconds(current.startedAt, Date.now()), current.limit ?? Number.MAX_SAFE_INTEGER);
      const marked = mark(current.questions, current.answers);
      const done: Finished = { marked, seconds: spent, timeUp, practice: current.practice, tag: current.tag, documentIds: current.documentIds };
      setRun(null);
      setFinished(done);
      setPhase("results");
      setSaveError("");
      if (current.practice) return;
      try {
        await axios.post(`${API_URL}/exams/results`, resultBody(current.tag, current.documentIds, marked, spent, current.questions, current.answers));
        void loadPast();
      } catch (err) {
        setSaveError(apiError(err, t("exam.saveFailed")));
      }
      try {
        const response = await axios.get<{ results: ExamRecord[] }>(`${API_URL}/exams/results`, { params: { tag: current.tag } });
        setHistory(response.data.results);
      } catch {
        setHistory([]);
      }
    },
    [t, loadPast]
  );

  // The clock: one tick a second while an exam is open. When a time limit runs out the exam is marked as it stands.
  useEffect(() => {
    if (phase !== "run") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const finishedByClock = useRef(false);
  useEffect(() => {
    if (phase !== "run" || !run) {
      finishedByClock.current = false;
      return;
    }
    if (remaining === 60) setAnnouncement(t("exam.oneMinute"));
    if (remaining === 0 && !finishedByClock.current) {
      finishedByClock.current = true;
      void finish(run, true);
    }
  }, [phase, run, remaining, finish, t]);

  const choose = useCallback((option: number) => {
    setRun((current) => (current ? { ...current, answers: current.answers.map((a, i) => (i === current.index ? option : a)) } : current));
    setConfirmFinish(false);
  }, []);

  const goTo = (index: number) => {
    setRun((current) => (current ? { ...current, index } : current));
    setConfirmFinish(false);
  };

  // Keys 1 to 4 choose an answer, as long as no other control is being typed into.
  useEffect(() => {
    if (phase !== "run") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (target !== document.body && !(target instanceof HTMLInputElement && target.type === "radio")) return;
      const option = Number(e.key) - 1;
      if (option >= 0 && option < 4) choose(option);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, choose]);

  const unanswered = run ? run.answers.filter((a) => a === null).length : 0;
  const question = run ? run.questions[run.index] : null;

  const newExam = () => {
    setPhase("setup");
    setRun(null);
    setFinished(null);
    setDraw(null);
  };

  const practiseMissed = () => {
    if (!finished || finished.marked.missed.length === 0) return;
    begin(
      finished.marked.missed.map((m) => m.question),
      true,
      finished.tag,
      finished.documentIds
    );
  };

  if (authLoading || !user) return <p className="mt-20 text-center text-lg text-ink/70">{t("common.loadingDashboard")}</p>;

  const dateOf = (iso: string) => new Date(iso).toLocaleDateString(language);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:py-10">
      <PageTitle className="mb-3">{t("exam.title")}</PageTitle>

      {loadError && (
        <p className="text-base font-medium text-danger" role="alert">
          {loadError}
        </p>
      )}

      {/* ---------------------------------------------------------------- setup */}
      {phase === "setup" && (
        <>
          <p className="muted mb-6">{t("exam.intro")}</p>
          {!sets && !loadError && <p role="status">{t("common.loading")}</p>}

          {sets && sets.length === 0 && (
            <div className="card text-center" data-testid="exam-empty">
              <p>{t("exam.noSets")}</p>
              <Link href="/dashboard" className="btn btn-secondary mt-5">
                {t("review.library")}
              </Link>
            </div>
          )}

          {sets && sets.length > 0 && (
            <form
              className="card space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                void start();
              }}
              data-testid="exam-setup"
            >
              <fieldset className="space-y-3">
                <legend className="text-base font-semibold">{t("exam.sourceLegend")}</legend>
                <label className="flex items-center gap-2 text-base">
                  <input type="radio" name="source" checked={source === "collection"} onChange={() => setSource("collection")} disabled={collections.length === 0} />
                  {t("exam.sourceCollection")}
                </label>
                {source === "collection" && collections.length > 0 && (
                  <label className="ml-6 flex flex-wrap items-center gap-2 text-base">
                    <span>{t("exam.collection")}</span>
                    <select value={tag} onChange={(e) => setTag(e.target.value)} className={fieldClass} data-testid="exam-collection">
                      {collections.map((c) => (
                        <option key={c.tag} value={c.tag}>
                          {t("exam.collectionOption", { tag: c.tag, n: c.sets })}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {collections.length === 0 && <p className="muted ml-6 text-sm">{t("exam.noCollections")}</p>}
                <label className="flex items-center gap-2 text-base">
                  <input type="radio" name="source" checked={source === "sets"} onChange={() => setSource("sets")} />
                  {t("exam.sourceSets")}
                </label>
                {source === "sets" && (
                  <ul className="ml-6 max-h-60 space-y-1 overflow-y-auto" data-testid="exam-sets">
                    {sets.map((set) => (
                      <li key={set.id}>
                        <label className="flex items-start gap-2 text-base">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={picked.includes(set.id)}
                            onChange={(e) => setPicked((p) => (e.target.checked ? [...p, set.id] : p.filter((id) => id !== set.id)))}
                          />
                          <span>
                            {set.title}
                            <span className="muted text-sm"> · {set.questions > 0 ? t("exam.setQuestions", { n: set.questions }) : t("exam.setNoQuiz")}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </fieldset>

              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-base">
                  <span>{t("exam.count")}</span>
                  <select value={count} onChange={(e) => setCount(Number(e.target.value))} className={fieldClass} data-testid="exam-count">
                    {COUNT_CHOICES.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-base">
                  <input type="checkbox" checked={limitOn} onChange={(e) => setLimitOn(e.target.checked)} />
                  {t("exam.limit")}
                </label>
              </div>
              <p className="muted text-sm">{t("exam.limitNote")}</p>

              {setupError && (
                <p className="text-base font-medium text-danger" role="alert">
                  {setupError}
                </p>
              )}

              {draw && draw.missing.length > 0 && (
                <div className="rounded-xl border border-ink/20 p-4" data-testid="exam-missing">
                  <p className="font-semibold">{t("exam.missingTitle", { n: draw.missing.length })}</p>
                  <ul className="mt-1 list-disc pl-5 text-sm">
                    {draw.missing.map((m) => (
                      <li key={m.id}>{m.title}</li>
                    ))}
                  </ul>
                  <p className="muted mt-2 text-sm">{t("exam.missingNote", { n: draw.missing.length })}</p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <button type="button" onClick={() => void makeQuizzes()} disabled={busy !== ""} className="btn btn-primary btn-sm">
                      {busy === "make" ? t("exam.making", { done: makeProgress.done, total: makeProgress.total }) : t("exam.makeQuizzes")}
                    </button>
                    {draw.questions.length > 0 && (
                      <button type="button" onClick={startWithWhatThereIs} disabled={busy !== ""} className={actionButton}>
                        {t("exam.startWithThese", { n: draw.questions.length })}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {draw && draw.missing.length === 0 && draw.questions.length === 0 && (
                <p className="text-base font-medium" role="status" data-testid="exam-none">
                  {t("exam.noQuestions")}
                </p>
              )}
              {draw && draw.questions.length > 0 && draw.questions.length < count && draw.missing.length === 0 && (
                <p className="muted text-sm">{t("exam.fewer", { n: draw.questions.length })}</p>
              )}

              <div>
                <button type="submit" disabled={!chosen || busy !== ""} className="btn btn-primary">
                  {busy === "start" ? t("exam.starting") : t("exam.start")}
                </button>
              </div>
            </form>
          )}

          {(past.length > 0 || pastError) && (
            <section className="card mt-6" aria-labelledby="exam-past" data-testid="exam-past">
              <h2 id="exam-past" className="text-xl">
                {t("exam.pastTitle")}
              </h2>
              {past.length > 0 && (
                <div className="mt-3 flex h-16 items-end gap-1" aria-hidden="true">
                  {trend(past.slice(0, 15)).map((percent, i) => (
                    <div key={i} className="w-4 rounded-t bg-accent/70" style={{ height: `${Math.max(4, percent)}%` }} />
                  ))}
                </div>
              )}
              <ul className="mt-3 divide-y divide-ink/15">
                {past.map((h) => {
                  const when = dateOf(h.finishedAt);
                  return (
                    <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="exam-past-item">
                      <span className="text-sm">
                        <span className="block font-medium">{h.tag ? t("exam.pastCollection", { tag: h.tag }) : t("exam.pastSets", { n: h.sets ?? 1 })}</span>
                        {t("exam.historyRow", {
                          when,
                          correct: h.correct,
                          questions: h.questions,
                          percent: percentOf(h.correct, h.questions),
                          time: formatClock(h.seconds),
                        })}
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        <button type="button" onClick={() => void openPast(h.id)} disabled={opening !== null} className={actionButton} aria-label={t("exam.openExam", { when })}>
                          {t("exam.open")}
                        </button>
                        {deleting === h.id ? (
                          <>
                            <span className="text-sm font-medium">{t("exam.deleteConfirm")}</span>
                            <button type="button" onClick={() => void deletePast(h.id)} className="btn btn-danger btn-sm">
                              {t("exam.deleteYes")}
                            </button>
                            <button type="button" onClick={() => setDeleting(null)} className={actionButton}>
                              {t("common.cancel")}
                            </button>
                          </>
                        ) : (
                          <button type="button" onClick={() => setDeleting(h.id)} className={actionButton} aria-label={t("exam.deleteExam", { when })}>
                            {t("exam.delete")}
                          </button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {pastMore && (
                <button type="button" onClick={() => void loadPast(past.length)} className={`${actionButton} mt-3`}>
                  {t("exam.showMore")}
                </button>
              )}
              {pastError && (
                <p className="mt-3 text-sm font-medium text-danger" role="alert">
                  {pastError}
                </p>
              )}
            </section>
          )}
        </>
      )}

      {/* ------------------------------------------------------------------ run */}
      {phase === "run" && run && question && (
        <div data-testid="exam-run">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm font-medium">
            <span data-testid="exam-position">{t("exam.questionOf", { n: run.index + 1, total: run.questions.length })}</span>
            <span className="muted">{run.practice ? t("exam.practising") : ""}</span>
            <span data-testid="exam-clock">
              {remaining !== null ? t("exam.timeLeft") : t("exam.timeSpent")}:{" "}
              <span role="timer" aria-live="off" className="font-semibold tabular-nums">
                {formatClock(remaining !== null ? remaining : elapsed)}
              </span>
            </span>
          </div>
          <div className="sr-only" role="status" aria-live="polite">
            {announcement}
          </div>

          <nav aria-label={t("exam.navigator")} className="mb-4 flex flex-wrap gap-1.5">
            {run.questions.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                aria-label={t("exam.goTo", { n: i + 1 }) + (run.answers[i] === null ? "" : ` (${t("exam.answered")})`)}
                aria-current={i === run.index ? "step" : undefined}
                className={`tap-square h-8 min-w-8 rounded-md border px-2 text-sm font-medium ${
                  i === run.index ? "border-ink bg-ink text-canvas" : run.answers[i] !== null ? "border-accent bg-accent/15" : "border-ink/30"
                }`}
              >
                {i + 1}
              </button>
            ))}
          </nav>

          <fieldset className="card" key={run.index}>
            <legend className="sr-only">{t("exam.questionOf", { n: run.index + 1, total: run.questions.length })}</legend>
            <p className="muted mb-2 text-sm">{t("exam.from", { title: question.documentTitle })}</p>
            <p className="text-xl font-semibold" data-testid="exam-question">
              {question.question}
            </p>
            <div className="mt-4 space-y-2" role="radiogroup" aria-label={t("exam.chooseAnswer")}>
              {question.options.map((option, i) => (
                <label
                  key={i}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-base ${
                    run.answers[run.index] === i ? "border-accent bg-accent/10" : "border-ink/25 hover:bg-ink/5"
                  }`}
                >
                  <input type="radio" name={`q-${run.index}`} className="mt-1" checked={run.answers[run.index] === i} onChange={() => choose(i)} />
                  <span>
                    <span className="font-semibold">{LETTERS[i]}.</span> {option}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="muted mt-2 text-sm">{t("exam.keys")}</p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => goTo(run.index - 1)} disabled={run.index === 0} className={actionButton}>
              {t("exam.prev")}
            </button>
            <button type="button" onClick={() => goTo(run.index + 1)} disabled={run.index === run.questions.length - 1} className={actionButton}>
              {t("exam.next")}
            </button>
            <button
              type="button"
              onClick={() => (unanswered > 0 ? setConfirmFinish(true) : void finish(run, false))}
              className="btn btn-primary btn-sm ml-auto"
            >
              {t("exam.finish")}
            </button>
          </div>

          {confirmFinish && (
            <div className="mt-4 rounded-xl border border-ink/30 p-4" role="alertdialog" aria-label={t("exam.finish")} data-testid="exam-confirm">
              <p className="font-medium">{t("exam.unanswered", { n: unanswered })}</p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button type="button" onClick={() => void finish(run, false)} className="btn btn-primary btn-sm">
                  {t("exam.finishAnyway")}
                </button>
                <button type="button" onClick={() => setConfirmFinish(false)} className={actionButton}>
                  {t("exam.keepGoing")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* -------------------------------------------------------------- results */}
      {phase === "results" && finished && (
        <div className="space-y-6" data-testid="exam-results">
          <div className="card text-center">
            {!finished.past && <DrawnCheck className="mb-3" />}
            {finished.timeUp && (
              <p className="mb-2 font-medium" role="status">
                {t("exam.timeUp")}
              </p>
            )}
            <h2 className="text-2xl">
              {finished.past ? t("exam.pastResult", { when: dateOf(finished.past.finishedAt) }) : finished.practice ? t("exam.practiceResult") : t("exam.resultsTitle")}
            </h2>
            <p className="mt-3 text-3xl font-semibold" data-testid="exam-score">
              {t("exam.score", { correct: finished.marked.correct, total: finished.marked.total, percent: finished.marked.percent })}
            </p>
            <p className="muted mt-1">{t("exam.timeTaken", { time: formatClock(finished.seconds) })}</p>
            {finished.practice && <p className="muted mt-1 text-sm">{t("exam.practiceNote")}</p>}
            {finished.past && !finished.past.complete && <p className="muted mt-2 text-sm">{t("exam.pastLimited")}</p>}
            {saveError && (
              <p className="mt-2 text-sm font-medium text-danger" role="alert">
                {saveError}
              </p>
            )}
          </div>

          <section className="card" aria-labelledby="exam-breakdown">
            <h2 id="exam-breakdown" className="text-xl">
              {t("exam.breakdown")}
            </h2>
            <ul className="mt-3 space-y-2" data-testid="exam-breakdown">
              {finished.marked.breakdown.map((b) => (
                <li key={b.documentId} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{b.title}</span>
                  <span className="font-medium">{t("exam.breakdownRow", { correct: b.correct, questions: b.questions, percent: percentOf(b.correct, b.questions) })}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card" aria-labelledby="exam-missed">
            <h2 id="exam-missed" className="text-xl">
              {t("exam.missedTitle")}
            </h2>
            {finished.marked.missed.length === 0 ? (
              <p className="mt-3" data-testid="exam-allright">
                {t("exam.allRight")}
              </p>
            ) : (
              <ol className="mt-3 space-y-4" data-testid="exam-missed">
                {finished.marked.missed.map((m, i) => (
                  <li key={i} className="rounded-xl border border-ink/20 p-3" data-testid="exam-missed-item">
                    <p className="font-semibold">{m.question.question}</p>
                    {m.question.options.length > 0 && (
                      <>
                        <p className="mt-2 text-sm">
                          <span className="font-medium">{t("exam.yourAnswer")}:</span>{" "}
                          {m.chosen === null ? t("exam.noAnswer") : `${LETTERS[m.chosen]}. ${m.question.options[m.chosen]}`}
                        </p>
                        <p className="text-sm">
                          <span className="font-medium">{t("exam.rightAnswer")}:</span> {LETTERS[m.question.answer]}. {m.question.options[m.question.answer]}
                        </p>
                        {m.question.explanation && <p className="muted mt-1 text-sm">{m.question.explanation}</p>}
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {!finished.practice && history.length > 0 && (
            <section className="card" aria-labelledby="exam-history">
              <h2 id="exam-history" className="text-xl">
                {finished.tag ? t("exam.historyTitle", { tag: finished.tag }) : t("exam.historyTitleSets")}
              </h2>
              <div className="mt-3 flex h-16 items-end gap-1" aria-hidden="true">
                {trend(history.slice(0, 15)).map((percent, i) => (
                  <div key={i} className="w-4 rounded-t bg-accent/70" style={{ height: `${Math.max(4, percent)}%` }} />
                ))}
              </div>
              <ul className="mt-3 space-y-1 text-sm" data-testid="exam-history">
                {history.slice(0, 10).map((h) => (
                  <li key={h.id}>
                    {t("exam.historyRow", {
                      when: dateOf(h.finishedAt),
                      correct: h.correct,
                      questions: h.questions,
                      percent: percentOf(h.correct, h.questions),
                      time: formatClock(h.seconds),
                    })}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap justify-center gap-3">
            {finished.marked.missed.length > 0 && (!finished.past || finished.past.complete) && (
              <button type="button" onClick={practiseMissed} className="btn btn-primary">
                {t("exam.practise")}
              </button>
            )}
            <button type="button" onClick={newExam} className="btn btn-secondary">
              {finished.past ? t("exam.backToExams") : t("exam.again")}
            </button>
            <Link href="/dashboard" className="btn btn-secondary">
              {t("review.library")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
