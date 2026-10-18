"use client";
import { useEffect, useId, useRef, useState } from "react";
import axios from "axios";
import { API_URL, apiError } from "../lib/api";
import {
  GROUP_ORDER,
  groupItems,
  itemLabel,
  kindLabelKey,
  KINDS,
  STATUS_MARK,
  type ChecklistKind,
  type ChecklistResult,
  type ItemStatus,
} from "../lib/checklist";
import type { Document } from "../types";
import { useI18n } from "./I18nProvider";
import { actionButton, fieldClass } from "./styles";

const GROUP_KEY = { missing: "checklist.groupMissing", unclear: "checklist.groupUnclear", found: "checklist.groupFound" } as const;
const STATUS_KEY = { missing: "checklist.statusMissing", unclear: "checklist.statusUnclear", found: "checklist.statusFound" } as const;

// Checks a saved contract against the things worth looking for in that kind of contract. What is not there is shown first.
// A result that was made before is shown again for nothing.
export default function ChecklistPanel({ doc }: { doc: Document }) {
  const { t, language } = useI18n();
  const kindId = useId();
  const [kind, setKind] = useState<ChecklistKind>("lease");
  const [result, setResult] = useState<ChecklistResult | null>(null);
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
      const response = await axios.post<ChecklistResult>(`${API_URL}/documents/${doc.ID}/checklist`, { kind, regenerate });
      if (alive.current) setResult(response.data);
    } catch (err) {
      if (alive.current) setError(apiError(err, t("checklist.failed")));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const grouped = result ? groupItems(result.items) : null;
  const shownKind = result?.kind ?? kind;

  return (
    <section className="mt-4 border-t border-ink/15 pt-4" aria-label={t("checklist.title")} data-testid="checklist-panel">
      <h4 className="text-lg font-semibold">{t("checklist.title")}</h4>
      <p className="muted mt-1 text-sm">{t("checklist.intro")}</p>
      <p className="mt-2 rounded-lg border border-ink/20 p-2 text-sm font-medium" data-testid="checklist-disclaimer">
        {t("checklist.disclaimer")}
      </p>

      <form
        className="mt-3 flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(false);
        }}
      >
        <label htmlFor={kindId} className="text-sm font-medium">
          {t("checklist.kindLabel")}
        </label>
        <select
          id={kindId}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as ChecklistKind);
            setResult(null);
          }}
          className={fieldClass}
          disabled={busy}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(kindLabelKey(k))}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy} className={actionButton}>
          {busy ? t("checklist.running") : t("checklist.run")}
        </button>
      </form>

      {error && (
        <p className="mt-3 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}

      {result && grouped && (
        <div className="mt-4" data-testid="checklist-result">
          <p className="text-base font-semibold" data-testid="checklist-counts" role="status">
            {t("checklist.counts", { found: result.counts.found, unclear: result.counts.unclear, missing: result.counts.missing })}
          </p>
          {result.cached && result.foundAt && (
            <p className="muted text-sm">{t("checklist.cachedNote", { when: new Date(result.foundAt).toLocaleDateString(language) })}</p>
          )}
          {result.suspicious && (
            <p className="mt-2 text-sm font-medium text-danger" role="note" data-testid="checklist-suspicious">
              {t("checklist.suspicious")}
            </p>
          )}

          {GROUP_ORDER.map((status: ItemStatus) =>
            grouped[status].length === 0 ? null : (
              <div key={status} className="mt-4" data-testid={`checklist-group-${status}`}>
                <h5 className="text-base font-semibold">
                  {t(GROUP_KEY[status])} ({grouped[status].length})
                </h5>
                <ul className="mt-2 space-y-2">
                  {grouped[status].map((item) => (
                    <li key={item.id} className="rounded-xl border border-ink/20 p-3" data-testid="checklist-item" data-status={item.status}>
                      <p className="font-medium">
                        <span aria-hidden="true">{STATUS_MARK[item.status]} </span>
                        {itemLabel(shownKind, item.id, t)}
                        <span className="sr-only"> ({t(STATUS_KEY[item.status])})</span>
                      </p>
                      {item.status === "missing" && <p className="muted mt-1 text-sm">{t("checklist.missingNote")}</p>}
                      {item.status !== "missing" && item.value && <p className="mt-1 text-base">{item.value}</p>}
                      {item.status === "unclear" && <p className="mt-1 text-sm font-medium">{t("checklist.unclearNote")}</p>}
                      {item.status !== "missing" && item.quote && (
                        <blockquote className="mt-2 border-l-2 border-ink/30 pl-3 text-sm">
                          <span className="muted">{t("checklist.says")}: </span>
                          {item.quote}
                          {item.page ? <span className="muted"> ({t("checklist.page", { n: item.page })})</span> : null}
                        </blockquote>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}

          <div className="mt-5" data-testid="checklist-unusual">
            <h5 className="text-base font-semibold">{t("checklist.unusualTitle")}</h5>
            {!result.unusualChecked ? (
              <p className="muted mt-1 text-sm">{t("checklist.unusualUnchecked")}</p>
            ) : result.unusual.length === 0 ? (
              <p className="muted mt-1 text-sm">{t("checklist.unusualNone")}</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {result.unusual.map((clause, i) => (
                  <li key={i} className="rounded-xl border border-ink/20 p-3" data-testid="checklist-clause">
                    <p className="font-medium">{clause.what}</p>
                    <blockquote className="mt-2 border-l-2 border-ink/30 pl-3 text-sm">
                      <span className="muted">{t("checklist.says")}: </span>
                      {clause.quote}
                      {clause.page ? <span className="muted"> ({t("checklist.page", { n: clause.page })})</span> : null}
                    </blockquote>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-4">
            <button type="button" onClick={() => void run(true)} disabled={busy} className={actionButton}>
              {t("checklist.again")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
