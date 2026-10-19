-- Highlights and notes: a passage a person marked in the original PDF of one of their documents, with the note they wrote about
-- it (which may be empty). The passage is kept as the words that were selected and the page they were on; where they sit on the
-- page is found again when the page is drawn. file_id is the stored original it was marked in.
CREATE TABLE IF NOT EXISTS document_highlights (
    id          BIGSERIAL   PRIMARY KEY,
    document_id BIGINT      NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    file_id     BIGINT,
    page        INT         NOT NULL,
    quote       TEXT        NOT NULL,
    note        TEXT        NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_document_highlights_document ON document_highlights (document_id, page, id);
CREATE INDEX IF NOT EXISTS idx_document_highlights_user ON document_highlights (user_id);
