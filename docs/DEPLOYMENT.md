# Deployment guide

This walks through putting the app on the internet using free tiers: the **frontend on Vercel**, the **Go API and AI service on Render**, and **Postgres on Render** (or Neon). It also covers monitoring and a staging copy.

> `render.yaml` was written against Render's Blueprint format but has not been applied to a real Render account by the author of this repository. If Render rejects a field, its error message names it; the settings are all ordinary service settings you can also enter by hand in the dashboard.

## What runs where

```text
Browser ──► Vercel (Next.js)  ──►  Render: inkling-api (Go)  ──►  Render: inkling-ai (Python)  ──►  Groq
                                              │
                                              └──►  Postgres (Render or Neon)
```

| Part | Host | Why |
| --- | --- | --- |
| Frontend | Vercel (free) | Built for Next.js, global CDN |
| Go API | Render web service | Docker, health checks, free tier |
| AI service | Render web service | Same; protected by a shared secret because it is public on free plans |
| Database | Render Postgres or [Neon](https://neon.tech) | See "Database" below |

## Before you start

You need accounts and keys for:

1. **Groq**: an API key from [console.groq.com/keys](https://console.groq.com/keys).
2. **Google sign-in**: an OAuth client ID ([Google Cloud Console](https://console.cloud.google.com/apis/credentials)). Add your Vercel address as an authorized JavaScript origin once you know it.
3. **Render** and **Vercel**, both connected to your GitHub repository.

## 1. Backend on Render

1. In Render choose **New > Blueprint**, pick this repository, and apply `render.yaml`.
2. Render asks for the values marked `sync: false`. Enter at least `GROQ_API_KEY` and `GOOGLE_CLIENT_ID`. The rest can be filled in during the next steps.
3. When both services exist, open **inkling-ai** and copy two things:
   - its public address (`https://inkling-ai-xxxx.onrender.com`)
   - the generated `AI_SERVICE_TOKEN` value (Environment tab)
4. Open **inkling-api > Environment** and set:
   - `AI_SERVICE_URL` = the address from step 3
   - `AI_SERVICE_TOKEN` = the token from step 3 (it must be identical on both services)
5. Save. Render redeploys the API.

The shared secret is what keeps strangers from calling the AI service directly and spending your Groq quota. Without it the service refuses every request except the health check.

### Check it works

```bash
# Replace with your API address. Expect {"status":"ok"} then "ready".
curl https://inkling-api-xxxx.onrender.com/healthz
curl https://inkling-api-xxxx.onrender.com/readyz

# The AI service must refuse callers without the secret (expect 401):
curl -i -X POST https://inkling-ai-xxxx.onrender.com/summarize-text -H 'Content-Type: application/json' -d '{"text":"hello"}'
```

The first request after a quiet period can take 30 to 60 seconds: free services sleep when idle.

## 2. Frontend on Vercel

1. **Add New > Project**, import the repository, and set the **Root Directory** to `frontend`.
2. Environment variables:
   - `NEXT_PUBLIC_API_URL` = your Go API address
   - `NEXT_PUBLIC_GOOGLE_CLIENT_ID` = the Google client ID
   - `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (optional, if you use Turnstile)
3. Deploy, then go back to Render and set on **inkling-api**:
   - `CORS_ALLOWED_ORIGINS` = your Vercel address (for example `https://inkling.vercel.app`)
   - `FRONTEND_URL` = the same address (used for the links in emails)
4. Add the Vercel address to your Google OAuth client's authorized JavaScript origins.

`NEXT_PUBLIC_*` values are baked in when the site is built, so changing one means redeploying the frontend.

## 3. Cookies and domains

The login session is a cookie. With the frontend on `vercel.app` and the API on `onrender.com` the two are different sites, so the blueprint sets `COOKIE_SECURE=true` and `COOKIE_SAMESITE=none`. That works in Chrome and Edge, but **Safari and Firefox block third-party cookies by default**, so people on those browsers may be unable to stay logged in.

The robust fix is one domain for both: for example `app.example.com` (Vercel) and `api.example.com` (Render, via a custom domain). Then set `COOKIE_SAMESITE=lax` and `COOKIE_DOMAIN=.example.com`. Do this before inviting real users.

## 4. Client addresses and rate limits

Rate limits are per client address. Behind Render's proxy the API only sees the proxy's address unless it is told whom to trust. Set `TRUSTED_PROXIES` on **inkling-api** to the comma-separated address ranges of Render's proxy (see Render's documentation for current ranges). Until you do, the API logs a warning and ignores forwarded addresses altogether: nobody can fake their address, but every visitor looks like the proxy, so they all share the per-address limits (6 requests a minute and the anonymous daily allowance for the whole site, which real users will notice quickly). Set it before inviting anyone.

## Spending limits

The language model is paid for by use, so three layers keep the bill bounded. Set them up before inviting anyone:

1. **A hard cap at Groq.** In the [Groq console](https://console.groq.com) set a monthly spend limit and a usage alert. This is the real backstop: it works even if everything below is bypassed or buggy.
2. **The human check.** Create a Cloudflare Turnstile widget and set `TURNSTILE_SECRET` (API) and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (frontend). Without it, bots can sign up and use the anonymous routes freely. Also set `REQUIRE_EMAIL_VERIFICATION=true`.
3. **The limits in the API** (all counted per UTC day, `0` = unlimited): `ANON_SUMMARIES_PER_DAY` (default 10) for a visitor without an account, `QUOTA_SUMMARIES_PER_DAY` (50) and `QUOTA_CHAT_PER_DAY` (200) per signed-in user, and `AI_REQUESTS_PER_DAY` (default 5000) for the whole site: when that is used up, AI work pauses until midnight UTC and the logs say so (`daily AI budget used up`). At about a twentieth of a cent per ordinary summary, 5000 is a few dollars at most; lower it while you are starting out.

**Two-step sign-in (optional but recommended).** Set `TOTP_ENCRYPTION_KEY` to 32 random bytes in base64 (`openssl rand -base64 32`) and people can switch on an authenticator app on their account page: after the password, a six-digit code is asked for too. The secrets of the apps are stored encrypted with this key, which is not in the database, so a copy of the database does not give out working codes. Treat it like the database password: keep it in the host's secret store, back it up separately, and do not change it afterwards (the codes of everyone with two-step on would stop working; their recovery codes would still work, and the rows could be reset in the database). Without the key the option is simply not shown.

A visitor is told apart by network address, so **`TRUSTED_PROXIES` (section 4) matters for these limits too**: without it every visitor shares one address behind Render's proxy, and the anonymous allowance is shared by the whole site.

## 5. Email

Verification and password-reset emails need a provider. Out of the box (`MAIL_PROVIDER=log`) they are only written to the logs. Create a [Brevo](https://www.brevo.com) or [Resend](https://resend.com) account, then set `MAIL_PROVIDER`, `MAIL_FROM` and the matching API key on **inkling-api**. Set `REQUIRE_EMAIL_VERIFICATION=true` once mail works if you want confirmed addresses only.

## Database

- **Use a limited account for the API.** Run `docs/least-privilege.sql` once as the database owner, then set `DSN` to the new `inkling_app` account and `MIGRATE_DSN` to the owner's connection string (used only to apply migrations at start-up). If the API were ever broken into, it could then read and write rows but not drop tables or change the schema.
- **Back it up, and try the restore.** The app makes no backups: see [BACKUPS.md](BACKUPS.md).
- **Encrypt the connection** (`sslmode=require` or `verify-full`) to any database that is not on the same machine.

- **Render free Postgres** is deleted after 30 days. Fine for a trial, not for anything you want to keep.
- **Neon** has a free tier without that expiry. Create a project, copy its connection string (it contains `sslmode=require`) and set it as `DSN` on **inkling-api**, replacing the one from the Blueprint.
- Database migrations run automatically when the API starts, so there is nothing to apply by hand.
- **Original PDFs are stored in the database** (for the document viewer), up to `STORED_FILES_MB_PER_USER` per user (the Blueprint sets 20 MB). On a small free database this is what fills it first; lower the value, or set it to `0` to keep no originals (summaries and chat still work).

- **Search by meaning is off on the free Render plan.** The embedding model needs about 300 MB of memory and a free instance has 512 MB, so the Blueprint sets `EMBEDDINGS=off` on **inkling-ai**: questions across your library are then matched by keyword only. On an instance with 1 GB or more, set `EMBEDDINGS=on` (nothing else changes; documents already saved are embedded gradually as questions are asked).

Back up whatever you choose. The app has a "download my data" export for individual users, but that is not a backup.

## Monitoring

| What | How |
| --- | --- |
| **Is it up?** | A free uptime monitor such as [UptimeRobot](https://uptimerobot.com) or Better Stack pinging `https://<api>/healthz` every 5 minutes. Use `/readyz` instead if you also want to know the database and AI service are reachable. Note that pinging also keeps a free service awake, and two always-on free services use more than Render's monthly free hours. |
| **What went wrong?** | Create a Sentry project (free tier) and set `SENTRY_DSN` on both services. Only errors and stack traces are sent. Request bodies, cookies, headers and document text never are. |
| **How is it doing?** | Set `METRICS_TOKEN` on both services to switch on `/metrics` (Prometheus format, bearer token required). Point a Prometheus or Grafana Cloud agent at them. Locally, `docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d` gives a ready dashboard (see the README). |
| **Scheduled work** | The API runs a few jobs on a timer (today the daily flashcard reminder; page checks and the weekly digest are planned). They run inside the API process, once a minute it looks for what is due, and what ran when is kept in the database (`job_runs`). So the API must stay on: on a free host that sleeps (Render's free web service) they are skipped until the next request wakes it. On an always-on server (the Oracle VM) there is nothing to do; `JOBS_ENABLED=false` turns them off. Emails need a real mail provider (`MAIL_PROVIDER`); with `log` they only appear in the log. |
| **Is it busy, or broken?** | Set `ALERT_EMAIL` (and a mail provider) on the API. You get one email when many people use the site at once (`ALERT_ACTIVE_USERS`, 10 by default, and a higher level, 25), when the day's AI budget is used up, and when the AI service keeps failing. The same alert is never repeated within an hour (the budget one, within half a day), and an email holds only a number and a time. Without `ALERT_EMAIL` the alerts are only in the log. The number is also the `active_users` metric. |
| **Logs** | JSON, one line per request, with a request ID that is the same in both services. Search for it in Render's log viewer. |

### What to watch

- **Server error rate (5xx)** above a percent or two.
- **Model circuit breaker open**: the model provider is failing; users get a clear "busy" message.
- **Model calls by outcome**: a growing share of anything other than `ok`.
- **Quota rejections** and **Estimated spend**: your Groq usage. Set the prices on the dashboard to your provider's current rates.
- **`login_failed` spikes** on the account events panel: possible password guessing.

## Staging

To test changes before production, create a second copy:

1. Copy `render.yaml` to `render.staging.yaml` and change every name (`inkling-api` becomes `inkling-api-staging`, and so on).
2. In Render choose **New > Blueprint**, pick the same repository, set the file path to `render.staging.yaml` and the branch to `staging`.
3. Create a second Vercel project (or use Vercel's preview deployments) with `NEXT_PUBLIC_API_URL` pointing at the staging API, and set the staging API's `CORS_ALLOWED_ORIGINS` to match.
4. Use a different `SENTRY_ENVIRONMENT` (for example `staging`) and a separate database.

## Releases and rollback

CI must be green before merging to `main` (see `.github/workflows/ci.yml`). Render and Vercel redeploy on each push to the branch they watch. To roll back, use **Rollback** on the service's Deploys page in Render, or redeploy a previous deployment in Vercel. Database migrations only move forward, so a rollback after a schema change needs a matching down-migration; keep schema changes backward compatible for one release.

## Free-tier limits worth knowing

- Render free web services sleep after 15 minutes idle, and each workspace gets a fixed number of free instance-hours per month.
- Groq's free tier has per-minute and per-day limits; when reached, users see the "busy" message and the circuit breaker may open.
- The in-memory summary cache and rate limiters reset whenever a service restarts or sleeps, and are per instance. That is fine for one instance, but running several means limits are applied per instance.
