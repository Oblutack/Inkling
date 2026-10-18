"use client";
import { useState } from "react";
import axios from "axios";
import { API_URL, apiError } from "../lib/api";
import { LANGUAGES, SUMMARY_STYLES } from "../lib/summaryOptions";
import { useT } from "./I18nProvider";
import { actionButton, fieldClass } from "./styles";

// How long a summary is: the same four sizes a reader moves between ("expand" or "shrink" it).
export const LENGTHS = [
  { label: "rewrite.len.tldr", words: 50 },
  { label: "rewrite.len.short", words: 150 },
  { label: "rewrite.len.page", words: 300 },
  { label: "rewrite.len.detailed", words: 500 },
] as const;

interface RewritePanelProps {
  documentId: number;
  onDone: (summary: string) => void;
  // The document has no summary yet (a study set): this writes the first one, and nothing is replaced.
  first?: boolean;
}

// Writes a saved document's summary again, in another style, length or language, from the text kept
// with it. The new summary replaces the old one.
export default function RewritePanel({ documentId, onDone, first = false }: RewritePanelProps) {
  const t = useT();
  const [style, setStyle] = useState("default");
  const [language, setLanguage] = useState("English");
  const [words, setWords] = useState<number>(150);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const rewrite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await axios.post<{ Summary: string }>(`${API_URL}/documents/${documentId}/rewrite`, {
        style,
        language,
        wordCount: words,
      });
      onDone(response.data.Summary);
    } catch (err) {
      setError(apiError(err, t("rewrite.failed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={rewrite} className="mt-4 rounded-xl border border-ink/20 bg-canvas/50 p-4" data-testid="rewrite">
      <p className="text-sm text-ink/70">
        {t(first ? "rewrite.introFirst" : "rewrite.intro")}
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="label mb-0">{t("rewrite.length")}</span>
          <select value={words} onChange={(e) => setWords(Number(e.target.value))} className={fieldClass}>
            {LENGTHS.map((l) => (
              <option key={l.words} value={l.words}>
                {t("rewrite.lengthOption", { label: t(l.label), n: l.words })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label mb-0">{t("form.style")}</span>
          <select value={style} onChange={(e) => setStyle(e.target.value)} className={fieldClass}>
            {SUMMARY_STYLES.map((s) => (
              <option key={s.value} value={s.value}>
                {t(`style.${s.value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label mb-0">{t("form.language")}</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={fieldClass}>
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {t(`lang.${l}`)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy ? t("rewrite.busy") : t(first ? "rewrite.submitFirst" : "rewrite.submit")}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
