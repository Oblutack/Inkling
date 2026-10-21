-- Exam mode: the whole exam is kept, so a past exam can be opened and looked through again, and what was got wrong practised later.
-- detail holds the questions in the order they were asked ({documentId, documentTitle, question, options, answer, explanation,
-- chosen}), where answer is the index of the right option and chosen the index picked (null when the question was left alone).
-- Exams taken before this column existed have no detail (NULL): they keep their score, their breakdown and the text of the
-- questions that were missed, as before.
ALTER TABLE exam_results ADD COLUMN IF NOT EXISTS detail JSONB;
