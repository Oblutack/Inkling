"use client";
import Markdown from "markdown-to-jsx";
import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import dynamic from "next/dynamic";
import type { Document, FileInfo, ProofPassage, ProofResult } from "../types";
import { API_URL, apiError } from "../lib/api";
import { downloadBlob, downloadMarkdown, downloadWord } from "../lib/exportDoc";
import { noteFileName, noteMarkdown, type Note } from "../lib/obsidian";
import { isAudioFile, isPdfFile } from "../lib/links";
import { createMarkdownOptions } from "../lib/markdown";
import { tidyMarkdown } from "../lib/markdownText";
import { saveElementAsPdf } from "../lib/pdfExport";
import CopyButton from "./CopyButton";
import DocumentChat from "./DocumentChat";
import EmailSummaryButton from "./EmailSummaryButton";
import OriginalText from "./OriginalText";
import RecordingPanel from "./RecordingPanel";
import PodcastPlayer from "./PodcastPlayer";
import ProofView from "./ProofView";
import ReadAloudPlayer, { ReadAloudToggle } from "./ReadAloudPlayer";
import ComparePanel from "./ComparePanel";
import BilingualPanel from "./BilingualPanel";
import ChecklistPanel from "./ChecklistPanel";
import DatesPanel from "./DatesPanel";
import ExtractPanel from "./ExtractPanel";
import GlossaryPanel from "./GlossaryPanel";
import HighlightsPanel from "./HighlightsPanel";
import TermMark from "./TermMark";
import { markTerms, type Glossary } from "../lib/glossary";
import MindMap from "./MindMap";
import RewritePanel from "./RewritePanel";
import ShareControl from "./ShareControl";
import StudyPanel from "./StudyPanel";
import TagEditor from "./TagEditor";
import { DownloadIcon, TrashIcon } from "./Icon";
import { useT } from "./I18nProvider";
import { actionButton, fieldClass, textButton } from "./styles";

interface DocumentCardProps {
  doc: Document;
  onDelete: (id: number) => void;
  // Called with what changed (a new title, tags, summary or share link), so the list stays in step.
  onChange: (id: number, patch: Partial<Document>) => void;
  // Show the flashcards at once: this document was just made as a study set.
  openStudy?: boolean;
}

// The PDF viewer is large; it is only fetched when someone opens a page.
const PdfViewer = dynamic(() => import("./PdfViewer"), { ssr: false });

// Saved cards use larger body text than the live form.
const markdownOptions = createMarkdownOptions();

// Selected text this short or long is not worth a question.
const MIN_SELECTION = 4;
const MAX_SELECTION = 300;

interface Selected {
  text: string;
  top: number;
  left: number;
}

