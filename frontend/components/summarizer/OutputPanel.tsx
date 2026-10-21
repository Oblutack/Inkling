"use client";
import { useEffect, useRef } from "react";
import Markdown from "markdown-to-jsx";
import { createMarkdownOptions } from "../../lib/markdown";
import { tidyMarkdown } from "../../lib/markdownText";
import { useT } from "../I18nProvider";

const markdownOptions = createMarkdownOptions();

interface OutputPanelProps {
  summary: string;
  isLoading: boolean;
  progress: number;
  stageLabel: string;
}

// Where the summary appears, word by word as it is written. Before the first words there is a progress bar.
export default function OutputPanel({ summary, isLoading, progress, stageLabel }: OutputPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const t = useT();

  // Follow the text as it streams in.
  useEffect(() => {
    if (isLoading && summary && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [isLoading, summary]);

  // Before the first words arrive, show progress; after that, show the text as it is written.
  const showProgress = isLoading && !summary;

  return (
    <div className="card" aria-live={isLoading ? "off" : undefined}>
      <div ref={scrollRef} className="max-h-[32rem] overflow-y-auto pr-1">
        {showProgress ? (
          <div className="py-6 text-center" role="status" aria-live="polite">
            {/* Keyed by the stage, so each new stage settles in instead of the words changing under the eye. */}
            <p key={stageLabel} className="rise-sm text-lg font-medium text-ink/80">
              {stageLabel}
            </p>
            <p className="mt-1 text-4xl font-semibold tabular-nums">{Math.round(progress)}%</p>
            <div className="mx-auto mt-4 h-2 w-full max-w-md overflow-hidden rounded-full bg-ink/15" aria-hidden="true">
              <div className="shimmer shimmer-on-accent h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${progress}%` }} />
            </div>
          </div>
        ) : (
          // The id is how the PDF export finds the rendered summary.
          <div id="summary-output-content" aria-busy={isLoading} className={`reading text-left ${isLoading ? "stream-in" : ""}`}>
            <Markdown options={markdownOptions}>{tidyMarkdown(summary)}</Markdown>
            {isLoading && (
              <p className="mt-2 text-sm font-semibold uppercase tracking-widest text-ink/70" role="status">
                {/* The three dots of the label are drawn by the animation instead. */}
                {t("form.writing").replace(/[.…]+$/, "")}
                <span className="dots ml-0.5" aria-hidden="true">
                  <span style={{ "--i": 0 } as React.CSSProperties}>.</span>
                  <span style={{ "--i": 1 } as React.CSSProperties}>.</span>
                  <span style={{ "--i": 2 } as React.CSSProperties}>.</span>
                </span>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
