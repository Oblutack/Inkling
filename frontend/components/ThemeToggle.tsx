"use client";
import { useEffect, useState } from "react";
import { applyTheme, currentTheme, saveTheme, type Theme } from "../lib/theme";
import { useT } from "./I18nProvider";

type WithTransitions = Document & { startViewTransition?: (update: () => void) => { ready: Promise<void> } };

// Switches between the light and the dark page. It shows the theme a click leads to. Where the browser can do it, the new colours spread
// out from the button like ink soaking into paper; elsewhere, and for people who ask for less motion, the page just changes.
export default function ThemeToggle() {
  // Unknown until the browser has been asked (the server cannot know), so nothing is shown before then.
  const [theme, setTheme] = useState<Theme | null>(null);
  const t = useT();

  useEffect(() => setTheme(currentTheme()), []);

  if (!theme) return <span className="h-11 w-11" aria-hidden="true" />;
  const next: Theme = theme === "dark" ? "light" : "dark";
  const label = t(next === "dark" ? "theme.switchToDark" : "theme.switchToLight");

  return (
    <button
      type="button"
      onClick={(event) => {
        const change = () => {
          applyTheme(next);
          saveTheme(next);
          setTheme(next);
        };
        const doc = document as WithTransitions;
        if (!doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          change();
          return;
        }
        const box = event.currentTarget.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        doc
          .startViewTransition(change)
          .ready.then(() =>
            document.documentElement.animate(
              { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
              { duration: 600, easing: "cubic-bezier(0.22, 1, 0.36, 1)", pseudoElement: "::view-transition-new(root)" },
            ),
          )
          .catch(() => undefined);
      }}
      className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-ink/10"
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {next === "dark" ? (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        )}
      </svg>
    </button>
  );
}
