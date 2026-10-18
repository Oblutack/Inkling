"use client";
import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { API_URL, apiError } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";
import { useStudySetCreator } from "../hooks/useStudySetCreator";
import { useSummarizer } from "../hooks/useSummarizer";
import { saveElementAsPdf } from "../lib/pdfExport";
import { describeLength } from "../lib/readingTime";
import { useT } from "./I18nProvider";
import CopyButton from "./CopyButton";
import InputArea from "./summarizer/InputArea";
import OutputPanel from "./summarizer/OutputPanel";
import PageLimitPanel from "./summarizer/PageLimitPanel";
import SummaryOptions from "./summarizer/SummaryOptions";
import TurnstileWidget, { turnstileEnabled } from "./Turnstile";

interface EInkFormProps {
  endpoint: string;
  onSummaryCreated?: () => void;
  // When given (the dashboard, where there is a library to keep it in), signed-in people can also make a study set from
  // what they put in: flashcards with no summary. It is told which document was made.
  onStudySetCreated?: (id: number) => void;
  // Start with this in the box: something shared to Inkling from another app. Files, or text (a web address is text).
  initialText?: string;
  initialFiles?: File[];
  // When given (the dashboard), a web address in the box can be watched instead of summarized: the page is checked now and
  // then, and the person is told when something that matters changes. Called once the page is being watched.
  onWatchCreated?: () => void;
}

type Mode = "summarize" | "study";

