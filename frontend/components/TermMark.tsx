"use client";
import { useId } from "react";
import { termIndexOf, type GlossaryTerm } from "../lib/glossary";

interface TermMarkProps {
  href?: string;
  children?: React.ReactNode;
  terms: readonly GlossaryTerm[];
}

// A term in a summary: underlined with dots, and its explanation shows when it is pointed at or reached with the keyboard.
// (It stands in for a link in the Markdown: the link's address is only the number of the term.)
export default function TermMark({ href, children, terms }: TermMarkProps) {
  const id = useId();
  const index = termIndexOf(href);
  const entry = index === null ? undefined : terms[index];
  if (!entry) return <a href={href}>{children}</a>;
  return (
    <span className="group relative inline-block" data-testid="term-mark">
      <button
        type="button"
        aria-describedby={id}
        className="cursor-help font-[inherit] underline decoration-dotted decoration-2 underline-offset-4"
      >
        {children}
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-64 max-w-[80vw] rounded-lg border border-ink/30 bg-surface p-2 font-sans text-sm font-normal not-italic leading-snug shadow-lg group-focus-within:block group-hover:block"
      >
        {entry.explanation}
      </span>
    </span>
  );
}
