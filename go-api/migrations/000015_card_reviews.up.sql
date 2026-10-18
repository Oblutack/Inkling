-- Spaced repetition: how well a person knows each flashcard, and when it is due again.
--
-- A card has no id of its own (the cards of a set live in documents.study and "write new ones" replaces them), so it is
-- known by card_key: the start of the SHA-256 of its front text. When the cards are replaced, the rows of cards that are no
-- longer there are removed (and any left behind are dropped the next time they are looked up).
-- box 1..6 is how well it is known; due_on is the person's own calendar day (their time zone).
CREATE TABLE IF NOT EXISTS card_reviews (
    user_id          BIGINT   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    document_id      BIGINT   NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    card_key         TEXT     NOT NULL,
    box              SMALLINT NOT NULL,
    due_on           DATE     NOT NULL,
    reviews          INT      NOT NULL DEFAULT 0,
    lapses           INT      NOT NULL DEFAULT 0,
    last_reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, card_key)
);
CREATE INDEX IF NOT EXISTS idx_card_reviews_due ON card_reviews (user_id, due_on);

-- How many cards were reviewed on each day, for the streak ("5 days in a row").
CREATE TABLE IF NOT EXISTS review_days (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    day     DATE   NOT NULL,
    count   INT    NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
