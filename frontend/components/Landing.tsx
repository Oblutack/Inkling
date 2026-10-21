"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useAuth } from "../contexts/AuthContext";
import { API_URL } from "../lib/api";
import type { MessageKey } from "../lib/i18n";
import { useT } from "./I18nProvider";
import LandingMotion from "./LandingMotion";
import { SkeletonLine } from "./Skeleton";

const EInkForm = dynamic(() => import("./EInkForm"), {
  ssr: false,
  loading: () => (
    <div className="space-y-4" aria-hidden="true">
      <SkeletonLine className="h-44 rounded-xl" />
      <SkeletonLine className="h-10" />
    </div>
  ),
});

// A few icons, drawn the same way: 24 units, a round 2-unit stroke.
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

// What it reads, as the names people know the files by (the same in every language).
const FILE_KINDS = [".pdf", ".docx", ".pptx", "https://", ".jpg", ".png", ".heic", ".mp3", ".wav", ".m4a", ".webm", "text"];

const FEATURES: {
  key: "inputs" | "cited" | "proof" | "compare" | "extract" | "library" | "listen" | "languages" | "share";
  icon: React.ReactNode;
}[] = [
  { key: "inputs", icon: <path d="M12 16V4m0 0L8 8m4-4l4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /> },
  { key: "cited", icon: <path d="M7 8h3v4H7zm7 0h3v4h-3zM7 12c0 3 1 4 3 4M14 12c0 3 1 4 3 4" /> },
  { key: "proof", icon: <path d="M20 6L9 17l-5-5" /> },
  {
    key: "compare",
    icon: (
      <>
        <rect x="3" y="4" width="7" height="16" rx="1" />
        <rect x="14" y="4" width="7" height="16" rx="1" />
      </>
    ),
  },
  {
    key: "extract",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="1" />
        <path d="M3 10h18M9 4v16" />
      </>
    ),
  },
  { key: "library", icon: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></> },
  { key: "listen", icon: <path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4zm13 0h3v6h-3z" /> },
  { key: "languages", icon: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></> },
  { key: "share", icon: <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" /> },
];

// A picture of the main idea: a summary whose sentences have been checked against the original, and an
// answer that names its source. It is an illustration, not live data, so it is hidden from screen readers.
function Preview() {
  const t = useT();
  return (
    <div className="card relative mx-auto w-full max-w-md overflow-hidden" aria-hidden="true">
      <div className="scan" style={{ "--scan-distance": "380px" } as React.CSSProperties} />
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold">{t("preview.title")}</p>
        <span className="chip pop pointer-events-none text-xs" style={{ animationDelay: "2.3s" }}>
          {t("preview.checked")}
        </span>
      </div>
      <ul className="mt-4 space-y-3">
        {(
          [
            ["s1", "found"],
            ["s2", "found"],
            ["s3", "notFound"],
          ] as const
        ).map(([sentence, state], i) => (
          <li key={sentence} className="flex gap-3">
            {/* The sentences are checked one at a time, as the product does it. */}
            <span
              className={`pop mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                state === "found" ? "bg-accent text-accent-fg" : "bg-danger text-danger-fg"
              }`}
              style={{ animationDelay: `${700 + i * 500}ms` }}
            >
              {/* The mark is drawn stroke by stroke just after the badge appears. */}
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                <path
                  d={state === "found" ? "M5 12.5l4.5 4.5L19 7.5" : "M6 6l12 12M18 6L6 18"}
                  pathLength={1}
                  className="draw"
                  style={{ animationDelay: `${950 + i * 500}ms` }}
                />
              </svg>
            </span>
            <span>
              <span className="reading block text-base">{t(`preview.${sentence}`)}</span>
              <span className={`rise-sm block text-sm font-medium ${state === "found" ? "text-ink/70" : "text-danger"}`} style={{ animationDelay: `${850 + i * 500}ms` }}>
                {t(state === "found" ? "preview.found" : "preview.notFound")}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-5 space-y-2 border-t border-ink/15 pt-4">
        <p className="rise-sm ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-ink/10 px-4 py-2 text-sm" style={{ animationDelay: "2.7s" }}>
          {t("preview.question")}
        </p>
        <p className="rise-sm reading w-fit max-w-[90%] rounded-2xl rounded-bl-sm border border-ink/20 px-4 py-2 text-base" style={{ animationDelay: "3.3s" }}>
          {t("preview.answer")}{" "}
          <span className="pop ml-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-ink/50 px-1 font-sans text-xs" style={{ animationDelay: "3.9s" }}>
            1
          </span>
        </p>
      </div>
    </div>
  );
}

export default function Landing() {
  const { user } = useAuth();
  const t = useT();

  const accountButton = user ? (
    <Link href="/dashboard" className="btn btn-secondary">
      {t("hero.toDashboard")}
    </Link>
  ) : (
    <Link href="/signup" className="btn btn-secondary">
      {t("hero.createAccount")}
    </Link>
  );

  return (
    <>
      <LandingMotion />
      <section className="relative isolate mx-auto grid max-w-6xl items-center gap-10 px-4 pb-10 pt-10 md:grid-cols-[1.15fr_1fr] md:pt-16">
        {/* The glows sit in a layer of their own that is clipped to the width of the page, so they never make it scroll sideways. */}
        <div className="pointer-events-none absolute inset-x-0 -inset-y-16 -z-10 overflow-hidden" aria-hidden="true">
          <div className="glow glow-a left-2 top-6 h-[24rem] w-[24rem] max-w-[90%]" />
          <div className="glow glow-b bottom-4 right-2 h-[22rem] w-[22rem] max-w-[85%]" />
        </div>
        <div>
          <h1 className="text-4xl leading-[1.08] sm:text-5xl lg:text-6xl">{t("hero.title")}</h1>
          <span className="ink-rule mt-5" aria-hidden="true" />
          <p className="reading mt-5 max-w-xl text-ink/80">{t("hero.subtitle")}</p>
          <div className="rise mt-7 flex flex-wrap gap-3" style={{ "--wait": "150ms" } as React.CSSProperties}>
            <a href="#try" className="btn btn-primary btn-glint text-lg">
              {t("hero.tryNow")}
            </a>
            {accountButton}
          </div>
          <p className="rise muted mt-3 text-sm" style={{ "--wait": "300ms" } as React.CSSProperties}>
            {t("hero.note")}
          </p>
        </div>
        <div className="float">
          <Preview />
        </div>
      </section>

      {/* The kinds of file it reads, passing by (decorative: the list is in the text above). */}
      <div className="marquee mx-auto mb-12 max-w-6xl" aria-hidden="true">
        <div className="marquee-track">
          {/* Four copies of the list (the strip moves by half of its length and starts again): enough that the strip never runs out on a wide screen. */}
          {[0, 1, 2, 3].map((copy) => (
            <ul key={copy} className="flex shrink-0 items-center gap-3 pr-3">
              {FILE_KINDS.map((kind) => (
                <li key={kind} className="rounded-full border border-ink/25 bg-surface/70 px-4 py-1.5 font-mono text-sm text-ink/80">
                  {kind}
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>

      <section id="try" className="mx-auto max-w-4xl scroll-mt-20 px-4 pb-16" aria-labelledby="try-heading">
        <h2 id="try-heading" className="text-3xl md:text-4xl">
          {t("tool.title")}
        </h2>
        <p className="muted mb-5 mt-1">{t("tool.subtitle")}</p>
        <div className="card md:p-8">
          <EInkForm endpoint={`${API_URL}/public/summarize`} />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16" aria-labelledby="features-heading">
        <h2 id="features-heading" className="reveal text-3xl md:text-4xl">
          {t("features.title")}
        </h2>
        <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ key, icon }, i) => (
            <li key={key} className="reveal lift card" style={{ "--i": i % 3 } as React.CSSProperties}>
              <span className="lift-icon flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent">
                <Icon>{icon}</Icon>
              </span>
              <h3 className="mt-4 text-lg font-semibold">{t(`features.${key}.title` as MessageKey)}</h3>
              <p className="muted mt-1">{t(`features.${key}.text` as MessageKey)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16" aria-labelledby="steps-heading">
        <h2 id="steps-heading" className="reveal text-3xl md:text-4xl">
          {t("steps.title")}
        </h2>
        <ol className="mt-6 grid gap-6 md:grid-cols-3">
          {(["one", "two", "three"] as const).map((step, i) => (
            <li key={step} className="reveal flex gap-4" style={{ "--i": i } as React.CSSProperties}>
              <span className="spring flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-ink text-base font-bold text-canvas">{i + 1}</span>
              <div>
                <h3 className="text-lg font-semibold">{t(`steps.${step}.title`)}</h3>
                <p className="muted mt-1">{t(`steps.${step}.text`)}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16" aria-labelledby="privacy-heading">
        <div className="reveal card flex flex-col gap-4 md:flex-row md:items-center md:gap-8 md:p-8">
          <span className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-accent/15 text-accent">
            <Icon>
              <path d="M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6z" pathLength={1} className="ink" />
              <path d="M9 12l2 2 4-4" pathLength={1} className="ink" />
            </Icon>
          </span>
          <div>
            <h2 id="privacy-heading" className="text-2xl md:text-3xl">
              {t("privacy.title")}
            </h2>
            <p className="muted mt-1 max-w-3xl">{t("privacy.text")}</p>
          </div>
        </div>
      </section>

      {!user && (
        <section className="mx-auto max-w-3xl px-4 text-center" aria-labelledby="cta-heading">
          <div className="reveal">
            <h2 id="cta-heading" className="text-3xl md:text-4xl">
              {t("cta.title")}
            </h2>
            <p className="muted mt-2">{t("cta.text")}</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link href="/signup" className="btn btn-primary btn-glint text-lg">
                {t("hero.createAccount")}
              </Link>
              <Link href="/login" className="btn btn-secondary">
                {t("nav.login")}
              </Link>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
