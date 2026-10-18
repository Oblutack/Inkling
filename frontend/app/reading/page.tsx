"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";
import { useI18n } from "../../components/I18nProvider";
import { actionButton, fieldClass, textButton } from "../../components/styles";
import { API_URL, apiError } from "../../lib/api";
import { safeLink, savePayload, sourceOf, STATES, summaryText, type ReadingCounts, type ReadingItem, type ReadingList, type ReadingState } from "../../lib/reading";

const ZERO: ReadingCounts = { unread: 0, read: 0, archived: 0 };

// The reading list: things saved to read later, each with a short summary. Unread ones first; they can be marked read, put in
// the archive, or taken off the list (they stay in the library).
function Reading() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const { t, language } = useI18n();
  const params = useSearchParams();
  const [state, setState] = useState<ReadingState>("unread");
  const [items, setItems] = useState<ReadingItem[] | null>(null);
  const [counts, setCounts] = useState<ReadingCounts>(ZERO);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(params.get("added") === "1" ? t("reading.added") : "");

  useEffect(() => {
    if (!authLoading && !user) router.push("/login");
  }, [authLoading, user, router]);

  const load = useCallback(
    async (which: ReadingState) => {
      setLoadError("");
      try {
        const response = await axios.get<ReadingList>(`${API_URL}/reading-list`, { params: { state: which } });
        setItems(response.data.items);
        setCounts(response.data.counts);
      } catch (err) {
        setLoadError(apiError(err, t("reading.loadFailed")));
      }
    },
    [t]
  );

  useEffect(() => {
    if (user) void load(state);
  }, [user, state, load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = savePayload(input);
    if (!payload) return;
    setSaving(true);
    setError("");
    setNote("");
    try {
      const response = await axios.post<{ alreadySaved: boolean }>(`${API_URL}/reading-list`, payload);
      setNote(response.data.alreadySaved ? t("reading.alreadySaved") : t("reading.added"));
      setInput("");
      setState("unread");
      await load("unread");
    } catch (err) {
      setError(apiError(err, t("reading.addFailed")));
    } finally {
      setSaving(false);
    }
  };

  const update = async (item: ReadingItem, body: { read?: boolean; archived?: boolean }) => {
    setError("");
    try {
      await axios.put(`${API_URL}/reading-list/${item.id}`, body);
      await load(state);
    } catch (err) {
      setError(apiError(err, t("reading.failed")));
    }
  };

  const remove = async (item: ReadingItem) => {
    if (!window.confirm(t("reading.confirmRemove", { title: item.title }))) return;
    setError("");
    try {
      await axios.delete(`${API_URL}/reading-list/${item.id}`);
      await load(state);
    } catch (err) {
      setError(apiError(err, t("reading.failed")));
    }
  };

  if (authLoading || !user) return <p className="mt-20 text-center text-lg text-ink/70">{t("common.loadingDashboard")}</p>;

  const tabLabel = (s: ReadingState) => t(s === "unread" ? "reading.tabUnread" : s === "read" ? "reading.tabRead" : "reading.tabArchived", { n: counts[s] });
  const empty = state === "unread" ? "reading.emptyUnread" : state === "read" ? "reading.emptyRead" : "reading.emptyArchived";

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:py-10">
      <h1 className="mb-2 text-3xl md:text-4xl">{t("reading.title")}</h1>
      <p className="muted mb-6">{t("reading.intro")}</p>

      <form onSubmit={(e) => void add(e)} className="card mb-6 space-y-3" data-testid="reading-add">
        <label htmlFor="reading-input" className="block text-base font-semibold">
          {t("reading.addLabel")}
        </label>
        <div className="flex flex-wrap gap-3">
          <input
            id="reading-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("reading.addPlaceholder")}
            className={`${fieldClass} min-w-0 flex-1`}
            disabled={saving}
          />
          <button type="submit" disabled={saving || !savePayload(input)} className="btn btn-primary">
            {saving ? t("reading.saving") : t("reading.addButton")}
          </button>
        </div>
        <div aria-live="polite">
          {note && (
            <p className="text-sm font-medium" role="status" data-testid="reading-note">
              {note}
            </p>
          )}
        </div>
        {error && (
          <p className="text-sm font-medium text-danger" role="alert">
            {error}
          </p>
        )}
      </form>

      <div role="group" aria-label={t("reading.tabs")} className="mb-4 flex flex-wrap gap-2" data-testid="reading-tabs">
        {STATES.map((s) => (
          <button key={s} type="button" onClick={() => setState(s)} aria-pressed={state === s} className="chip py-1">
            {tabLabel(s)}
          </button>
        ))}
      </div>

      {loadError && (
        <p className="text-base font-medium text-danger" role="alert">
          {loadError}
        </p>
      )}
      {!items && !loadError && <p role="status">{t("common.loading")}</p>}

      {items && items.length === 0 && (
        <div className="card text-center" data-testid="reading-empty">
          <p>{t(empty)}</p>
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="space-y-4" data-testid="reading-items">
          {items.map((item) => {
            const link = safeLink(item.url);
            return (
              <li key={item.id} className="card" data-testid="reading-item">
                <h2 className="break-words text-xl font-semibold leading-snug">{item.title}</h2>
                <p className="muted mt-1 text-sm">
                  {sourceOf(item) && <>{sourceOf(item)} · </>}
                  {t("reading.savedOn", { when: new Date(item.savedAt).toLocaleDateString(language) })}
                </p>
                <p className="mt-3 text-base">{summaryText(item.summary)}</p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {link && (
                    <a href={link} target="_blank" rel="noopener noreferrer" className={actionButton}>
                      {t("reading.openPage")}
                    </a>
                  )}
                  {state !== "archived" && (
                    <button type="button" onClick={() => void update(item, { read: state === "unread" })} className={actionButton}>
                      {state === "unread" ? t("reading.markRead") : t("reading.markUnread")}
                    </button>
                  )}
                  <button type="button" onClick={() => void update(item, { archived: state !== "archived" })} className={textButton}>
                    {state === "archived" ? t("reading.restore") : t("reading.archive")}
                  </button>
                  <button type="button" onClick={() => void remove(item)} className={textButton}>
                    {t("reading.remove")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="muted mt-8 text-sm">
        {t("reading.digestNote")}{" "}
        <Link href="/account" className="underline underline-offset-4">
          {t("reading.digestLink")}
        </Link>
      </p>
    </div>
  );
}

export default function ReadingPage() {
  return (
    <Suspense fallback={null}>
      <Reading />
    </Suspense>
  );
}
