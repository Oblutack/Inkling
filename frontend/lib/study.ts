import type { StudyCard } from "../types";
import { csvFileName, toCsv } from "./extraction";

// A copy of a list in random order (Fisher-Yates). `random` can be replaced to make the order predictable.
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// The flashcards as a file for a flashcard app (Anki and others read a front and a back per line) or a spreadsheet:
// two columns and no header line, with a byte order mark so accents survive. A card that starts with = + - or @ is
// written so that a spreadsheet does not run it as a formula.
export function cardsCsv(cards: readonly StudyCard[]): string {
  return "﻿" + toCsv(cards.map((card) => [card.front, card.back]));
}

// The name of the downloaded file, from the document's title.
export function cardsFileName(title: string): string {
  const name = csvFileName(title);
  return name === "extraction.csv" ? "flashcards.csv" : name.replace(/\.csv$/, "-flashcards.csv");
}
