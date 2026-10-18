-- Emails a person chose to receive (study reminders, page alerts, a weekly digest), and the background jobs that send them.
--
-- email_prefs holds only what the person decided: {"watch": true, "reminders": false, "digest": false}. A missing key means
-- the default (alerts for a page the person asked to watch are on; reminders and the digest are off until chosen).
-- time_zone is an IANA name such as "Europe/Sarajevo", sent by the browser, so "8 in the morning" means the person's morning.
-- unsubscribe_token is a long random value in the link at the bottom of every such email: it can only switch emails off, so
-- it needs no login. It is made the first time it is needed.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_prefs       JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS time_zone         TEXT  NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT  NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_users_unsubscribe_token ON users (unsubscribe_token) WHERE unsubscribe_token <> '';

-- When each background job last ran and when it is next due. Surviving a restart is the point: the job is not repeated
-- because the server was restarted, and not skipped either.
CREATE TABLE IF NOT EXISTS job_runs (
    name        TEXT PRIMARY KEY,
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ NOT NULL
);

-- One row per email of a kind sent to a person for a day, so a job that runs more than once a day sends it once.
CREATE TABLE IF NOT EXISTS notice_log (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind    TEXT   NOT NULL,
    day     DATE   NOT NULL,
    PRIMARY KEY (user_id, kind, day)
);
