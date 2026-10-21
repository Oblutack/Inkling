"use client";
import { useEffect } from "react";

// Says "motion-ready" on the page once it has been drawn and the browser has a moment to spare (not for people who ask for less
// motion). The decorations that only need to run, not to be there at the first drawing, start from that (see globals.css): the page
// itself is on the screen first, which is what people are waiting for.
export default function MotionReady() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    const start = () => root.classList.add("motion-ready");
    // Safari has no idle callback, so a short wait stands in.
    const hasIdle = typeof window.requestIdleCallback === "function";
    const handle = hasIdle ? window.requestIdleCallback(start, { timeout: 1500 }) : window.setTimeout(start, 300);
    return () => {
      if (hasIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, []);
  return null;
}
