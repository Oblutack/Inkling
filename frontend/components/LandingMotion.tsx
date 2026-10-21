"use client";
import { useEffect } from "react";

// The motion of the front page that needs a script, started once the page has been drawn (the styles are in globals.css):
//
// 1. The class "motion-ready" on the page, which switches on the decorations that only need to run, not to be there at the first
//    drawing (the light across the main button, the line reading down the picture, the floating of the picture).
// 2. Parts marked with the class "reveal" that ease in whenever they are scrolled into view, and go back to waiting when they are
//    scrolled out of it, so they play again as the page is scrolled up and down.
//
// Nothing is held back from anyone: the server sends every part fully visible, so without this script, and for people who ask for
// less motion, the page is simply complete from the start.
export default function LandingMotion() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Not while the page is still being drawn for the first time, but when the browser has a moment to spare (Safari has no idle
    // callback, so a short wait stands in).
    let undo: (() => void) | undefined;
    const start = () => {
      document.documentElement.classList.add("motion-ready");
      undo = watchParts();
    };
    const hasIdle = typeof window.requestIdleCallback === "function";
    const handle = hasIdle ? window.requestIdleCallback(start, { timeout: 1500 }) : window.setTimeout(start, 300);
    return () => {
      if (hasIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
      document.documentElement.classList.remove("motion-ready");
      undo?.();
    };
  }, []);
  return null;
}

// Starts watching the parts that are revealed on scroll, and returns what undoes it.
function watchParts(): () => void {
  if (typeof IntersectionObserver === "undefined") return () => undefined;
  const parts = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
  // What is on the screen when the page opens just stays as it is (it already counts as revealed, so no change is seen);
  // what is below it waits to be scrolled to.
  for (const part of parts) {
    part.classList.add("reveal-hidden");
    if (part.getBoundingClientRect().top <= window.innerHeight * 0.92) part.classList.add("reveal-in");
  }
  const watcher = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) entry.target.classList.toggle("reveal-in", entry.isIntersecting);
    },
    // A little before the bottom edge, so a part is on its way in rather than arriving at the very edge.
    { rootMargin: "0px 0px -8% 0px" },
  );
  parts.forEach((part) => watcher.observe(part));
  return () => {
    watcher.disconnect();
    // Left as the server sent it.
    parts.forEach((part) => part.classList.remove("reveal-hidden", "reveal-in"));
  };
}
