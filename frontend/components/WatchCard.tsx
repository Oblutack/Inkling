"use client";
import { useEffect, useState } from "react";
import axios from "axios";
import { API_URL, apiError } from "../lib/api";
import type { Comparison } from "../lib/compare";
import { everyLabelKey, everyOptions, hostOf, type CheckResult, type Watch, type WatchChangeSummary, type WatchList } from "../lib/watch";
import ComparisonView from "./ComparisonView";
import { useT } from "./I18nProvider";
import { actionButton, fieldClass, textButton } from "./styles";

interface WatchCardProps {
  watch: Watch;
  minHours: number;
  // Open the history at the start (a link in an email opens the watch it is about).
  openAtStart?: boolean;
  onList: (list: WatchList) => void;
  onWatch: (watch: Watch) => void;
  onRemoved: (id: number) => void;
}

const IMPORTANCE_KEY = { high: "compare.impHigh", medium: "compare.impMedium", low: "compare.impLow" } as const;

// A page being watched: how it is doing, what it last found, and what can be done with it. The history of changes opens
// below, and each change opens into the same comparison view as two documents compared.
export default function WatchCard({ watch, minHours, openAtStart = false, onList, onWatch, onRemoved }: WatchCardProps) {
  const t = useT();
  const [busy, setBusy] = useState<"" | "check" | "update" | "remove">("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [historyOpen, setHistoryOpen] = useState(openAtStart);
  const [history, setHistory] = useState<WatchChangeSummary[] | null>(null);
  const [openChange, setOpenChange] = useState<{ id: number; comparison: Comparison; foundAt: string; title: string } | null>(null);

  const title = watch.title || hostOf(watch.url);

  const loadHistory = async () => {
    try {
      const response = await axios.get<{ changes: WatchChangeSummary[] }>(`${API_URL}/watches/${watch.id}/changes`);
      setHistory(response.data.changes);
    } catch (err) {
      setError(apiError(err, t("watch.failed")));
    }
  };

  const toggleHistory = async () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history === null) await loadHistory();
  };

  // The history is read when the card opens on it (an email's link), once.
  useEffect(() => {
    if (openAtStart) void loadHistory();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const update = async (body: { paused?: boolean; everyHours?: number }) => {
    setBusy("update");
    setError("");
    try {
      const response = await axios.put<WatchList>(`${API_URL}/watches/${watch.id}`, body);
      onList(response.data);
    } catch (err) {
      setError(apiError(err, t("watch.failed")));
    } finally {
      setBusy("");
    }
  };

  const checkNow = async () => {
    setBusy("check");
    setError("");
    setResult(null);
    try {
      const response = await axios.post<{ result: CheckResult; watch?: Watch }>(`${API_URL}/watches/${watch.id}/check`);
      setResult(response.data.result);
      if (response.data.watch) onWatch(response.data.watch);
      if (response.data.result.status === "changed") {
        setHistory(null);
        if (historyOpen) await loadHistory();
      }
    } catch (err) {
      setError(apiError(err, t("watch.failed")));
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    if (!window.confirm(t("watch.confirmRemove"))) return;
    setBusy("remove");
    setError("");
    try {
      await axios.delete(`${API_URL}/watches/${watch.id}`);
      onRemoved(watch.id);
    } catch (err) {
      setError(apiError(err, t("watch.failed")));
      setBusy("");
    }
  };

  const showChange = async (summary: WatchChangeSummary) => {
    if (openChange?.id === summary.id) {
      setOpenChange(null);
      return;
    }
    setError("");
    try {
      const response = await axios.get<{ comparison: Comparison; foundAt: string; title: string }>(`${API_URL}/watches/${watch.id}/changes/${summary.id}`);
      setOpenChange({ id: summary.id, comparison: response.data.comparison, foundAt: response.data.foundAt, title: response.data.title });
    } catch (err) {
      setError(apiError(err, t("watch.failed")));
    }
  };

  const resultText = (r: CheckResult): string => {
    if (r.status === "unchanged") return t("watch.result.unchanged");
    if (r.status === "identical") return t("watch.result.identical");
    if (r.status === "changed") return t("watch.result.changed", { n: r.changes });
    return r.message ?? t("watch.failed");
  };

  return (
    <li className="card" data-testid="watch-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-xl font-semibold leading-snug">{title}</h2>
          <a href={watch.url} target="_blank" rel="noopener noreferrer" className="muted break-all text-sm underline underline-offset-4">
            {watch.url}
          </a>
        </div>
        {watch.paused && <span className="chip pointer-events-none text-xs">{t("watch.paused")}</span>}
      </div>

      <p className="muted mt-3 text-sm">
        {watch.lastCheckedAt ? t("watch.lastChecked", { when: new Date(watch.lastCheckedAt).toLocaleString() }) : t("watch.neverChecked")}
        {" · "}
        {watch.lastChangedAt ? t("watch.lastChange", { when: new Date(watch.lastChangedAt).toLocaleString() }) : t("watch.noChange")}
      </p>
      {watch.latest?.bottomLine && <p className="mt-2 text-base">{watch.latest.bottomLine}</p>}
      {watch.lastError && (
        <p className="mt-2 text-sm font-medium text-danger" data-testid="watch-problem">
          {watch.paused ? t("watch.pausedWhy", { error: watch.lastError }) : t("watch.failing", { error: watch.lastError })}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">{t("watch.everyAria", { title })}</span>
          <select
            value={watch.everyHours}
            onChange={(e) => void update({ everyHours: Number(e.target.value) })}
            disabled={busy !== ""}
            className={fieldClass}
            aria-label={t("watch.everyAria", { title })}
          >
            {everyOptions(watch.everyHours, minHours).map((hours) => {
              const key = everyLabelKey(hours);
              return (
                <option key={hours} value={hours}>
                  {key ? t(key) : t("watch.everyOther", { n: hours })}
                </option>
              );
            })}
          </select>
        </label>
        {!watch.paused && (
          <button type="button" onClick={() => void checkNow()} disabled={busy !== ""} className={actionButton}>
            {busy === "check" ? t("watch.checking") : t("watch.checkNow")}
          </button>
        )}
        <button type="button" onClick={() => void update({ paused: !watch.paused })} disabled={busy !== ""} className={actionButton}>
          {watch.paused ? t("watch.resume") : t("watch.pause")}
        </button>
        <button type="button" onClick={() => void remove()} disabled={busy !== ""} className={textButton}>
          {t("watch.remove")}
        </button>
      </div>

      <div aria-live="polite">
        {result && (
          <p className="mt-3 text-sm font-medium" role="status" data-testid="watch-result">
            {resultText(result)}
          </p>
        )}
      </div>
      {error && (
        <p className="mt-3 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4">
        <button type="button" onClick={() => void toggleHistory()} aria-expanded={historyOpen} className={textButton}>
          {historyOpen ? t("watch.hideHistory") : t("watch.history", { n: watch.changes })}
        </button>
      </div>

      {historyOpen && (
        <div className="mt-2" data-testid="watch-history">
          {history === null ? (
            <p role="status">{t("common.loading")}</p>
          ) : history.length === 0 ? (
            <p className="muted text-sm">{t("watch.historyEmpty")}</p>
          ) : (
            <ul className="space-y-3">
              {history.map((change) => (
                <li key={change.id} className="rounded-xl border border-ink/20 p-3" data-testid="watch-change">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {new Date(change.foundAt).toLocaleString()}
                      {change.topImportance && (
                        <span className="chip pointer-events-none ml-2 text-xs">{t(IMPORTANCE_KEY[change.topImportance])}</span>
                      )}
                    </span>
                    <button type="button" onClick={() => void showChange(change)} aria-expanded={openChange?.id === change.id} className={textButton}>
                      {openChange?.id === change.id ? t("watch.hideHistory") : t("watch.openChange")}
                    </button>
                  </div>
                  {change.bottomLine && <p className="mt-1 text-base">{change.bottomLine}</p>}
                  {openChange?.id === change.id && (
                    <div className="mt-3">
                      <ComparisonView result={openChange.comparison} oldName={t("watch.previous")} newName={`${openChange.title} (${new Date(openChange.foundAt).toLocaleDateString()})`} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
