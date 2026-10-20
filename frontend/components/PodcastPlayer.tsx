"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { useSpeechPlayer, type SpeechItem } from "../hooks/useSpeechPlayer";
import { API_URL, apiError } from "../lib/api";
import { languageCode, scriptToMarkdown } from "../lib/podcast";
import { LANGUAGES } from "../lib/summaryOptions";
import type { PodcastScript } from "../types";
import { useT } from "./I18nProvider";
import PlaybackControls from "./PlaybackControls";

const HOSTS = { A: "Alex", B: "Sam" } as const;

interface PodcastPlayerProps {
  documentId: number;
}

// A short two-host conversation about a document. The server writes the script (once, then it is kept);
// the browser reads it aloud with two of its own voices, so nothing is sent anywhere to be spoken.
export default function PodcastPlayer({ documentId }: PodcastPlayerProps) {
  const t = useT();
  const [script, setScript] = useState<PodcastScript | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [language, setLanguage] = useState("");

  const items: SpeechItem[] = useMemo(
    () => (script?.turns ?? []).map((turn) => ({ text: turn.text, role: turn.speaker })),
    [script]
  );
  const wanted = script?.language ? languageCode(script.language) : typeof navigator !== "undefined" ? navigator.language || "en" : "en";
  const player = useSpeechPlayer(items, wanted);
  const { stop } = player;

  // Ask for the script: the stored one if there is one, else a newly written one.
  const load = useCallback(
    async (opts: { language: string; regenerate: boolean }) => {
      setLoading(true);
      setError("");
      try {
        const response = await axios.post<PodcastScript>(`${API_URL}/documents/${documentId}/podcast`, opts);
        setScript(response.data);
      } catch (err) {
        setError(apiError(err, t("podcast.failed")));
      } finally {
        setLoading(false);
      }
    },
    [documentId, t]
  );

  useEffect(() => {
    void load({ language: "", regenerate: false });
  }, [load]);

  // The line being spoken stays in view.
  const list = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    if (player.index < 0) return;
    list.current?.querySelector<HTMLElement>(`[data-testid="podcast-turn-${player.index}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [player.index]);

  const download = () => {
    if (!script) return;
    const blob = new Blob([scriptToMarkdown(script, HOSTS)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${script.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "podcast"}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const canSpeak = player.canSpeak;

  return (
    <div className="mt-4 rounded-xl border border-ink/20 bg-canvas/50 p-4" data-testid="podcast">
      {loading && (
        <p className="text-base font-medium text-ink/70" role="status">
          {t("podcast.writing")}
        </p>
      )}

      {error && (
        <p className="text-base font-medium text-danger" role="alert">
          {error}
        </p>
      )}

      {player.failed && (
        <p className="text-base font-medium text-danger" role="alert">
          {t("podcast.speechFailed")}
        </p>
      )}

      {script && (
        <>
          <h4 className="text-xl font-semibold" data-testid="podcast-title">
            {script.title}
          </h4>
          <p className="text-sm text-ink/70">{t("podcast.intro", { a: HOSTS.A, b: HOSTS.B })}</p>

          {!canSpeak && (
            <p className="mt-2 text-base" role="status">
              {player.supported ? t("podcast.noVoices") : t("podcast.noSpeech")}
            </p>
          )}

          <div className="mt-3 flex flex-col gap-2">
            <PlaybackControls
              label={t("podcast.script")}
              status={player.status}
              index={player.index}
              count={items.length}
              rate={player.rate}
              remaining={player.remaining}
              disabled={!canSpeak}
              onPlay={() => player.play(0)}
              onPause={player.pause}
              onResume={player.resume}
              onStop={player.stop}
              onPrevious={player.previous}
              onNext={player.next}
              onSeek={player.seek}
              onRate={player.setRate}
            />
            <div>
              <button type="button" onClick={download} className="btn btn-quiet btn-sm">
                {t("podcast.saveScript")}
              </button>
            </div>
          </div>

          {canSpeak && (
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              {(["A", "B"] as const).map((host) => (
                <label key={host} className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-ink/80">{t("podcast.voiceOf", { host: HOSTS[host] })}</span>
                  <select
                    value={player.voiceOf(host)}
                    onChange={(e) => player.setVoice(host, e.target.value)}
                    className="h-9 max-w-[16rem] rounded-lg border border-ink/40 bg-surface px-2 text-sm"
                  >
                    {player.voices.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>
                        {v.name} ({v.lang})
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}

          <ol ref={list} className="mt-4 max-h-80 space-y-2 overflow-y-auto pr-1 text-base" aria-label={t("podcast.script")}>
            {script.turns.map((turn, i) => (
              <li
                key={i}
                data-testid={`podcast-turn-${i}`}
                data-active={player.index === i}
                aria-current={player.index === i ? "true" : undefined}
                className={`border-l-4 pl-3 ${player.index === i ? "border-accent font-semibold" : "border-ink/20"}`}
              >
                <button
                  type="button"
                  onClick={() => canSpeak && player.play(i)}
                  disabled={!canSpeak}
                  className="tap-pad block w-full text-left disabled:cursor-default"
                  aria-label={canSpeak ? t("podcast.playFrom", { host: HOSTS[turn.speaker], text: turn.text }) : undefined}
                >
                  <span className="mr-2 text-xs font-semibold uppercase tracking-widest text-ink/70">{HOSTS[turn.speaker]}</span>
                  {turn.text}
                </button>
              </li>
            ))}
          </ol>

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-ink/15 pt-3 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-sm font-semibold text-ink/80">{t("form.language")}</span>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="h-9 rounded-lg border border-ink/40 bg-surface px-2 text-sm"
              >
                <option value="">{t("podcast.sameAsDocument")}</option>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {t(`lang.${l}`)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                stop();
                void load({ language, regenerate: true });
              }}
              disabled={loading}
              className="btn btn-secondary btn-sm"
            >
              {t("podcast.newOne")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
