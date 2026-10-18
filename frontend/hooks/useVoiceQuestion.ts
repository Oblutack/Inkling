"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { useT } from "../components/I18nProvider";
import { API_URL, apiError } from "../lib/api";
import { canRecordHere, pickRecordingType } from "../lib/recording";
import { SilenceWatcher, VOICE_BITS_PER_SECOND, VOICE_MAX_SECONDS, rmsLevel, voiceFileName } from "../lib/voice";

export type VoicePhase = "idle" | "listening" | "sending";

// Records a spoken question from the microphone, stops by itself when the person has finished (or after a minute, or when
// nothing is said at all), has the server write it down, and hands the words on. Nothing is kept: the sound is only sent to
// be written down, and goes no further.
export function useVoiceQuestion(onText: (text: string) => void) {
  const t = useT();
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [problem, setProblem] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const chunks = useRef<Blob[]>([]);
  const discard = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => setAvailable(canRecordHere()), []);

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void audio.current?.close().catch(() => undefined);
    audio.current = null;
  }, []);

  // Leaving the page stops the microphone and keeps nothing.
  useEffect(
    () => () => {
      discard.current = true;
      if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
      release();
    },
    [release]
  );

  const stop = useCallback(() => {
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
  }, []);

  const cancel = useCallback(() => {
    discard.current = true;
    stop();
  }, [stop]);

  const start = useCallback(async () => {
    setProblem("");
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setProblem(t("voice.blocked"));
      return;
    }
    try {
      const type = pickRecordingType((candidate) => MediaRecorder.isTypeSupported(candidate));
      const instance = new MediaRecorder(media, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: VOICE_BITS_PER_SECOND });
      stream.current = media;
      recorder.current = instance;
      chunks.current = [];
      discard.current = false;
      let silent = false;

      instance.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      instance.onstop = () => {
        const mime = instance.mimeType || type || "audio/webm";
        const blob = new Blob(chunks.current, { type: mime });
        const kept = !discard.current && chunks.current.length > 0;
        release();
        recorder.current = null;
        chunks.current = [];
        if (silent) {
          setPhase("idle");
          setProblem(t("voice.noSpeech"));
          return;
        }
        if (!kept) {
          setPhase("idle");
          return;
        }
        setPhase("sending");
        const form = new FormData();
        form.append("audio", new File([blob], voiceFileName(mime), { type: mime }));
        axios
          .post<{ text: string }>(`${API_URL}/voice/transcribe`, form)
          .then((response) => onTextRef.current(response.data.text))
          .catch((err) => setProblem(apiError(err, t("voice.failed"))))
          .finally(() => setPhase("idle"));
      };

      // Watch how loud it is, to know when the question is over.
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const started = performance.now();
      let watcher: SilenceWatcher | null = null;
      let analyser: AnalyserNode | null = null;
      let samples: Uint8Array<ArrayBuffer> | null = null;
      if (Context) {
        try {
          const context = new Context();
          audio.current = context;
          analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          context.createMediaStreamSource(media).connect(analyser);
          samples = new Uint8Array(analyser.fftSize);
          watcher = new SilenceWatcher();
        } catch {
          watcher = null; // without it the person stops the question themselves
        }
      }

      instance.start(500);
      setPhase("listening");
      timer.current = setInterval(() => {
        const now = performance.now();
        if (now - started >= VOICE_MAX_SECONDS * 1000) {
          stop();
          return;
        }
        if (!watcher || !analyser || !samples) return;
        analyser.getByteTimeDomainData(samples);
        const state = watcher.update(rmsLevel(samples), now);
        if (state === "stop") stop();
        else if (state === "nothing") {
          silent = true;
          discard.current = true;
          stop();
        }
      }, 100);
    } catch {
      media.getTracks().forEach((track) => track.stop());
      setProblem(t("voice.failed"));
    }
  }, [release, stop, t]);

  return { available, phase, problem, start, stop, cancel };
}
