-- Exam mode: the result of each exam a person took, kept so they can see how a collection is going over time.
-- tag is the collection the exam was drawn from ('' when the sets were picked one by one). document_ids are the sets
-- the questions came from, breakdown is how each did ({documentId, title, questions, correct}), and missed holds the
-- questions that were answered wrongly or not at all ({documentId, question}), so "what do I keep getting wrong" can be
-- answered later. The questions themselves live in the sets (documents.study), not here.
CREATE TABLE IF NOT EXISTS exam_results (
    id           BIGSERIAL   PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    tag          TEXT        NOT NULL DEFAULT '',
    document_ids JSONB       NOT NULL DEFAULT '[]'::jsonb,
    questions    INT         NOT NULL,
    correct      INT         NOT NULL,
    seconds      INT         NOT NULL,
    finished_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    breakdown    JSONB       NOT NULL DEFAULT '[]'::jsonb,
    missed       JSONB       NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_exam_results_user ON exam_results (user_id, finished_at DESC);
