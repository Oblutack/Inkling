"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";
import { useT } from "../../components/I18nProvider";
import { API_URL, apiError } from "../../lib/api";
import { answer, currentCard, isFinished, startSession, type Session } from "../../lib/review";
import { syncTimeZone } from "../../lib/timezone";
import type { DueCard, StudyStats } from "../../types";
import { actionButton } from "../../components/styles";

// A review session: the flashcards that are due today, from all the person's study sets, one at a time. Press the card to see
// the answer, then say whether it was known. A card that was missed comes round again before the end.
export default function ReviewPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const t = useT();
  const [session, setSession] = useState<Session<DueCard> | null>(null);
  const [stats, setStats] = useState<StudyStats | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [rateError, setRateError] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    setSession(null);
    setFlipped(false);
    try {
      await syncTimeZone(); // "due today" is the person's own day
      const [due, s] = await Promise.all([
        axios.get<{ cards: DueCard[]; total: number }>(`${API_URL}/study/due`),
        axios.get<StudyStats>(`${API_URL}/study/stats`),
      ]);
      setSession(startSession(due.data.cards));
      setStats(s.data);
    } catch (err) {
      setLoadError(apiError(err, t("review.loadFailed")));
    }
  }, [t]);

  useEffect(() => {
    if (!authLoading && !user) router.push("/login");
  }, [authLoading, user, router]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const card = session ? currentCard(session) : undefined;

  const rate = useCallback(
    async (knew: boolean) => {
      if (!session || !card || busy) return;
      setBusy(true);
      setRateError("");
      try {
        await axios.post(`${API_URL}/documents/${card.documentId}/cards/review`, { front: card.front, knew });
        const next = answer(session, knew);
        setSession(next);
        setFlipped(false);
        if (isFinished(next)) {
          // The streak and the count of what is left are known to the server now.
          axios.get<StudyStats>(`${API_URL}/study/stats`).then((r) => setStats(r.data)).catch(() => undefined);
        }
      } catch (err) {
        setRateError(apiError(err, t("study.rateFailed")));
      } finally {
        setBusy(false);
      }
    },
    [session, card, busy, t]
  );

  // Keys, for working through many cards: Space shows the answer, 1 says it was missed, 2 that it was known. Only when no
  // button has the focus, so that a button's own Space and Enter are left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target !== document.body || e.ctrlKey || e.metaKey || e.altKey || !card) return;
      if (e.key === " ") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (flipped && e.key === "1") void rate(false);
      else if (flipped && e.key === "2") void rate(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, flipped, rate]);

  if (authLoading || !user) return <p className="mt-20 text-center text-lg text-ink/70">{t("common.loadingDashboard")}</p>;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 md:py-10">
      <h1 className="mb-2 text-3xl md:text-4xl">{t("review.title")}</h1>
      <p className="muted mb-6">{t("review.intro")}</p>

      {loadError && (
        <p className="text-base font-medium text-danger" role="alert">
          {loadError}
        </p>
      )}
      {!session && !loadError && <p role="status">{t("review.loading")}</p>}

      {session && session.total === 0 && (
        <div className="card text-center" data-testid="review-empty">
          <p>{t("review.empty")}</p>
          {stats && stats.streak > 0 && <p className="mt-3 font-medium">{t("review.streak", { n: stats.streak })}</p>}
          <Link href="/dashboard" className="btn btn-secondary mt-5">
            {t("review.library")}
          </Link>
        </div>
      )}

      {session && session.total > 0 && card && (
        <div data-testid="review-session">
          <div className="mb-3 flex items-center justify-between gap-3 text-sm font-medium">
            <span data-testid="review-progress">{t("review.progress", { done: session.finished, total: session.total })}</span>
            <span className="muted truncate">{t("review.from", { title: card.title })}</span>
          </div>
          <progress className="mb-4 h-2 w-full" value={session.finished} max={session.total} aria-label={t("review.title")} />
          <button
            type="button"
            onClick={() => setFlipped((f) => !f)}
            className="block min-h-52 w-full rounded-2xl border border-ink/30 bg-surface p-6 text-center text-xl shadow-sm hover:bg-ink/5"
            data-testid="review-card"
          >
            <span key={`${card.front}-${flipped}`} className="flip-in block">
              <span className="block text-xs font-semibold uppercase tracking-widest text-ink/70">{flipped ? t("study.answer") : t("study.question")}</span>
              <span className="mt-2 block">{flipped ? card.back : card.front}</span>
            </span>
            {/* Named by the words on the card, with what pressing it does added after (see StudyPanel) */}
            <span className="sr-only">{flipped ? t("study.showQuestion") : t("study.showAnswer")}</span>
          </button>
          <div className="mt-4 flex min-h-12 flex-wrap items-center justify-center gap-3">
            {flipped ? (
              <>
                <button type="button" onClick={() => void rate(false)} disabled={busy} className={actionButton}>
                  {t("study.missed")}
                </button>
                <button type="button" onClick={() => void rate(true)} disabled={busy} className="btn btn-primary btn-sm">
                  {t("study.knew")}
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setFlipped(true)} className={actionButton}>
                {t("study.showAnswer")}
              </button>
            )}
          </div>
          {rateError && (
            <p className="mt-2 text-center text-sm font-medium text-danger" role="alert">
              {rateError}
            </p>
          )}
          <p className="muted mt-4 text-center text-sm">{t("review.missedHint")}</p>
          <p className="muted mt-1 text-center text-sm">{t("review.keys")}</p>
        </div>
      )}

      {session && session.total > 0 && isFinished(session) && (
        <div className="card text-center" data-testid="review-finished">
          <h2 className="text-2xl">{t("review.finished")}</h2>
          <p className="mt-3">{t("review.result", { knew: session.knewFirst, missed: session.missed })}</p>
          {stats && stats.streak > 0 && <p className="mt-2 font-medium">{t("review.streak", { n: stats.streak })}</p>}
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            {stats && stats.dueToday > 0 && (
              <button type="button" onClick={() => void load()} className="btn btn-primary">
                {t("review.more")}
              </button>
            )}
            <Link href="/dashboard" className="btn btn-secondary">
              {t("review.library")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
