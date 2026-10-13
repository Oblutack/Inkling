// Package alerts tells the owner when something needs a look: many people using the site at once, the day's AI budget
// used up, or the AI service failing. It sends an email (to ALERT_EMAIL, through the same provider as the other mail)
// and always writes the alert to the log, so a deployment without a mail provider still sees it.
//
// An alert is never repeated before its cooldown has passed, so a busy afternoon is one email and not a hundred. An
// email holds a number and a time and nothing about any person.
//
// "People using the site" is the number of different visitors who made a request in the last few minutes: a signed-in
// person counts once, however many tabs or devices, and a visitor without an account is told apart by a keyed hash of
// their address (the same one the daily allowance uses), never the address itself. Requests for health checks, metrics
// and routes that do not exist are not counted, so a monitor or a scanner does not look like a crowd.
package alerts

import (
	"context"
	"fmt"
	"html"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ai-summarizer/go-api/mailer"
	"ai-summarizer/go-api/metrics"

	"github.com/prometheus/client_golang/prometheus"
)

// Defaults, used when the matching variable is not set.
const (
	DefaultActiveUsers     = 10
	DefaultActiveUsersHigh = 25
	DefaultWindow          = 5 * time.Minute
	DefaultCooldown        = time.Hour
)

// What counts as the AI service failing: at least aiMinFailures failed calls, and at least half of the calls in the
// last aiWindow failed. Errors that are the caller's fault (a file that cannot be read) are not counted.
const (
	aiWindow      = 10 * time.Minute
	aiMinFailures = 5
	// budgetCooldown: the budget stays used up until midnight, so one email a half day is enough.
	budgetCooldown = 12 * time.Hour
	// maxTracked bounds the memory a flood of different visitors can use. Past it the count is already far beyond any
	// threshold, so new visitors are simply not added.
	maxTracked = 50000
)

// Config is read from the environment by ConfigFromEnv.
type Config struct {
	// Email receives the alerts. Empty means they are only logged.
	Email string
	// ActiveUsers and ActiveUsersHigh are the two levels of "many people at once". 0 turns a level off.
	ActiveUsers, ActiveUsersHigh int
	// Window is how recent a request must be for its visitor to count as using the site now.
	Window time.Duration
	// Cooldown is the least time between two alerts of the same kind.
	Cooldown time.Duration
}

// ConfigFromEnv reads ALERT_EMAIL, ALERT_ACTIVE_USERS, ALERT_ACTIVE_USERS_HIGH, ALERT_WINDOW_MINUTES and
// ALERT_COOLDOWN_MINUTES. A value that is not a whole number is ignored (the default is used), and the high level is
// raised to the first one if it was set lower.
func ConfigFromEnv() Config {
	cfg := Config{
		Email:           strings.TrimSpace(os.Getenv("ALERT_EMAIL")),
		ActiveUsers:     intFromEnv("ALERT_ACTIVE_USERS", DefaultActiveUsers, 0),
		ActiveUsersHigh: intFromEnv("ALERT_ACTIVE_USERS_HIGH", DefaultActiveUsersHigh, 0),
		Window:          time.Duration(intFromEnv("ALERT_WINDOW_MINUTES", int(DefaultWindow/time.Minute), 1)) * time.Minute,
		Cooldown:        time.Duration(intFromEnv("ALERT_COOLDOWN_MINUTES", int(DefaultCooldown/time.Minute), 1)) * time.Minute,
	}
	if cfg.ActiveUsers > 0 && cfg.ActiveUsersHigh > 0 && cfg.ActiveUsersHigh <= cfg.ActiveUsers {
		cfg.ActiveUsersHigh = cfg.ActiveUsers + 1
	}
	return cfg
}

func intFromEnv(name string, fallback, least int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && v >= least {
		return v
	}
	return fallback
}

type aiResult struct {
	at     time.Time
	failed bool
}

// Alerter counts activity and sends the alerts. The zero value does nothing until Start (or setup in a test) turns it
// on, so the code that reports into it needs no checks.
type Alerter struct {
	enabled atomic.Bool

	mu   sync.Mutex
	cfg  Config
	mail mailer.Mailer
	now  func() time.Time
	seen map[string]time.Time // visitor -> time of their last request
	sent map[string]time.Time // alert kind -> time it was last sent
	ai   []aiResult
}

// Default is what the server reports into; Start turns it on.
var Default = &Alerter{}

// New makes an Alerter that is on. A nil now means the real clock.
func New(cfg Config, mail mailer.Mailer, now func() time.Time) *Alerter {
	a := &Alerter{}
	a.Reset(cfg, mail, now)
	return a
}

// Reset turns the Alerter on with this setup and forgets everything it had seen or sent. A nil now means the real clock.
func (a *Alerter) Reset(cfg Config, mail mailer.Mailer, now func() time.Time) {
	if now == nil {
		now = time.Now
	}
	if cfg.Window <= 0 {
		cfg.Window = DefaultWindow
	}
	if cfg.Cooldown <= 0 {
		cfg.Cooldown = DefaultCooldown
	}
	a.mu.Lock()
	a.cfg, a.mail, a.now = cfg, mail, now
	a.seen = map[string]time.Time{}
	a.sent = map[string]time.Time{}
	a.ai = nil
	a.mu.Unlock()
	a.enabled.Store(true)
}

var publishOnce sync.Once

// Start turns the shared Default on and checks the number of people once a minute until ctx ends. The number is also
// published as the metric active_users, for a graph in Grafana.
func Start(ctx context.Context, cfg Config, mail mailer.Mailer) {
	Default.Reset(cfg, mail, nil)
	publishOnce.Do(func() {
		metrics.Registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "active_users",
			Help: "Different visitors who made a request recently (the alert window, 5 minutes by default).",
		}, func() float64 { return float64(Default.Active()) }))
	})
	if cfg.Email == "" {
		slog.Info("ALERT_EMAIL is not set: alerts are only written to the log")
	}
	go Default.Run(ctx, time.Minute)
}

