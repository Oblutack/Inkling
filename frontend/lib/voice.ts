import { toPlainText } from "./markdownText";
import { extensionFor } from "./recording";

// Talking to a document: a question is spoken, written down by the server, asked like a typed one, and the answer can be read
// aloud. These are the parts that need no microphone, so they can be tested.

// A spoken question is short: the server takes up to a minute (and about a megabyte).
export const VOICE_MAX_SECONDS = 60;
// Speech is clear at a low bit rate: a minute is then about 180 KB.
export const VOICE_BITS_PER_SECOND = 24_000;
// Listening stops by itself after this much quiet once something was said, and gives up if nothing is said at all.
export const SILENCE_STOP_MS = 1500;
export const NO_SPEECH_GIVE_UP_MS = 8000;
// How loud counts as speech: the RMS of the signal (0 silent to 1 as loud as it gets).
export const SPEECH_LEVEL = 0.03;

// The loudness of a short stretch of sound as an analyser gives it: bytes around 128 for silence.
export function rmsLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

export type ListenState = "waiting" | "speaking" | "stop" | "nothing";

// Decides, from how loud it is over time, when a question has been asked: speech has started, has stopped for long enough, or
// never came. It only knows the loudness and the time, so it needs no sound to be tested.
export class SilenceWatcher {
  private startedAt: number | null = null;
  private lastSpeech: number | null = null;

  constructor(
    private readonly options: { level?: number; silenceMs?: number; giveUpMs?: number } = {},
  ) {}

  update(level: number, now: number): ListenState {
    const threshold = this.options.level ?? SPEECH_LEVEL;
    const silenceMs = this.options.silenceMs ?? SILENCE_STOP_MS;
    const giveUpMs = this.options.giveUpMs ?? NO_SPEECH_GIVE_UP_MS;
    if (this.startedAt === null) this.startedAt = now;
    if (level >= threshold) this.lastSpeech = now;
    if (this.lastSpeech === null) return now - this.startedAt >= giveUpMs ? "nothing" : "waiting";
    return now - this.lastSpeech >= silenceMs ? "stop" : "speaking";
  }
}

// The name of the clip sent, from its type.
export function voiceFileName(mimeType: string): string {
  return `question${extensionFor(mimeType)}`;
}

// An answer as it is read aloud: plain words, with no marks and no citation numbers ("[1]") that a voice would read out.
export function speechText(markdown: string): string {
  return toPlainText(markdown)
    .replace(/\[\d+\]|【\d+】/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}