// The summarizer: put the words in, choose how the summary should be, press the button. The summary
// appears underneath as it is written. Or switch to Study: the same input becomes flashcards instead.
export default function EInkForm({ endpoint, onSummaryCreated, onStudySetCreated, initialText, initialFiles, onWatchCreated }: EInkFormProps) {
  const { user, loading: authLoading } = useAuth();
  const t = useT();

  // Anonymous visitors prove they're human (when the site has Turnstile configured); signed-in
  // users are identified by their session instead.
  const needsHumanCheck = turnstileEnabled && !user;
  const [humanToken, setHumanToken] = useState("");
  const [humanReset, setHumanReset] = useState(0);

  const s = useSummarizer({
    endpoint,
    onSummaryCreated,
    humanCheck: needsHumanCheck
      ? {
          token: humanToken,
          reset: () => {
            setHumanToken("");
            setHumanReset((n) => n + 1);
          },
        }
      : undefined,
  });

  // Put what was shared in the box, once, when it is known who is signed in (a recording or a photo is for signed-in people).
  const filled = useRef(false);
  useEffect(() => {
    if (filled.current || authLoading) return;
    filled.current = true;
    if (initialFiles && initialFiles.length > 0) s.addFiles(initialFiles);
    else if (initialText) s.changeText(initialText);
  }, [authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const [mode, setMode] = useState<Mode>("summarize");
  const studying = Boolean(user && onStudySetCreated) && mode === "study";
  const study = useStudySetCreator((id) => {
    s.changeText(""); // the box is emptied, so pressing the button again does not make the same set twice
    onStudySetCreated?.(id);
  });
  const [watching, setWatching] = useState(false);
  const [watchError, setWatchError] = useState("");
  const busy = s.isLoading || study.loading || watching;

  // Start watching the web address in the box: the server opens the page once (to have a text to compare later versions
  // against) and says why when it cannot (the page cannot be read, or its site asks not to be checked automatically).
  const watchPage = async () => {
    if (!s.link) return;
    setWatching(true);
    setWatchError("");
    try {
      await axios.post(`${API_URL}/watches`, { url: s.link });
      onWatchCreated?.();
    } catch (err) {
      setWatchError(apiError(err, t("watch.failed")));
    } finally {
      setWatching(false);
    }
  };

  const handleDownloadPDF = () => {
    const element = document.getElementById("summary-output-content");
    if (element) saveElementAsPdf(element, `${s.exportBaseName}-summary.pdf`);
  };

  const showOutput = (s.isLoading || s.summary !== "") && !studying;
  const shownError = watchError || (studying ? study.error || s.error : s.error);
  const canWatch = Boolean(user && onWatchCreated && s.link && !studying);

  return (
    <div className="w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (studying) void study.create({ files: s.files, text: s.inputText, link: s.link });
          else s.submit();
        }}
        className="space-y-5"
      >
        {user && onStudySetCreated && (
          <div role="group" aria-label={t("form.modeLabel")} className="flex flex-wrap items-center gap-2" data-testid="mode-switch">
            {(["summarize", "study"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                disabled={busy}
                className="chip py-1"
              >
                {t(m === "summarize" ? "form.modeSummarize" : "form.modeStudy")}
              </button>
            ))}
          </div>
        )}
        {studying && <p className="text-sm text-ink/70">{t("form.studyHint")}</p>}

        <InputArea
          files={s.files}
          text={s.inputText}
          link={s.link}
          linkHint={studying ? t("form.linkDetectedStudy") : undefined}
          hasAudio={s.hasAudio}
          hasPhotos={s.hasPhotos}
          canRecord={Boolean(user)}
          onTextChange={s.changeText}
          onFilesPicked={s.addFiles}
          onRemoveFile={s.removeFile}
          onMoveFile={s.moveFile}
        />

        {!studying && (
          <SummaryOptions
            wordCount={s.wordCount}
            onWordCountChange={s.setWordCount}
            wordCountDisabled={s.showPageLimit}
            style={s.style}
            onStyleChange={s.setStyle}
            language={s.language}
            onLanguageChange={s.setLanguage}
          >
            {s.showPageLimit && (
              <PageLimitPanel
                value={s.pageLimit}
                onChange={s.setPageLimit}
                onIncrement={s.incrementPageLimit}
                onDecrement={s.decrementPageLimit}
              />
            )}
          </SummaryOptions>
        )}

        {needsHumanCheck && <TurnstileWidget onToken={setHumanToken} resetKey={humanReset} />}

        {shownError && (
          <p className="text-base font-medium text-danger" role="alert">
            {shownError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {busy ? (
            // Separate keys make these two different elements: if React reused one button, the click that cancels
            // would find it turned into a submit button by the time the browser acts on it, and start over.
            watching ? (
              <button key="watching" type="button" disabled className="btn btn-secondary w-full sm:w-auto sm:min-w-[12rem]">
                {t("watch.buttonBusy")}
              </button>
            ) : (
              <button key="cancel" type="button" onClick={studying ? study.cancel : s.cancel} className="btn btn-danger w-full sm:w-auto sm:min-w-[12rem]">
                {t("common.cancel")}
              </button>
            )
          ) : (
            <button
              key="summarize"
              type="submit"
              disabled={!s.canSubmit || (needsHumanCheck && !humanToken)}
              className="btn btn-primary w-full text-lg sm:w-auto sm:min-w-[12rem]"
            >
              {studying ? t("form.studyButton") : t("form.summarize")}
            </button>
          )}
          {canWatch && !busy && (
            <button key="watch" type="button" onClick={() => void watchPage()} className="btn btn-secondary w-full sm:w-auto sm:min-w-[12rem]">
              {t("watch.button")}
            </button>
          )}
        </div>
        {studying && study.loading && (
          <p className="text-base font-medium text-ink/70" role="status">
            {t("form.studyWorking")}
          </p>
        )}
      </form>

      {showOutput && (
        <div className="mt-6 space-y-3">
          <OutputPanel summary={s.summary} isLoading={s.isLoading} progress={s.progress} stageLabel={s.stageLabel} />

          {s.summary && !s.isLoading && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium text-ink/70" data-testid="summary-length">
                {t("form.lengthLine", { length: describeLength(s.summary, t) })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton text={s.summary} what={t("copy.whatSummary")} />
                <button type="button" onClick={handleDownloadPDF} className="btn btn-secondary btn-sm">
                  {t("form.savePdf")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
