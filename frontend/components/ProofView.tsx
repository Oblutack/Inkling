"use client";
import { describeSource } from "../lib/citations";
import { fileForPassage, numberWarnings, proofHeadline, supportLabel, supportMark } from "../lib/proof";
import type { FileInfo, ProofPassage, ProofResult } from "../types";
import { LOCALES } from "../lib/i18n";
import { useI18n } from "./I18nProvider";

interface ProofViewProps {
  result: ProofResult;
  // The original PDFs kept with the document, if any: they make the evidence openable.
  files?: FileInfo[];
  onOpenDocument: (file: FileInfo, passage: ProofPassage) => void;
}

// A summary laid out sentence by sentence, each marked by how well the original document backs it,
// and each opening to show the passage it was matched with.
export default function ProofView({ result, files, onOpenDocument }: ProofViewProps) {
  const { t, language } = useI18n();
  return (
    <div data-testid="proof" className="font-sans text-base">
      <p className="font-bold" data-testid="proof-headline">
        {proofHeadline(result, t)}
      </p>

      {!result.verifiable && (
        <p className="mt-1 text-base" role="status">
          {t("proof.language")}
        </p>
      )}

      <p className="mt-1 text-sm text-ink/70">
        <span aria-hidden="true">● </span>
        {t("proof.legendFound")} &nbsp;
        <span aria-hidden="true">◐ </span>
        {t("proof.legendPartly")} &nbsp;
        <span aria-hidden="true">○ </span>
        {t("proof.legendNot")}
      </p>

      <ul className="mt-3 space-y-2">
        {result.sentences.map((s, i) => {
          if (s.kind === "heading" || s.support === null) {
            return (
              <li key={i} className="rise-sm pt-3 text-lg font-semibold" style={{ "--i": Math.min(i, 12) } as React.CSSProperties}>
                {s.text}
              </li>
            );
          }
          const warnings = numberWarnings(s, t);
          return (
            <li key={i} data-support={s.support} className="rise-sm" style={{ "--i": Math.min(i, 12) } as React.CSSProperties}>
              <details>
                <summary className="cursor-pointer">
                  <span
                    role="img"
                    aria-label={supportLabel(s.support, t)}
                    className={s.support === "none" ? "mr-2 text-danger" : "mr-2"}
                  >
                    {supportMark(s.support)}
                  </span>
                  {s.text}
                  {warnings.length > 0 && (
                    <span className="ml-2 text-base text-danger" aria-hidden="true">
                      &#9888;
                    </span>
                  )}
                </summary>
                <div className="ml-7 mt-1 space-y-2 text-sm">
                  <p className="text-ink/70">{supportLabel(s.support, t)}</p>
                  {warnings.map((w) => (
                    <p key={w} className="text-danger" role="note">
                      &#9888; {w}
                    </p>
                  ))}
                  {s.passages.length === 0 && <p>{t("proof.noPassage")}</p>}
                  {s.passages.map((p) => {
                    const file = fileForPassage(files, p);
                    return (
                      <div key={p.id}>
                        <p className="text-xs font-semibold uppercase tracking-widest text-ink/70">
                          {describeSource(p, t, LOCALES[language]) || t("sources.excerpt")}
                        </p>
                        <blockquote className="whitespace-pre-wrap border-l-2 border-accent/60 pl-3">{p.text}</blockquote>
                        {file && p.page != null && (
                          <button
                            type="button"
                            onClick={() => onOpenDocument(file, p)}
                            className="btn btn-secondary btn-sm mt-1"
                          >
                            {t("sources.open", { page: p.page })}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
