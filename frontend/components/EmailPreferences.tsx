"use client";
import { useEffect, useId, useState } from "react";
import axios from "axios";
import type { EmailPrefs } from "../types";
import { API_URL, apiError } from "../lib/api";
import { browserTimeZone } from "../lib/timezone";
import { useT } from "./I18nProvider";
import { ErrorText, SuccessText } from "./ui";

// The kinds of email Inkling can send, in the order shown.
const KINDS = [
  { key: "watch", label: "emails.watch", text: "emails.watchText" },
  { key: "reminders", label: "emails.reminders", text: "emails.remindersText" },
  { key: "digest", label: "emails.digest", text: "emails.digestText" },
] as const;

// What Inkling may email the person. Each choice is saved the moment it is made. The time zone is the browser's, sent along
// so that "morning" is the person's morning.
export default function EmailPreferences() {
  const t = useT();
  const id = useId();
  const [prefs, setPrefs] = useState<EmailPrefs | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const zone = browserTimeZone();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await axios.get<EmailPrefs>(`${API_URL}/account/email-preferences`);
        let current = response.data;
        // The zone the server knows is the one this browser reports: keep them in step (once, quietly).
        if (zone && current.timeZone !== zone) {
          current = (await axios.put<EmailPrefs>(`${API_URL}/account/email-preferences`, { timeZone: zone })).data;
        }
        if (!cancelled) setPrefs(current);
      } catch (err) {
        if (!cancelled) setError(apiError(err, t("emails.loadFailed")));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [zone, t]);

  const change = async (key: (typeof KINDS)[number]["key"], on: boolean) => {
    if (!prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, [key]: on });
    setError("");
    setSaved(false);
    try {
      const response = await axios.put<EmailPrefs>(`${API_URL}/account/email-preferences`, { [key]: on });
      setPrefs(response.data);
      setSaved(true);
    } catch (err) {
      setPrefs(before);
      setError(apiError(err, t("emails.failed")));
    }
  };

  return (
    <div className="space-y-4" data-testid="email-preferences">
      <p className="text-base text-ink/80">{t("emails.intro")}</p>
      {prefs &&
        KINDS.map((kind) => (
          <label key={kind.key} className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={prefs[kind.key]}
              onChange={(e) => void change(kind.key, e.target.checked)}
              aria-describedby={`${id}-${kind.key}`}
              className="mt-1.5 h-5 w-5 flex-none accent-accent"
            />
            <span>
              <span className="block font-medium">{t(kind.label)}</span>
              <span id={`${id}-${kind.key}`} className="muted block text-sm">
                {t(kind.text)}
              </span>
            </span>
          </label>
        ))}
      <p className="muted text-sm">{zone ? t("emails.zone", { zone }) : t("emails.zoneUnknown")}</p>
      <div aria-live="polite">{saved && <SuccessText>{t("emails.saved")}</SuccessText>}</div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