export default function DocumentCard({ doc, onDelete, onChange, openStudy = false }: DocumentCardProps) {
  const t = useT();
  // A study set was read only to be studied, so it has no summary (yet): the tools made for a summary are left out.
  const studySet = doc.Summary.trim() === "";
  // A recording's text is what was said.
  const transcript = isAudioFile(doc.Filename);
  // Only PDFs have pages to open; a kept recording is played.
  const pdfFiles = (doc.files ?? []).filter((f) => isPdfFile(f.name));
  const recordingFile = (doc.files ?? []).find((f) => isAudioFile(f.name));
  const playFrom = (seconds: number) => {
    setRecordingOpen(true);
    setPlayAt({ seconds, nonce: Date.now() });
  };
  const [chatOpen, setChatOpen] = useState(false);
  const [podcastOpen, setPodcastOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [studyOpen, setStudyOpen] = useState(studySet || openStudy);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const [datesOpen, setDatesOpen] = useState(false);
  const [bilingualOpen, setBilingualOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [highlightsOpen, setHighlightsOpen] = useState(false);
  // Changes when a highlight is made, changed or removed in the viewer, so the list of them is read again.
  const [highlightsVersion, setHighlightsVersion] = useState(0);
  // The glossary, once the Terms panel has it: the terms are underlined in the summary.
  const [glossary, setGlossary] = useState<Glossary | null>(null);
  const [checklistOpen, setChecklistOpen] = useState(false);
  // The quieter actions (export, email, share, rewrite) stay tucked away, unless there is a link to show.
  const [moreOpen, setMoreOpen] = useState(Boolean(doc.shareToken));
  const [textOpen, setTextOpen] = useState(false);
  const [readOpen, setReadOpen] = useState(false);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [playAt, setPlayAt] = useState<{ seconds: number; nonce: number } | null>(null);
  // The proof check: each sentence of the summary compared with the original document.
  const [proof, setProof] = useState<ProofResult | null>(null);
  const [proofOpen, setProofOpen] = useState(false);
  const [proofLoading, setProofLoading] = useState(false);
  const [proofError, setProofError] = useState("");
  const [viewing, setViewing] = useState<{ file: FileInfo; page: number; passage: string } | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(doc.Filename);
  const [titleError, setTitleError] = useState("");

  // Text selected in the summary, with where to show the "ask about this" button, and the question it makes.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [prefill, setPrefill] = useState<{ text: string } | undefined>();

  const toggleProof = async () => {
    if (proofOpen) {
      setProofOpen(false);
      return;
    }
    setProofError("");
    if (!proof) {
      setProofLoading(true);
      try {
        const response = await axios.post<ProofResult>(`${API_URL}/documents/${doc.ID}/proof`);
        setProof(response.data);
      } catch (err) {
        setProofError(apiError(err, t("doc.proofError")));
        return;
      } finally {
        setProofLoading(false);
      }
    }
    setProofOpen(true);
  };

  const handleDownloadPDF = () => {
    const element = document.getElementById(`doc-content-${doc.ID}`);
    if (!element) return;
    saveElementAsPdf(element, doc.Filename.replace(/\.[^/.]+$/, "") + "-summary.pdf");
  };

  // The document as a note for Obsidian or Notion: front matter, the summary and its flashcards, as one Markdown file.
  const downloadNote = async () => {
    setProofError("");
    try {
      const response = await axios.get<Note>(`${API_URL}/documents/${doc.ID}/note`);
      const blob = new Blob([noteMarkdown(response.data)], { type: "text/markdown;charset=utf-8" });
      downloadBlob(blob, noteFileName(response.data.title, new Set()));
    } catch (err) {
      setProofError(apiError(err, t("doc.obsidianFailed")));
    }
  };

  const saveTitle = async (e: React.FormEvent) => {
    e.preventDefault();
    setTitleError("");
    try {
      const response = await axios.put<{ Filename: string }>(`${API_URL}/documents/${doc.ID}`, { filename: titleDraft });
      onChange(doc.ID, { Filename: response.data.Filename });
      setRenaming(false);
    } catch (err) {
      setTitleError(apiError(err, t("doc.renameFailed")));
    }
  };

  // Offer a question about the selected words, when a few words of this summary are selected.
  const readSelection = useCallback(() => {
    if (!doc.hasContent) return;
    const selection = window.getSelection();
    const container = contentRef.current;
    const card = cardRef.current;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container || !card) {
      setSelected(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (!container.contains(range.commonAncestorContainer) || text.length < MIN_SELECTION || text.length > MAX_SELECTION) {
      setSelected(null);
      return;
    }
    const box = range.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    setSelected({ text, top: box.top - cardBox.top - 46, left: Math.max(8, box.left - cardBox.left) });
  }, [doc.hasContent]);

  // A click elsewhere collapses the selection; the button must go with it.
  useEffect(() => {
    if (!selected) return;
    const onChange = () => {
      if (window.getSelection()?.isCollapsed) setSelected(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [selected]);

  const askAboutSelection = () => {
    if (!selected) return;
    setChatOpen(true);
    setPrefill({ text: t("doc.prefillQuestion", { text: selected.text }) });
    setSelected(null);
    window.getSelection()?.removeAllRanges();
  };

  const summaryOptions = useMemo(
    () => ({
      ...markdownOptions,
      overrides: { ...markdownOptions.overrides, a: { component: TermMark, props: { terms: glossary?.terms ?? [] } } },
    }),
    [glossary]
  );
  const summaryMarkdown = useMemo(() => {
    const text = tidyMarkdown(doc.Summary);
    return glossary && glossary.terms.length > 0 ? markTerms(text, glossary.terms) : text;
  }, [doc.Summary, glossary]);

  const summaryChanged = (summary: string) => {
    onChange(doc.ID, { Summary: summary });
    // Everything made from the old summary is gone with it.
    setProof(null);
    setProofOpen(false);
    setPodcastOpen(false);
    setBilingualOpen(false);
    // The cards of a study set were made from the text, so they are still right.
    if (!studySet) setStudyOpen(false);
    setRewriteOpen(false);
  };

  return (
    <motion.div
      layout="position" // animate position changes when cards are added or removed (not size changes: they would squash the content)
      initial={{ opacity: 0, y: 12, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
      className="card relative"
      ref={cardRef}
      data-testid="document-card"
    >
      <div className="flex items-start justify-between gap-3">
        {renaming ? (
          <form onSubmit={saveTitle} className="mr-2 flex min-w-0 flex-grow flex-wrap items-center gap-2">
            <input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              maxLength={200}
              aria-label={t("doc.title")}
              autoFocus
              className={`${fieldClass} min-w-0 flex-1`}
            />
            <button type="submit" className={actionButton}>
              {t("doc.save")}
            </button>
            <button
              type="button"
              onClick={() => {
                setRenaming(false);
                setTitleDraft(doc.Filename);
                setTitleError("");
              }}
              className={textButton}
            >
              {t("common.cancel")}
            </button>
          </form>
        ) : (
          <h3 className="min-w-0 flex-grow break-words text-xl font-semibold leading-snug">{doc.Filename}</h3>
        )}

        <div className="flex flex-shrink-0 items-center gap-1">
          {!studySet && (
            <>
              <CopyButton variant="icon" what={t("doc.summaryOf", { title: doc.Filename })} text={doc.Summary} />
              <button
                onClick={handleDownloadPDF}
                title={t("doc.savePdfTitle")}
                aria-label={t("doc.savePdfAria", { title: doc.Filename })}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-ink/80 hover:bg-ink/10 hover:text-ink"
              >
                <DownloadIcon className="h-5 w-5" />
              </button>
            </>
          )}

          <button
            onClick={() => onDelete(doc.ID)}
            title={t("doc.deleteTitle")}
            aria-label={t("doc.deleteAria", { title: doc.Filename })}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-danger hover:bg-danger/10"
          >
            <TrashIcon className="h-5 w-5" />
          </button>
        </div>
      </div>
      {titleError && (
        <p className="mt-1 text-sm font-medium text-danger" role="alert">
          {titleError}
        </p>
      )}

      <p className="mt-0.5 text-sm text-ink/70">
        {t("doc.created", { date: new Date(doc.CreatedAt).toLocaleDateString() })}
        {!renaming && (
          <>
            {" · "}
            <button
              type="button"
              onClick={() => {
                setTitleDraft(doc.Filename);
                setRenaming(true);
              }}
              className="tap-target rounded underline underline-offset-4 hover:text-ink"
              aria-label={t("doc.renameAria", { title: doc.Filename })}
            >
              {t("doc.rename")}
            </button>
          </>
        )}
      </p>
      <TagEditor documentId={doc.ID} tags={doc.tags ?? []} onChange={(tags) => onChange(doc.ID, { tags })} />

      <div className={`mt-4 border-t border-ink/15 pt-4 ${proofOpen && proof ? "" : "max-h-72 overflow-y-auto pr-1"}`}>
        {/* The id is how the PDF export finds this card's content. */}
        <div id={`doc-content-${doc.ID}`} ref={contentRef} onMouseUp={readSelection} onKeyUp={readSelection} className="reading">
          {studySet ? (
            <p className="muted text-base" data-testid="study-set-note">
              {t("doc.studySetNote")}
            </p>
          ) : proofOpen && proof ? (
            <ProofView
              result={proof}
              files={pdfFiles}
              onOpenDocument={(file: FileInfo, p: ProofPassage) =>
                setViewing({ file, page: p.page ?? 1, passage: p.text })
              }
            />
          ) : (
            <Markdown options={summaryOptions}>{summaryMarkdown}</Markdown>
          )}
        </div>
      </div>

      {selected && (
        <button
          type="button"
          // Pressing a button would clear the selection before the click lands.
          onMouseDown={(e) => e.preventDefault()}
          onClick={askAboutSelection}
          style={{ top: selected.top, left: selected.left }}
          className="btn btn-primary btn-sm absolute z-10 shadow-lg"
        >
          {t("doc.askAboutThis")}
        </button>
      )}

      {proofError && (
        <p className="mt-2 text-sm font-medium text-danger" role="alert">
          {proofError}
        </p>
      )}

      {doc.hasContent && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!studySet && (
            <>
              <button type="button" onClick={toggleProof} disabled={proofLoading} className={actionButton}>
                {proofLoading ? t("doc.checking") : proofOpen ? t("doc.backToSummary") : t("doc.check")}
              </button>
              <button type="button" onClick={() => setPodcastOpen((open) => !open)} className={actionButton}>
                {podcastOpen ? t("doc.closePodcast") : t("doc.podcast")}
              </button>
              <button type="button" onClick={() => setMapOpen((open) => !open)} className={actionButton} aria-expanded={mapOpen}>
                {mapOpen ? t("map.close") : t("map.open")}
              </button>
            </>
          )}
          <button type="button" onClick={() => setChatOpen((open) => !open)} className={actionButton}>
            {chatOpen ? t("doc.closeChat") : t("doc.chat")}
          </button>
          <button type="button" onClick={() => setStudyOpen((open) => !open)} className={actionButton}>
            {studyOpen ? t("doc.closeStudy") : t("doc.study")}
          </button>
        </div>
      )}

      {!doc.hasContent && <p className="muted mt-4 text-sm">{t("doc.noTools")}</p>}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setMoreOpen((open) => !open)}
          className={textButton}
          aria-expanded={moreOpen}
          aria-controls={`doc-more-${doc.ID}`}
        >
          {t("doc.more")}
          <svg viewBox="0 0 24 24" className={`h-4 w-4 transition-transform ${moreOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {moreOpen && (
          <div id={`doc-more-${doc.ID}`} className="mt-1 flex flex-wrap items-center gap-1" data-testid="more-actions">
            {!studySet && (
              <>
                <ReadAloudToggle open={readOpen} onToggle={() => setReadOpen((open) => !open)} />
                <button type="button" onClick={() => downloadMarkdown(doc.Filename, doc.Summary)} className={textButton}>
                  {t("doc.markdown")}
                </button>
                <button type="button" onClick={() => void downloadWord(doc.Filename, doc.Summary)} className={textButton}>
                  {t("doc.word")}
                </button>
                <EmailSummaryButton documentId={doc.ID} />
                <ShareControl documentId={doc.ID} token={doc.shareToken} onChange={(shareToken) => onChange(doc.ID, { shareToken })} />
              </>
            )}
            <button type="button" onClick={() => void downloadNote()} className={textButton}>
              {t("doc.obsidian")}
            </button>
            {doc.hasContent && (
              <button type="button" onClick={() => setRewriteOpen((open) => !open)} className={textButton} aria-expanded={rewriteOpen}>
                {rewriteOpen ? t("doc.closeRewrite") : studySet ? t("doc.makeSummary") : t("doc.rewrite")}
              </button>
            )}
            {doc.hasContent && (
              <button type="button" onClick={() => setCompareOpen((open) => !open)} className={textButton} aria-expanded={compareOpen}>
                {compareOpen ? t("compare.close") : t("compare.open")}
              </button>
            )}
            {doc.hasContent && (
              <button type="button" onClick={() => setExtractOpen((open) => !open)} className={textButton} aria-expanded={extractOpen}>
                {extractOpen ? t("extract.close") : t("extract.open")}
              </button>
            )}
            {!studySet && (
              <button type="button" onClick={() => setBilingualOpen((open) => !open)} className={textButton} aria-expanded={bilingualOpen}>
                {bilingualOpen ? t("bilingual.close") : t("bilingual.open")}
              </button>
            )}
            {doc.hasContent && (
              <button type="button" onClick={() => setHighlightsOpen((open) => !open)} className={textButton} aria-expanded={highlightsOpen}>
                {highlightsOpen ? t("highlights.close") : t("highlights.open")}
              </button>
            )}
            {doc.hasContent && (
              <button type="button" onClick={() => setGlossaryOpen((open) => !open)} className={textButton} aria-expanded={glossaryOpen}>
                {glossaryOpen ? t("glossary.close") : t("glossary.open")}
              </button>
            )}
            {doc.hasContent && (
              <button type="button" onClick={() => setDatesOpen((open) => !open)} className={textButton} aria-expanded={datesOpen}>
                {datesOpen ? t("dates.close") : t("dates.open")}
              </button>
            )}
            {doc.hasContent && (
              <button type="button" onClick={() => setChecklistOpen((open) => !open)} className={textButton} aria-expanded={checklistOpen}>
                {checklistOpen ? t("checklist.close") : t("checklist.open")}
              </button>
            )}
            {recordingFile && (
              <button type="button" onClick={() => setRecordingOpen((open) => !open)} className={textButton} aria-expanded={recordingOpen}>
                {recordingOpen ? t("doc.hideRecording") : t("doc.playRecording")}
              </button>
            )}
            {doc.hasContent && !recordingFile && (
              <button type="button" onClick={() => setTextOpen((open) => !open)} className={textButton} aria-expanded={textOpen}>
                {textOpen
                  ? transcript ? t("doc.hideTranscript") : t("doc.hideText")
                  : transcript ? t("doc.showTranscript") : t("doc.showText")}
              </button>
            )}
          </div>
        )}
      </div>

      {readOpen && <ReadAloudPlayer markdown={doc.Summary} onClose={() => setReadOpen(false)} />}
      {rewriteOpen && <RewritePanel documentId={doc.ID} onDone={summaryChanged} first={studySet} />}
      {compareOpen && doc.hasContent && <ComparePanel doc={doc} />}
      {extractOpen && doc.hasContent && <ExtractPanel doc={doc} />}
      {datesOpen && doc.hasContent && <DatesPanel doc={doc} />}
      {glossaryOpen && doc.hasContent && <GlossaryPanel doc={doc} onChange={setGlossary} />}
      {highlightsOpen && (
        <HighlightsPanel
          doc={doc}
          files={pdfFiles}
          version={highlightsVersion}
          onOpen={(file, page, quote) => setViewing({ file, page, passage: quote })}
        />
      )}
      {bilingualOpen && !studySet && <BilingualPanel doc={doc} />}
      {checklistOpen && doc.hasContent && <ChecklistPanel doc={doc} />}
      {textOpen && doc.hasContent && !recordingFile && <OriginalText documentId={doc.ID} transcript={transcript} />}
      {recordingOpen && recordingFile && <RecordingPanel documentId={doc.ID} file={recordingFile} seek={playAt} />}
      {podcastOpen && <PodcastPlayer documentId={doc.ID} />}
      {mapOpen && !studySet && (
        <MindMap doc={doc} files={pdfFiles} onOpenDocument={(file, passage) => setViewing({ file, page: passage.page ?? 1, passage: passage.text })} />
      )}
      {chatOpen && <DocumentChat documentId={doc.ID} files={pdfFiles} prefill={prefill} onPlayAt={recordingFile ? playFrom : undefined} />}
      {studyOpen && <StudyPanel documentId={doc.ID} title={doc.Filename} autoStart={openStudy} />}

      {viewing && (
        <PdfViewer
          documentId={doc.ID}
          file={viewing.file}
          page={viewing.page}
          passage={viewing.passage}
          onClose={() => setViewing(null)}
          onHighlightsChanged={() => setHighlightsVersion((v) => v + 1)}
        />
      )}
    </motion.div>
  );
}
