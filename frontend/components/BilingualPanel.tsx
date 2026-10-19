"use client";
import { useEffect, useId, useRef, useState } from "react";
import axios from "axios";
import { API_URL, apiError } from "../lib/api";
import { bilingualMarkdown, figureWarnings, linePrefix, numberedPositions, type Bilingual } from "../lib/bilingual";
import { LANGUAGES } from "../lib/summaryOptions";
import type { Document } from "../types";
import CopyButton from "./CopyButton";
import { useI18n } from "./I18nProvider";
import { actionButton, fieldClass } from "./styles";

// The summary next to its translation into another language, line by line, with the key words. A translation made before is
// shown again for nothing; each language is made once.
export default function BilingualPanel({ doc }: { doc: Document }) {
  const { t, language: uiLanguage } = useI18n();
  const selectId = useId();
  const [language, setLanguage] = useState<string>("Spanish");
  const [result, setResult] = useState<Bilingual | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = async (regenerate: boolean) => {
    setBusy(true);
    setError("");
    try {
      const response = await axios.post<Bilingual>(`${API_URL}/documents/${doc.ID}/bilingual`, { language, regenerate });
      if (alive.current) setResult(response.data);
    } catch (err) {
      if (alive.current) setError(apiError(err, t("bilingual.failed")));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const positions = result ? numberedPositions(result.rows) : [];
  const warnings = result ? figureWarnings(result.rows) : 0;

  return (
    <section className="mt-4 border-t border-ink/15 pt-4" aria-label={t("bilingual.title")} data-testid="bilingual-panel">
      <h4 className="text-lg font-semibold">{t("bilingual.title")}</h4>
      <p className="muted mt-1 text-sm">{t("bilingual.intro")}</p>

      <form
        className="mt-3 flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(false);
        }}
      >
        <label htmlFor={selectId} className="text-sm font-medium">
          {t("bilingual.language")}
        </label>
        <select
          id={selectId}
          value={language}
          onChange={(e) => {
            setLanguage(e.target.value);
            setResult(null);
          }}
          className={fieldClass}
          disabled={busy}
        >
          {LANGUAGES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy} className={actionButton}>
          {busy ? t("bilingual.running") : t("bilingual.run")}
        </button>
      </form>

      {error && (
        <p className="mt-3 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-4" data-testid="bilingual-result">
          {result.cached && result.foundAt && (
            <p className="muted text-sm">{t("bilingual.cachedNote", { when: new Date(result.foundAt).toLocaleDateString(uiLanguage) })}</p>
          )}
          {warnings > 0 && (
            <p className="mt-2 text-sm font-medium text-danger" role="note" data-testid="bilingual-figures">
              {t("bilingual.figuresNote", { n: warnings })}
            </p>
          )}

          <div className="mt-3 space-y-3" data-testid="bilingual-rows">
            {result.rows.map((row, i) => {
              const prefix = linePrefix(row, positions[i]);
              const weight = row.kind === "heading" ? "text-lg font-semibold" : "text-base";
              return (
                <div
                  key={i}
                  className="grid gap-2 rounded-xl border border-ink/20 p-3 md:grid-cols-2 md:gap-4"
                  data-testid="bilingual-row"
                  data-figures={row.figuresKept ? "kept" : "changed"}
                >
                  <p className={weight} lang={undefined}>
                    {prefix}
                    {row.source}
                  </p>
                  {row.target ? (
                    <p className={`${weight} md:border-l md:border-ink/20 md:pl-4`}>
                      <span className="sr-only">{t("bilingual.sideLabel", { language: result.language })}: </span>
                      {prefix}
                      {row.target}
                      {!row.figuresKept && (
                        <span className="mt-1 block text-sm font-medium text-danger" data-testid="bilingual-check">
                          ⚠ {t("bilingual.checkFigures")}
                        </span>
                      )}
                    </p>
                  ) : (
                    <p className="muted text-sm md:border-l md:border-ink/20 md:pl-4">{t("bilingual.notTranslated")}</p>
                  )}
                </div>
              );
            })}
          </div>

          {result.vocabulary.length > 0 && (
            <div className="mt-5" data-testid="bilingual-vocabulary">
              <h5 className="text-base font-semibold">{t("bilingual.vocabulary")}</h5>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {result.vocabulary.map((w) => (
                  <li key={w.word} className="flex justify-between gap-3 rounded-lg border border-ink/15 px-3 py-1.5 text-base">
                    <span>{w.word}</span>
                    <span className="font-medium">{w.translation}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <CopyButton text={bilingualMarkdown(doc.Filename, "Original", result)} what={t("bilingual.copyWhat")} />
            <button type="button" onClick={() => void run(true)} disabled={busy} className={actionButton}>
              {t("bilingual.again")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
