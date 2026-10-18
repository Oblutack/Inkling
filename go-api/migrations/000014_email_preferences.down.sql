DROP TABLE IF EXISTS notice_log;
DROP TABLE IF EXISTS job_runs;
DROP INDEX IF EXISTS idx_users_unsubscribe_token;
ALTER TABLE users
    DROP COLUMN IF EXISTS unsubscribe_token,
    DROP COLUMN IF EXISTS time_zone,
    DROP COLUMN IF EXISTS email_prefs;
