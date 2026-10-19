"use client";
import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { API_URL, apiError } from "../lib/api";
import { pagesText, type Glossary } from "../lib/glossary";
import type { Document } from "../types";
import { useT } from "./I18nProvider";
import { actionButton } from "./styles";

interface GlossaryPanelProps {
  doc: Document;
  // Told what the glossary is (and when there is none yet), so the summary can underline its terms.
  onChange: (glossary: Glossary | null) => void;
}

// The specialist terms of a saved document with a one-line explanation of each and the pages they are on. A glossary made
// before is shown at once; nothing is asked of the model until the person asks.
export default function GlossaryPanel({ doc, onChange }: GlossaryPanelProps) {
  const t = useT();
  const [glossary, setGlossary] = useState<Glossary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const report = useRef(onChange);
  report.current = onChange;

  useEffect(() => {
    alive.current = true;
    axios
      .get<{ terms: Glossary["terms"] | null; suspicious?: boolean }>(`${API_URL}/documents/${doc.ID}/glossary`)
      .then((response) => {
        if (!alive.current || !response.data.terms) return;
        const stored = { terms: response.data.terms, suspicious: Boolean(response.data.suspicious) };
        setGlossary(stored);
        report.current(stored);
      })
      .catch(() => undefined)
      .finally(() => alive.current && setLoading(false));
    return () => {
      alive.current = false;
      report.current(null); // closing the panel takes the underlining out of the summary
    };
  }, [doc.ID]);

  const find = async (regenerate: boolean) => {
    setBusy(true);
    setError("");
    try {
      const response = await axios.post<Glossary>(`${API_URL}/documents/${doc.ID}/glossary`, { regenerate });
      if (!alive.current) return;
      setGlossary(response.data);
      report.current(response.data);
    } catch (err) {
      if (alive.current) setError(apiError(err, t("glossary.failed")));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <section className="mt-4 border-t border-ink/15 pt-4" aria-label={t("glossary.title")} data-testid="glossary-panel">
      <h4 className="text-lg font-semibold">{t("glossary.title")}</h4>
      <p className="muted mt-1 text-sm">{t("glossary.intro")}</p>

      {loading ? (
        <p className="mt-3" role="status">
          {t("common.loading")}
        </p>
      ) : (
        <div className="mt-3">
          <button type="button" onClick={() => void find(glossary !== null)} disabled={busy} className={actionButton}>
            {busy ? t("glossary.searching") : glossary ? t("glossary.again") : t("glossary.find")}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}
      {glossary?.suspicious && (
        <p className="mt-3 text-sm font-medium text-danger" role="note">
          {t("glossary.suspicious")}
        </p>
      )}
      {glossary && glossary.terms.length === 0 && (
        <p className="muted mt-3 text-base" data-testid="glossary-empty">
          {t("glossary.none")}
        </p>
      )}
      {glossary && glossary.terms.length > 0 && (
        <dl className="mt-3 space-y-3" data-testid="glossary-list">
          {glossary.terms.map((entry) => (
            <div key={entry.term} className="rounded-xl border border-ink/20 p-3" data-testid="glossary-term">
              <dt className="font-semibold">
                {entry.term}
                {entry.pages.length > 0 && <span className="muted text-sm font-normal"> · {pagesText(entry.pages, t)}</span>}
              </dt>
              <dd className="mt-1 text-base">{entry.explanation}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
