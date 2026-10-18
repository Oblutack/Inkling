-- Contract checklists made for a document (a JSON object with one result for each kind of checklist: lease, job_offer,
-- freelance, nda, purchase), kept so the model is asked once for each and showing them again is free.
-- They come from the document's text, so rewriting the summary leaves them alone.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS checks JSONB;
