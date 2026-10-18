-- The dates and deadlines found in a document (a JSON list, NULL until looked for), kept so the model is asked once.
-- They come from the document's text, not from its summary, so rewriting the summary leaves them alone.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS dates JSONB;
