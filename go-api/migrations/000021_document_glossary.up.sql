-- The glossary of a document: specialist terms with a plain explanation and the pages they are on (a JSON object), kept so
-- the model is asked once. It comes from the document's text, so rewriting the summary leaves it alone.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS glossary JSONB;
