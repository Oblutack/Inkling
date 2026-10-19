"use client";
import "pdfjs-dist/web/pdf_viewer.css";
import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { API_URL, apiError } from "../lib/api";
import { canHighlight, forFile, MAX_NOTE, onPage, quoteFrom, shortQuote, type Highlight } from "../lib/highlights";
import { findHighlight } from "../lib/pdfHighlight";
import type { FileInfo } from "../types";
import { useT } from "./I18nProvider";

interface PdfViewerProps {
  documentId: number;
  file: Pick<FileInfo, "id" | "name">;
  // The page to open on (1-based) and the passage to mark on it.
  page: number;
  passage: string;
  onClose: () => void;
  // Told when a highlight was made, changed or removed, so a list of them elsewhere can be read again.
  onHighlightsChanged?: () => void;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MAX_PAGE_WIDTH = 900;

// Shows one of the user's original PDFs in a pop-up, opened on a cited page with the cited passage marked. The file is fetched
// from the API with the session cookie and drawn by PDF.js. Words on the page can be selected to highlight them and write a
// note; the person's highlights are marked on their pages and listed under the page.
export default function PdfViewer({ documentId, file, page: openOn, passage, onClose, onHighlightsChanged }: PdfViewerProps) {
  const t = useT();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(openOn);
  const [error, setError] = useState("");
  const [boxes, setBoxes] = useState<Box[]>([]);
  // null until the page is drawn; false when the passage could not be found on it.
  const [located, setLocated] = useState<boolean | null>(null);

  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [marks, setMarks] = useState<Array<{ id: number; boxes: Box[] }>>([]);
  const [selected, setSelected] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [markError, setMarkError] = useState("");
  const [editing, setEditing] = useState<{ id: number; note: string } | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);

