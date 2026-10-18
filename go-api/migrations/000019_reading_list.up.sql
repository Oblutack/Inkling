-- The reading list: things a person saved to read later. Each is a document (with a short summary made when it was saved)
-- plus these dates. url is the page it came from ('' for pasted text). A page can be on a person's list once.
-- read_at and archived_at are NULL until then, so "unread" is neither set and "archived" is the second one.
CREATE TABLE IF NOT EXISTS reading_items (
    document_id BIGINT      PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    url         TEXT        NOT NULL DEFAULT '',
    saved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at     TIMESTAMPTZ,
    archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reading_items_user ON reading_items (user_id, saved_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reading_items_url ON reading_items (user_id, url) WHERE url <> '';
