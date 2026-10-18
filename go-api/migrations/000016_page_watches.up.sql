-- Pages a person watches: Inkling opens them now and then, and says what changed when something that matters did.
--
-- last_text is the text of the page the last time it was read (kept to compare the next version against); last_hash is the
-- hash of that text with the parts that change every visit (a clock, "5 minutes ago") taken out, so a page that only ticks
-- is not a change. next_check_at is when it is due, paused watches are never due, and after several failures in a row the
-- watch is paused by itself (failures, last_error say why).
CREATE TABLE IF NOT EXISTS page_watches (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    url             TEXT        NOT NULL,
    title           TEXT        NOT NULL DEFAULT '',
    last_text       TEXT        NOT NULL DEFAULT '',
    last_hash       TEXT        NOT NULL DEFAULT '',
    every_hours     INT         NOT NULL DEFAULT 24,
    next_check_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at TIMESTAMPTZ,
    last_changed_at TIMESTAMPTZ,
    failures        INT         NOT NULL DEFAULT 0,
    last_error      TEXT        NOT NULL DEFAULT '',
    paused          BOOLEAN     NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, url)
);
CREATE INDEX IF NOT EXISTS idx_page_watches_due ON page_watches (next_check_at) WHERE NOT paused;

-- What changed each time something did: the comparison (a program found the changes, the model explained them), kept so the
-- history can be read later. The newest 20 per watch are kept.
CREATE TABLE IF NOT EXISTS watch_changes (
    id             BIGSERIAL PRIMARY KEY,
    watch_id       BIGINT      NOT NULL REFERENCES page_watches (id) ON DELETE CASCADE,
    found_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    title          TEXT        NOT NULL DEFAULT '',
    comparison     JSONB       NOT NULL,
    bottom_line    TEXT        NOT NULL DEFAULT '',
    top_importance TEXT        NOT NULL DEFAULT '',
    counts         JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_watch_changes_watch ON watch_changes (watch_id, found_at DESC);
