-- A summary translated line by line into another language, with the key words and their translations: a JSON object with one
-- result for each language, kept so the model is asked once for each. It is made from the summary, so a new summary (a rewrite)
-- takes it away.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS bilingual JSONB;
