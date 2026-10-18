"use client";
import { useEffect, useId, useRef, useState } from "react";
import axios from "axios";
import { API_URL, apiError } from "../lib/api";
import { dayLocale, daysUntil, localToday, longDay, onCalendar, type FoundDate, type FoundDates } from "../lib/dates";
import { buildIcs, downloadIcs, icsFileName, type Reminder } from "../lib/ics";
import type { Document } from "../types";
import { useI18n } from "./I18nProvider";
import { actionButton, fieldClass } from "./styles";

const REPEAT_KEY = { weekly: "dates.repeatWeekly", monthly: "dates.repeatMonthly", yearly: "dates.repeatYearly" } as const;

// The dates and deadlines in a saved document, each with the sentence it was read from and a check that the date really is
// in that sentence. Dates that checked out can be put in any calendar app (a calendar file made in the browser).
export default function DatesPanel({ doc }: { doc: Document }) {
  const { t, language } = useI18n();
  const reminderId = useId();
  const [found, setFound] = useState<FoundDates | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [reminder, setReminder] = useState<Reminder>("1d");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    // Dates found before are shown at once; nothing is asked of the model until the person asks.
    axios
      .get<{ dates: FoundDate[] | null; suspicious?: boolean }>(`${API_URL}/documents/${doc.ID}/dates`)
      .then((response) => {
        if (!alive.current) return;
        if (response.data.dates) setFound({ dates: response.data.dates, suspicious: Boolean(response.data.suspicious), cached: true });
      })
      .catch(() => undefined)
      .finally(() => alive.current && setLoading(false));
    return () => {
      alive.current = false;
    };
  }, [doc.ID]);

  const search = async (regenerate: boolean) => {
    setSearching(true);
    setError("");
    try {
      const response = await axios.post<FoundDates>(`${API_URL}/documents/${doc.ID}/dates`, { regenerate });
      if (alive.current) setFound(response.data);
    } catch (err) {
      if (alive.current) setError(apiError(err, t("dates.failed")));
    } finally {
      if (alive.current) setSearching(false);
    }
  };

  const save = (dates: FoundDate[], fileName: string) => {
    downloadIcs(buildIcs(dates, { documentTitle: doc.Filename, documentId: doc.ID, reminder }), fileName);
  };

  const today = localToday();
  const locale = dayLocale(language, typeof navigator === "undefined" ? [] : navigator.languages);
  const ready = found?.dates.filter(onCalendar) ?? [];

  const when = (day: string): string => {
    const n = daysUntil(day, today);
    if (n === null) return "";
    if (n === 0) return t("dates.today");
    if (n === 1) return t("dates.tomorrow");
    if (n === -1) return t("dates.yesterday");
    return n > 0 ? t("dates.inDays", { n }) : t("dates.daysAgo", { n: -n });
  };

  return (
    <section className="mt-4 border-t border-ink/15 pt-4" aria-label={t("dates.title")} data-testid="dates-panel">
      <h4 className="text-lg font-semibold">{t("dates.title")}</h4>
      <p className="muted mt-1 text-sm">{t("dates.intro")}</p>

      {loading ? (
        <p className="mt-3" role="status">
          {t("common.loading")}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void search(found !== null)} disabled={searching} className={actionButton}>
            {searching ? t("dates.searching") : found ? t("dates.again") : t("dates.find")}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}

      {found?.suspicious && (
        <p className="mt-3 text-sm font-medium text-danger" role="note" data-testid="dates-suspicious">
          {t("dates.suspicious")}
        </p>
      )}

      {found && found.dates.length === 0 && (
        <p className="muted mt-3 text-base" data-testid="dates-empty">
          {t("dates.none")}
        </p>
      )}

      {found && found.dates.length > 0 && (
        <>
          <ul className="mt-3 space-y-3" data-testid="dates-list">
            {found.dates.map((d, index) => (
              <li key={`${d.date ?? "x"}-${d.what}-${index}`} className="rounded-xl border border-ink/20 p-3" data-testid="date-item">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-base font-semibold">{d.what}</p>
                    <p className="text-base" data-testid="date-when">
                      {d.date ? (
                        <>
                          <time dateTime={d.date}>{longDay(d.date, locale)}</time>
                          {" · "}
                          <span className="muted">{when(d.date)}</span>
                        </>
                      ) : (
                        <span>{t("dates.waiting", { when: d.relative })}</span>
                      )}
                      {d.repeat !== "none" && <span className="chip pointer-events-none ml-2 text-xs">{t(REPEAT_KEY[d.repeat])}</span>}
                    </p>
                  </div>
                  {onCalendar(d) && (
                    <button
                      type="button"
                      onClick={() => save([d], icsFileName(d.what))}
                      className={actionButton}
                      aria-label={t("dates.addOne", { what: d.what })}
                    >
                      {t("dates.add")}
                    </button>
                  )}
                </div>
                <blockquote className="mt-2 border-l-2 border-ink/30 pl-3 text-sm">
                  {d.quote}
                  {d.page ? <span className="muted"> ({t("dates.page", { n: d.page })})</span> : null}
                </blockquote>
                <p className={`mt-2 text-sm font-medium ${d.verified ? "" : "text-danger"}`}>
                  {d.verified ? `✓ ${t("dates.verified")}` : `⚠ ${t("dates.unverified")}`}
                </p>
              </li>
            ))}
          </ul>

          {ready.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label htmlFor={reminderId} className="text-sm font-medium">
                {t("dates.reminder")}
              </label>
              <select id={reminderId} value={reminder} onChange={(e) => setReminder(e.target.value as Reminder)} className={fieldClass}>
                <option value="none">{t("dates.reminderNone")}</option>
                <option value="1d">{t("dates.reminderDay")}</option>
                <option value="1w">{t("dates.reminderWeek")}</option>
              </select>
              <button type="button" onClick={() => save(found.dates, icsFileName(doc.Filename))} className={actionButton}>
                {t("dates.addAll", { n: ready.length })}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
