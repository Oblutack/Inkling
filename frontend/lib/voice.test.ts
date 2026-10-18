import { describe, expect, it } from "vitest";
import { NO_SPEECH_GIVE_UP_MS, SILENCE_STOP_MS, SilenceWatcher, rmsLevel, speechText, voiceFileName } from "./voice";

describe("rmsLevel", () => {
  it("is zero for silence and for nothing", () => {
    expect(rmsLevel(new Uint8Array(100).fill(128))).toBe(0);
    expect(rmsLevel([])).toBe(0);
  });

  it("grows with the loudness", () => {
    const quiet = Uint8Array.from({ length: 100 }, (_, i) => (i % 2 ? 130 : 126));
    const loud = Uint8Array.from({ length: 100 }, (_, i) => (i % 2 ? 228 : 28));
    expect(rmsLevel(quiet)).toBeLessThan(0.05);
    expect(rmsLevel(loud)).toBeGreaterThan(0.7);
    expect(rmsLevel(loud)).toBeLessThanOrEqual(1);
  });
});

describe("SilenceWatcher", () => {
  it("waits for speech, follows it, and stops after enough quiet", () => {
    const watcher = new SilenceWatcher();
    expect(watcher.update(0, 0)).toBe("waiting");
    expect(watcher.update(0.01, 500)).toBe("waiting");
    expect(watcher.update(0.2, 1000)).toBe("speaking");
    expect(watcher.update(0.01, 1500)).toBe("speaking");
    expect(watcher.update(0.01, 1000 + SILENCE_STOP_MS - 1)).toBe("speaking");
    expect(watcher.update(0.01, 1000 + SILENCE_STOP_MS)).toBe("stop");
  });

  it("a pause shorter than the quiet does not end the question", () => {
    const watcher = new SilenceWatcher();
    watcher.update(0.2, 0);
    expect(watcher.update(0.0, 1000)).toBe("speaking");
    expect(watcher.update(0.2, 1200)).toBe("speaking");
    expect(watcher.update(0.0, 2600)).toBe("speaking");
    expect(watcher.update(0.0, 2700)).toBe("stop");
  });

  it("gives up when nothing is ever said", () => {
    const watcher = new SilenceWatcher();
    expect(watcher.update(0, 100)).toBe("waiting");
    expect(watcher.update(0.005, 100 + NO_SPEECH_GIVE_UP_MS - 1)).toBe("waiting");
    expect(watcher.update(0.005, 100 + NO_SPEECH_GIVE_UP_MS)).toBe("nothing");
  });

  it("takes its numbers from the options", () => {
    const watcher = new SilenceWatcher({ level: 0.5, silenceMs: 100, giveUpMs: 200 });
    expect(watcher.update(0.3, 0)).toBe("waiting");
    expect(watcher.update(0.3, 200)).toBe("nothing");
    const other = new SilenceWatcher({ level: 0.5, silenceMs: 100 });
    other.update(0.6, 0);
    expect(other.update(0.1, 100)).toBe("stop");
  });
});

describe("voiceFileName", () => {
  it("has the right ending for the browser's recording type", () => {
    expect(voiceFileName("audio/webm;codecs=opus")).toBe("question.webm");
    expect(voiceFileName("audio/mp4")).toBe("question.m4a");
  });
});

describe("speechText", () => {
  it("is the answer in plain words, without citation numbers or marks", () => {
    expect(speechText("The **deposit** is 1,900 euros [1] and it is returned within 30 days [2].")).toBe(
      "The deposit is 1,900 euros and it is returned within 30 days.",
    );
    expect(speechText("## Notice\n- 60 days [1]\n- in writing")).toContain("60 days");
    expect(speechText("A claim.【3】")).toBe("A claim.");
  });

  it("is empty for nothing", () => {
    expect(speechText("")).toBe("");
  });
});
