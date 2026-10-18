// A review session: the flashcards that are due, one at a time. A card that is known is done for now. A card that is missed
// goes to the back of the line and comes round again before the session ends, up to MAX_MISSES times, after which it is
// left for another day (the server already has it due again today, so it is not forgotten).

export const MAX_MISSES = 2;

export interface Reviewable {
  documentId: number;
  front: string;
}

export interface Session<T extends Reviewable> {
  // The cards still to be seen, the one being shown first.
  queue: T[];
  // How many times each card was missed in this session.
  misses: Record<string, number>;
  // Cards known the first time they were shown, and cards missed at least once.
  knewFirst: number;
  missed: number;
  // Cards finished (known, or given up on for today).
  finished: number;
  total: number;
}

const keyOf = (card: Reviewable) => `${card.documentId}:${card.front}`;

export function startSession<T extends Reviewable>(cards: readonly T[]): Session<T> {
  return { queue: [...cards], misses: {}, knewFirst: 0, missed: 0, finished: 0, total: cards.length };
}

export function currentCard<T extends Reviewable>(session: Session<T>): T | undefined {
  return session.queue[0];
}

export function isFinished<T extends Reviewable>(session: Session<T>): boolean {
  return session.queue.length === 0;
}

// The session after the person said whether they knew the card being shown.
export function answer<T extends Reviewable>(session: Session<T>, knew: boolean): Session<T> {
  const [card, ...rest] = session.queue;
  if (!card) return session;
  const key = keyOf(card);
  const missesBefore = session.misses[key] ?? 0;

  if (knew) {
    return { ...session, queue: rest, finished: session.finished + 1, knewFirst: session.knewFirst + (missesBefore === 0 ? 1 : 0) };
  }
  const misses = { ...session.misses, [key]: missesBefore + 1 };
  const firstMiss = missesBefore === 0;
  const missed = session.missed + (firstMiss ? 1 : 0);
  if (missesBefore + 1 > MAX_MISSES) {
    // Enough for today: it stays due, and is left for another day.
    return { ...session, queue: rest, misses, missed, finished: session.finished + 1 };
  }
  return { ...session, queue: [...rest, card], misses, missed };
}