// Disable turns the Alerter off again: it then ignores everything reported to it.
func (a *Alerter) Disable() { a.enabled.Store(false) }

// Run checks the number of people on every tick until ctx ends.
func (a *Alerter) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.Check()
		}
	}
}

// Touch notes that a visitor made a request just now. id must already be safe to keep (a user number or a keyed hash).
func (a *Alerter) Touch(id string) {
	if !a.enabled.Load() {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, known := a.seen[id]; !known && len(a.seen) >= maxTracked {
		return
	}
	a.seen[id] = a.now()
}

// Active is the number of different visitors who made a request within the window.
func (a *Alerter) Active() int {
	if !a.enabled.Load() {
		return 0
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.activeLocked()
}

func (a *Alerter) activeLocked() int {
	cutoff := a.now().Add(-a.cfg.Window)
	n := 0
	for id, at := range a.seen {
		if at.Before(cutoff) {
			delete(a.seen, id) // forgotten once it can no longer count
			continue
		}
		n++
	}
	return n
}

// Check compares the number of people with the two levels and sends the alert for the higher level reached. When the
// high level fires, the lower one is held back too, so one rush is one email.
func (a *Alerter) Check() {
	if !a.enabled.Load() {
		return
	}
	a.mu.Lock()
	n := a.activeLocked()
	cfg := a.cfg
	a.mu.Unlock()

	window := int(cfg.Window / time.Minute)
	switch {
	case cfg.ActiveUsersHigh > 0 && n >= cfg.ActiveUsersHigh:
		if a.Notify("active-users-high", fmt.Sprintf("%d people are using Inkling right now", n),
			fmt.Sprintf("%d different people made a request in the last %d minutes, above your high level of %d. If this keeps happening, the single server may need more room.", n, window, cfg.ActiveUsersHigh),
			cfg.Cooldown) {
			a.hold("active-users")
		}
	case cfg.ActiveUsers > 0 && n >= cfg.ActiveUsers:
		a.Notify("active-users", fmt.Sprintf("%d people are using Inkling right now", n),
			fmt.Sprintf("%d different people made a request in the last %d minutes, at or above your level of %d.", n, window, cfg.ActiveUsers),
			cfg.Cooldown)
	}
}

// hold starts the cooldown of an alert kind without sending it.
func (a *Alerter) hold(kind string) {
	a.mu.Lock()
	a.sent[kind] = a.now()
	a.mu.Unlock()
}

// Notify logs the alert and emails it, unless the same kind was sent less than cooldown ago. It reports whether it went.
func (a *Alerter) Notify(kind, subject, text string, cooldown time.Duration) bool {
	if !a.enabled.Load() {
		return false
	}
	a.mu.Lock()
	now := a.now()
	if last, ok := a.sent[kind]; ok && now.Sub(last) < cooldown {
		a.mu.Unlock()
		return false
	}
	a.sent[kind] = now
	to, mail := a.cfg.Email, a.mail
	a.mu.Unlock()

	slog.Warn("alert", "kind", kind, "subject", subject, "detail", text)
	if to != "" && mail != nil {
		stamp := now.UTC().Format("2006-01-02 15:04 UTC")
		mailer.SendAsync(mail, mailer.Message{
			To:      to,
			Subject: "[Inkling] " + subject,
			Text:    text + "\n\n" + stamp + "\nThis is an automatic message from your Inkling server. It will not repeat this alert for a while.",
			HTML: `<div style="font-family:Arial,sans-serif;max-width:520px;color:#222"><h2>` + html.EscapeString(subject) + `</h2><p>` +
				html.EscapeString(text) + `</p><p style="font-size:13px;color:#555">` + stamp +
				`<br>This is an automatic message from your Inkling server. It will not repeat this alert for a while.</p></div>`,
		})
	}
	return true
}

// BudgetUsedUp is called when the day's AI budget has just run out (or a request meets it already used up).
func (a *Alerter) BudgetUsedUp(limit int) {
	a.Notify("budget", "Inkling has used up today's AI budget",
		fmt.Sprintf("The site has started %d pieces of AI work today, which is its daily limit (AI_REQUESTS_PER_DAY). AI work is paused until midnight UTC. If this is more than you expected, look for one account or address making most of it.", limit),
		budgetCooldown)
}

// AIResult is called after every call to the AI service. failed means the service could not be reached or answered
// with a server error; a refusal because of what was sent is not a failure.
func (a *Alerter) AIResult(failed bool) {
	if !a.enabled.Load() {
		return
	}
	a.mu.Lock()
	now := a.now()
	cutoff := now.Add(-aiWindow)
	recent := a.ai[:0]
	for _, r := range a.ai {
		if !r.at.Before(cutoff) {
			recent = append(recent, r)
		}
	}
	a.ai = append(recent, aiResult{at: now, failed: failed})
	failures := 0
	for _, r := range a.ai {
		if r.failed {
			failures++
		}
	}
	total, cooldown := len(a.ai), a.cfg.Cooldown
	a.mu.Unlock()

	if failed && failures >= aiMinFailures && failures*2 >= total {
		a.Notify("ai-failing", "The AI service is failing",
			fmt.Sprintf("%d of the last %d calls to the AI service in the past %d minutes failed. Check that the AI service is running, that GROQ_API_KEY is valid and that Groq's own quota is not used up.", failures, total, int(aiWindow/time.Minute)),
			cooldown)
	}
}