  // Keyboard: Escape closes. Focus moves into the dialog and returns to what opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  // Load the document once.
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const response = await axios.get<ArrayBuffer>(`${API_URL}/documents/${documentId}/files/${file.id}`, {
          responseType: "arraybuffer",
        });
        const doc = await pdfjs.getDocument({ data: new Uint8Array(response.data), useWasm: false }).promise;
        if (cancelled) {
          void doc.loadingTask.destroy();
          return;
        }
        loaded = doc;
        setPdf(doc);
        setPageNumber((n) => Math.min(Math.max(1, n), doc.numPages));
      } catch (err) {
        if (!cancelled) setError(apiError(err, t("pdf.openFailed")));
      }
    })();
    return () => {
      cancelled = true;
      void loaded?.loadingTask.destroy();
    };
  }, [documentId, file.id, t]);

  // The person's highlights in this file (a failure only means none are shown).
  useEffect(() => {
    let cancelled = false;
    axios
      .get<{ highlights: Highlight[] }>(`${API_URL}/documents/${documentId}/highlights`)
      .then((response) => !cancelled && setHighlights(forFile(response.data.highlights, file.id)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [documentId, file.id]);

  const here = onPage(highlights, pageNumber);
  // What the marks are found from: the text of the page and the highlights on it.
  const hereKey = here.map((h) => `${h.id}:${h.quote}`).join("|");

  // Draw the current page, make its words selectable, and mark the cited passage and the person's highlights.
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    setBoxes([]);
    setMarks([]);
    setLocated(null);

    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const page = await pdf.getPage(pageNumber);
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;

        const available = scrollRef.current?.clientWidth ?? MAX_PAGE_WIDTH;
        const width = Math.min(Math.max(available - 24, 280), MAX_PAGE_WIDTH);
        const scale = width / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale });
        // Draw at the screen's pixel density so text stays sharp.
        const density = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * density);
        canvas.height = Math.floor(viewport.height * density);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        task = page.render({ canvas, viewport: page.getViewport({ scale: scale * density }) });
        await task.promise;
        if (cancelled) return;

        const content = await page.getTextContent();
        const items = content.items.filter((item): item is TextItem => "str" in item);
        const boxesOf = (text: string): Box[] =>
          findHighlight(items, text).map((i) => {
            const item = items[i];
            const m = pdfjs.Util.transform(viewport.transform, item.transform);
            const fontHeight = Math.hypot(m[2], m[3]);
            return { left: m[4], top: m[5] - fontHeight, width: item.width * scale, height: fontHeight * 1.2 };
          });

        // The words of the page, laid over the picture so they can be selected.
        const layer = textLayerRef.current;
        if (layer) {
          layer.replaceChildren();
          layer.style.setProperty("--scale-factor", String(scale));
          layer.style.setProperty("--total-scale-factor", String(scale));
          await new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport }).render();
        }
        if (cancelled) return;

        setMarks(here.map((h) => ({ id: h.id, boxes: boxesOf(h.quote) })));
        if (pageNumber !== openOn) {
          setLocated(true);
          return;
        }
        const found = boxesOf(passage);
        setBoxes(found);
        setLocated(found.length > 0);
        if (found.length > 0) {
          scrollRef.current?.scrollTo({ top: Math.max(0, found[0].top - 120), behavior: "smooth" });
        }
      } catch (err) {
        // A render interrupted by switching pages is not an error.
        if (!cancelled && !(err instanceof Error && err.name === "RenderingCancelledException")) {
          setError(t("pdf.drawFailed"));
        }
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageNumber, openOn, passage, t, hereKey]);

  // Words selected on the page (by mouse, touch or keyboard) can be highlighted. The words stay chosen while a note is typed or the
  // button is pressed; a new press on the page starts again.
  useEffect(() => {
    const onChange = () => {
      const selection = window.getSelection();
      const layer = textLayerRef.current;
      if (selection && !selection.isCollapsed && layer && selection.anchorNode && layer.contains(selection.anchorNode)) {
        setSelected(quoteFrom(selection.toString()));
      }
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  const changed = useCallback(() => onHighlightsChanged?.(), [onHighlightsChanged]);

  const highlightSelected = async () => {
    if (!canHighlight(selected)) return;
    setBusy(true);
    setMarkError("");
    try {
      const response = await axios.post<Highlight>(`${API_URL}/documents/${documentId}/highlights`, {
        fileId: file.id,
        page: pageNumber,
        quote: selected,
        note: note.trim(),
      });
      setHighlights((current) => [...current, response.data]);
      setSelected("");
      setNote("");
      window.getSelection()?.removeAllRanges();
      changed();
    } catch (err) {
      setMarkError(apiError(err, t("pdf.highlightFailed")));
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    if (!editing) return;
    setBusy(true);
    setMarkError("");
    try {
      const response = await axios.put<Highlight>(`${API_URL}/highlights/${editing.id}`, { note: editing.note.trim() });
      setHighlights((current) => current.map((h) => (h.id === editing.id ? { ...h, note: response.data.note } : h)));
      setEditing(null);
      changed();
    } catch (err) {
      setMarkError(apiError(err, t("pdf.highlightFailed")));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (highlight: Highlight) => {
    if (!window.confirm(t("pdf.confirmRemove", { text: shortQuote(highlight.quote, 60) }))) return;
    setMarkError("");
    try {
      await axios.delete(`${API_URL}/highlights/${highlight.id}`);
      setHighlights((current) => current.filter((h) => h.id !== highlight.id));
      changed();
    } catch (err) {
      setMarkError(apiError(err, t("pdf.highlightFailed")));
    }
  };

  const total = pdf?.numPages ?? 0;
  const go = (delta: number) => {
    setSelected("");
    setEditing(null);
    setPageNumber((n) => Math.min(Math.max(1, n + delta), Math.max(total, 1)));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-3"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("pdf.aria", { name: file.name, page: pageNumber })}
        tabIndex={-1}
        data-testid="pdf-viewer"
        className="flex max-h-[94vh] w-full max-w-4xl flex-col rounded-2xl border border-ink/20 bg-surface shadow-2xl outline-none"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/15 px-4 py-2 text-base">
          <p className="truncate font-semibold" title={file.name}>
            {file.name}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={!pdf || pageNumber <= 1}
              aria-label={t("pdf.prev")}
              className="btn btn-secondary btn-sm"
            >
              &larr;
            </button>
            <span aria-live="polite" data-testid="pdf-page">
              {pdf ? t("pdf.pageOf", { page: pageNumber, total }) : t("common.loading")}
            </span>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={!pdf || pageNumber >= total}
              aria-label={t("pdf.next")}
              className="btn btn-secondary btn-sm"
            >
              &rarr;
            </button>
            <button type="button" onClick={onClose} className="btn btn-primary btn-sm ml-2">
              {t("pdf.close")}
            </button>
          </div>
        </div>

        {pageNumber === openOn && located === false && (
          <p className="border-b border-ink/15 px-4 py-1.5 text-sm" role="status">
            {t("pdf.notLocated")}
          </p>
        )}

        {/* What is selected on the page can be highlighted, with a note. */}
        <div className="border-b border-ink/15 px-4 py-2 text-sm" data-testid="pdf-mark-bar">
          {canHighlight(selected) ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 truncate" data-testid="pdf-selected">
                {t("pdf.selected", { text: shortQuote(selected, 80) })}
              </p>
              <label className="sr-only" htmlFor="pdf-note">
                {t("pdf.noteLabel")}
              </label>
              <input
                id="pdf-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={MAX_NOTE}
                placeholder={t("pdf.notePlaceholder")}
                className="field min-w-0 flex-1 basis-48"
              />
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void highlightSelected()} disabled={busy} className="btn btn-primary btn-sm">
                {t("pdf.highlight")}
              </button>
            </div>
          ) : (
            <p className="muted">{t("pdf.highlightHint")}</p>
          )}
          {markError && (
            <p className="mt-1 font-medium text-danger" role="alert">
              {markError}
            </p>
          )}
        </div>

        <div ref={scrollRef} className="overflow-auto p-3">
          {error ? (
            <p className="text-base font-medium text-danger" role="alert">
              {error}
            </p>
          ) : (
            <>
              <div className="relative mx-auto w-fit bg-white shadow">
                <canvas ref={canvasRef} data-testid="pdf-canvas" className="block" />
                {boxes.map((b, i) => (
                  <div
                    key={i}
                    data-testid="pdf-highlight"
                    className="pointer-events-none absolute bg-yellow-300/50 mix-blend-multiply"
                    style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
                  />
                ))}
                {marks.flatMap((m) =>
                  m.boxes.map((b, i) => (
                    <div
                      key={`${m.id}-${i}`}
                      data-testid="pdf-mark"
                      className="pointer-events-none absolute bg-green-400/40 mix-blend-multiply"
                      style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
                    />
                  )),
                )}
                <div ref={textLayerRef} className="textLayer" data-testid="pdf-text-layer" onMouseDown={() => setSelected("")} />
              </div>

              {here.length > 0 && (
                <section className="mx-auto mt-4 max-w-[900px]" aria-label={t("pdf.highlightsHere")} data-testid="page-highlights">
                  <h3 className="text-base font-semibold">{t("pdf.highlightsHere")}</h3>
                  <ul className="mt-2 space-y-2">
                    {here.map((h) => (
                      <li key={h.id} className="rounded-xl border border-ink/20 p-3 text-sm" data-testid="page-highlight">
                        <blockquote className="border-l-2 border-green-600 pl-3">{shortQuote(h.quote, 200)}</blockquote>
                        {editing?.id === h.id ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label className="sr-only" htmlFor={`note-${h.id}`}>
                              {t("pdf.noteLabel")}
                            </label>
                            <input
                              id={`note-${h.id}`}
                              value={editing.note}
                              onChange={(e) => setEditing({ id: h.id, note: e.target.value })}
                              maxLength={MAX_NOTE}
                              className="field min-w-0 flex-1 basis-48"
                              autoFocus
                            />
                            <button type="button" onClick={() => void saveNote()} disabled={busy} className="btn btn-primary btn-sm">
                              {t("pdf.saveNote")}
                            </button>
                            <button type="button" onClick={() => setEditing(null)} className="btn btn-quiet btn-sm">
                              {t("common.cancel")}
                            </button>
                          </div>
                        ) : (
                          <>
                            {h.note && <p className="mt-1 font-medium">{h.note}</p>}
                            <div className="mt-2 flex gap-2">
                              <button type="button" onClick={() => setEditing({ id: h.id, note: h.note })} className="btn btn-quiet btn-sm">
                                {h.note ? t("pdf.editNote") : t("pdf.addNote")}
                              </button>
                              <button type="button" onClick={() => void remove(h)} className="btn btn-quiet btn-sm">
                                {t("pdf.removeHighlight")}
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
