"use client";
import { useState } from "react";
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
}

type Mode = "summarize" | "study";

// The summarizer: put the words in, choose how the summary should be, press the button. The summary
// appears underneath as it is written. Or switch to Study: the same input becomes flashcards instead.
export default function EInkForm({ endpoint, onSummaryCreated, onStudySetCreated }: EInkFormProps) {
  const { user } = useAuth();
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

  const [mode, setMode] = useState<Mode>("summarize");
  const studying = Boolean(user && onStudySetCreated) && mode === "study";
  const study = useStudySetCreator((id) => {
    s.changeText(""); // the box is emptied, so pressing the button again does not make the same set twice
    onStudySetCreated?.(id);
  });
  const busy = s.isLoading || study.loading;

  const handleDownloadPDF = () => {
    const element = document.getElementById("summary-output-content");
    if (element) saveElementAsPdf(element, `${s.exportBaseName}-summary.pdf`);
  };

  const showOutput = (s.isLoading || s.summary !== "") && !studying;
  const shownError = studying ? study.error || s.error : s.error;

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

        <div>
          {busy ? (
            // Separate keys make these two different elements: if React reused one button, the click that cancels
            // would find it turned into a submit button by the time the browser acts on it, and start over.
            <button key="cancel" type="button" onClick={studying ? study.cancel : s.cancel} className="btn btn-danger w-full sm:w-auto sm:min-w-[12rem]">
              {t("common.cancel")}
            </button>
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
