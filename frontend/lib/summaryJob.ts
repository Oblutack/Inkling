import { API_URL } from "./api";

export type Stage = "idle" | "preparing" | "summarizing" | "writing";

export interface JobState {
  isLoading: boolean;
  stage: Stage;
  // The sections done in the round that is running (a long document goes through the model in rounds).
  chunks: { done: number; total: number };
  summary: string;
  error: string;
  // When it began, so the bar can keep creeping while the server has not said anything yet.
  startedAt: number;
  // The furthest the bar has been. A new round of sections must not make it go back.
  peak: number;
  // Finished while nobody was looking at the form (the person had gone to another page).
  unseen: boolean;
}

export const IDLE: JobState = {
  isLoading: false,
  stage: "idle",
  chunks: { done: 0, total: 0 },
  summary: "",
  error: "",
  startedAt: 0,
  peak: 0,
  unseen: false,
};

// A summary that is being made, kept outside the page that asked for it. The request goes on when the person moves to another
// page, and the page shows where it has got to when they come back (and the top bar shows it meanwhile).
export class SummaryJob {
  private state: JobState = IDLE;
  private readonly listeners = new Set<() => void>();
  // How many forms are showing this job right now, and what the one on screen wants done when a summary is saved.
  private shown = 0;
  private created: (() => void) | undefined;
  controller: AbortController | null = null;

  getSnapshot = (): JobState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  update(patch: Partial<JobState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  start(): void {
    this.update({ ...IDLE, isLoading: true, stage: "preparing", startedAt: Date.now() });
  }

  appendSummary(text: string): void {
    this.update({ summary: this.state.summary + text });
  }

  // The bar only ever moves forward while the job runs.
  advance(value: number): number {
    if (value > this.state.peak) this.state = { ...this.state, peak: value };
    return this.state.peak;
  }

  // A form has come on screen: whatever an earlier visit left (a finished summary, an old message) is cleared; a job still running is kept.
  show(onCreated: (() => void) | undefined): void {
    this.shown += 1;
    this.created = onCreated;
    const { isLoading, summary, error, stage, unseen } = this.state;
    if (!isLoading && (summary || error || unseen || stage !== "idle")) this.update({ ...IDLE });
  }

  setOnCreated(onCreated: (() => void) | undefined): void {
    this.created = onCreated;
  }

  hide(): void {
    this.shown = Math.max(0, this.shown - 1);
    if (this.shown === 0) this.created = undefined;
  }

  finish(saved: boolean): void {
    this.controller = null;
    if (saved && this.shown > 0) this.created?.();
    this.update({ isLoading: false, stage: "idle", unseen: saved && this.shown === 0 });
  }

  cancel(): void {
    this.controller?.abort();
  }
}

const jobs = new Map<string, SummaryJob>();

export function jobFor(endpoint: string): SummaryJob {
  let job = jobs.get(endpoint);
  if (!job) {
    job = new SummaryJob();
    jobs.set(endpoint, job);
  }
  return job;
}

// The summary a signed-in person makes on the dashboard: the one the top bar reports on.
export function dashboardJob(): SummaryJob {
  return jobFor(`${API_URL}/summarize`);
}

// How far the bar creeps on its own before the server reports anything: it eases toward the cap, a little less each time.
export const WAITING_PROGRESS_CAP = 35;
export const WAITING_STEP_MS = 800;

export function waitingProgress(startedAt: number, now: number): number {
  const steps = Math.max(0, now - startedAt) / WAITING_STEP_MS;
  return WAITING_PROGRESS_CAP * (1 - Math.pow(7 / 8, steps));
}
