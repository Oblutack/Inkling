-- Two-step sign-in with an authenticator app (TOTP, RFC 6238).
--
-- totp_secret is the shared secret, ENCRYPTED with a key kept outside the database (TOTP_ENCRYPTION_KEY), so a leaked
-- copy of the database does not give out working codes. It is set when the person starts setting up, and two-step
-- sign-in only counts once totp_enabled_at is set (after they have proved the app shows the right codes).
-- totp_last_step is the last 30-second step that was accepted: a code is good once, so one seen over a shoulder or on
-- the wire cannot be used again.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS totp_secret     TEXT,
    ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS totp_last_step  BIGINT NOT NULL DEFAULT 0;

-- Codes for when the phone is lost: only their SHA-256 hash is kept, and each works once.
CREATE TABLE IF NOT EXISTS recovery_codes (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash  TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_at    TIMESTAMPTZ,
    UNIQUE (user_id, code_hash)
);

-- What a correct password earns when two-step sign-in is on: not a session, but one short, single-use chance (a few
-- attempts, a few minutes) to give the second factor. Only the hash of the token is kept.
CREATE TABLE IF NOT EXISTS mfa_challenges (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash TEXT        NOT NULL UNIQUE,
    attempts   INT         NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user_id ON mfa_challenges (user_id);
