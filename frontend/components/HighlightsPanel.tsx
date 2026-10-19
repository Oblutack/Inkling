"use client";
import { useEffect, useState } from "react";
import axios from "axios";
import { API_URL, apiError } from "../lib/api";
import { inPageOrder, shortQuote, type Highlight } from "../lib/highlights";
import type { Document, FileInfo } from "../types";
import { useT } from "./I18nProvider";
import { actionButton } from "./styles";

interface HighlightsPanelProps {
  doc: Document;
  // The stored original PDFs of the document: highlights are made in them.
  files: FileInfo[];
  // Changes when the viewer made, changed or removed one, so the list is read again.
  version: number;
  // Open the original on a page (with a passage marked when there is one).
  onOpen: (file: FileInfo, page: number, quote: string) => void;
}

// The person's highlights and notes on a document, in page order, each opening the original on its page.
export default function HighlightsPanel({ doc, files, version, onOpen }: HighlightsPanelProps) {
  const t = useT();
  const [highlights, setHighlights] = useState<Highlight[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    axios
      .get<{ highlights: Highlight[] }>(`${API_URL}/documents/${doc.ID}/highlights`)
      .then((response) => {
        if (!cancelled) setHighlights(response.data.highlights);
      })
      .catch((err) => !cancelled && setError(apiError(err, t("highlights.loadFailed"))));
    return () => {
      cancelled = true;
    };
  }, [doc.ID, version, t]);

  const fileOf = (h: Highlight): FileInfo | undefined => files.find((f) => f.id === h.fileId) ?? files[0];

  return (
    <section className="mt-4 border-t border-ink/15 pt-4" aria-label={t("highlights.title")} data-testid="highlights-panel">
      <h4 className="text-lg font-semibold">{t("highlights.title")}</h4>
      <p className="muted mt-1 text-sm">{t("highlights.intro")}</p>

      {files.length > 0 ? (
        <div className="mt-3">
          <button type="button" onClick={() => onOpen(files[0], 1, "")} className={actionButton}>
            {t("highlights.openOriginal")}
          </button>
        </div>
      ) : (
        <p className="muted mt-3 text-sm">{t("highlights.noOriginal")}</p>
      )}

      {error && (
        <p className="mt-3 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}
      {highlights && highlights.length === 0 && (
        <p className="muted mt-3 text-base" data-testid="highlights-empty">
          {t("highlights.empty")}
        </p>
      )}
      {highlights && highlights.length > 0 && (
        <ul className="mt-3 space-y-2" data-testid="highlights-list">
          {inPageOrder(highlights).map((h) => {
            const file = fileOf(h);
            return (
              <li key={h.id} className="rounded-xl border border-ink/20 p-3" data-testid="highlight-item">
                <p className="muted text-sm">{t("highlights.page", { n: h.page })}</p>
                <blockquote className="mt-1 border-l-2 border-green-600 pl-3 text-sm">{shortQuote(h.quote, 240)}</blockquote>
                {h.note && <p className="mt-1 text-base font-medium">{h.note}</p>}
                {file && (
                  <button type="button" onClick={() => onOpen(file, h.page, h.quote)} className="btn btn-quiet btn-sm mt-2">
                    {t("highlights.openAt", { n: h.page })}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
