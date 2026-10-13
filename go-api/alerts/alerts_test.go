package alerts

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-summarizer/go-api/mailer"
	"ai-summarizer/go-api/metrics"
)

// A clock the test moves by hand.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *clock { return &clock{t: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)} }
func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// A mailer that keeps what it was asked to send. Sending is asynchronous, so tests wait on sent.
type fakeMail struct {
	sent chan mailer.Message
}

func newFakeMail() *fakeMail { return &fakeMail{sent: make(chan mailer.Message, 20)} }
func (f *fakeMail) Send(_ context.Context, m mailer.Message) error {
	f.sent <- m
	return nil
}

// next returns the next email, or fails the test if none arrives.
func (f *fakeMail) next(t *testing.T) mailer.Message {
	t.Helper()
	select {
	case m := <-f.sent:
		return m
	case <-time.After(2 * time.Second):
		t.Fatal("expected an email, none was sent")
		return mailer.Message{}
	}
}

// none fails the test if an email arrives soon after.
func (f *fakeMail) none(t *testing.T) {
	t.Helper()
	select {
	case m := <-f.sent:
		t.Fatalf("expected no email, got %q", m.Subject)
	case <-time.After(150 * time.Millisecond):
	}
}

func setup(cfg Config) (*Alerter, *clock, *fakeMail) {
	clk, mail := newClock(), newFakeMail()
	return New(cfg, mail, clk.now), clk, mail
}

func visit(a *Alerter, n int) {
	for i := 0; i < n; i++ {
		a.Touch("visitor-" + string(rune('A'+i/26)) + string(rune('a'+i%26)))
	}
}

var ten = Config{Email: "owner@example.com", ActiveUsers: 10, ActiveUsersHigh: 25}

func TestAVisitorCountsOnceHoweverOftenTheyCome(t *testing.T) {
	a, _, _ := setup(ten)
	for i := 0; i < 50; i++ {
		a.Touch("u:7")
	}
	a.Touch("a:abc")
	if got := a.Active(); got != 2 {
		t.Fatalf("active = %d, want 2", got)
	}
}

func TestVisitorsDropOutOnceTheWindowHasPassed(t *testing.T) {
	a, clk, _ := setup(ten)
	visit(a, 6)
	clk.advance(3 * time.Minute)
	a.Touch("late")
	if got := a.Active(); got != 7 {
		t.Fatalf("after 3 minutes active = %d, want 7", got)
	}
	clk.advance(3 * time.Minute) // the six are now 6 minutes old, the late one is 3
	if got := a.Active(); got != 1 {
		t.Fatalf("after 6 minutes active = %d, want 1", got)
	}
}

func TestNothingIsSentBelowTheLevel(t *testing.T) {
	a, _, mail := setup(ten)
	visit(a, 9)
	a.Check()
	mail.none(t)
}

func TestReachingTheLevelSendsOneEmailWithTheNumber(t *testing.T) {
	a, _, mail := setup(ten)
	visit(a, 10)
	a.Check()
	m := mail.next(t)
	if m.To != "owner@example.com" {
		t.Fatalf("sent to %q", m.To)
	}
	if !strings.HasPrefix(m.Subject, "[Inkling] ") || !strings.Contains(m.Subject, "10 people") {
		t.Fatalf("subject = %q", m.Subject)
	}
	for _, body := range []string{m.Text, m.HTML} {
		if !strings.Contains(body, "10 different people") || !strings.Contains(body, "2026-10-13 12:00 UTC") {
			t.Fatalf("body is missing the number or the time: %q", body)
		}
		// a number and a time, nothing about anyone
		if strings.Contains(body, "visitor-") {
			t.Fatalf("the email names a visitor: %q", body)
		}
	}
}

func TestTheSameAlertIsNotRepeatedUntilTheCooldownHasPassed(t *testing.T) {
	a, clk, mail := setup(ten)
	visit(a, 12)
	a.Check()
	mail.next(t)

	for i := 0; i < 5; i++ { // a busy half hour: still above the level, still one email
		clk.advance(5 * time.Minute)
		visit(a, 12)
		a.Check()
	}
	mail.none(t)

	clk.advance(40 * time.Minute) // more than an hour since the email
	visit(a, 12)
	a.Check()
	mail.next(t)
}

func TestTheHighLevelSendsOnlyItsOwnEmail(t *testing.T) {
	a, _, mail := setup(ten)
	visit(a, 30)
	a.Check()
	m := mail.next(t)
	if !strings.Contains(m.Text, "high level of 25") {
		t.Fatalf("expected the high-level wording, got %q", m.Text)
	}
	a.Check()
	mail.none(t) // neither the high one again nor the lower one that was held back
}

func TestTheLowerLevelStillWorksAfterAHighOneHasPassed(t *testing.T) {
	a, clk, mail := setup(ten)
	visit(a, 30)
	a.Check()
	mail.next(t)

	clk.advance(2 * time.Hour)
	visit(a, 11)
	a.Check()
	if m := mail.next(t); !strings.Contains(m.Text, "level of 10") {
		t.Fatalf("expected the normal wording, got %q", m.Text)
	}
}

func TestALevelOfZeroIsOff(t *testing.T) {
	a, _, mail := setup(Config{Email: "owner@example.com", ActiveUsers: 0, ActiveUsersHigh: 0})
	visit(a, 200)
	a.Check()
	mail.none(t)
}

func TestWithoutAnAddressTheAlertIsOnlyLogged(t *testing.T) {
	a, _, mail := setup(Config{ActiveUsers: 3})
	visit(a, 3)
	a.Check()
	mail.none(t)
	// it was still raised, so the cooldown is running: a second Notify of the same kind is refused
	if a.Notify("active-users", "again", "again", time.Hour) {
		t.Fatal("the alert should have been counted as sent")
	}
}

func TestAnAlerterThatWasNeverStartedDoesNothing(t *testing.T) {
	var a Alerter
	a.Touch("x")
	a.AIResult(true)
	a.BudgetUsedUp(5)
	a.Check()
	if a.Active() != 0 || a.Notify("k", "s", "t", time.Hour) {
		t.Fatal("a disabled alerter should ignore everything")
	}
}

func TestDisableStopsIt(t *testing.T) {
	a, _, _ := setup(ten)
	a.Disable()
	a.Touch("x")
	if a.Active() != 0 {
		t.Fatal("a disabled alerter should not count")
	}
}

func TestTheBudgetEmailIsSentOnceAHalfDay(t *testing.T) {
	a, clk, mail := setup(ten)
	a.BudgetUsedUp(5000)
	m := mail.next(t)
	if !strings.Contains(m.Subject, "AI budget") || !strings.Contains(m.Text, "5000") {
		t.Fatalf("unexpected email: %q / %q", m.Subject, m.Text)
	}
	for i := 0; i < 100; i++ { // every refused request calls it
		a.BudgetUsedUp(5000)
	}
	clk.advance(11 * time.Hour)
	a.BudgetUsedUp(5000)
	mail.none(t)
	clk.advance(2 * time.Hour)
	a.BudgetUsedUp(5000)
	mail.next(t)
}

func TestTheAIServiceFailingAlertsOnlyWhenMostCallsFail(t *testing.T) {
	a, _, mail := setup(ten)
	for i := 0; i < 4; i++ {
		a.AIResult(true)
	}
	mail.none(t) // four failures are not enough
	a.AIResult(true)
	m := mail.next(t)
	if !strings.Contains(m.Subject, "AI service is failing") || !strings.Contains(m.Text, "5 of the last 5") {
		t.Fatalf("unexpected email: %q / %q", m.Subject, m.Text)
	}
}

func TestAFewFailuresAmongManySuccessesAreNotAnAlert(t *testing.T) {
	a, _, mail := setup(ten)
	for i := 0; i < 30; i++ {
		a.AIResult(false)
	}
	for i := 0; i < 6; i++ { // 6 of 36: one in six
		a.AIResult(true)
	}
	mail.none(t)
}

func TestOldAICallsAreForgotten(t *testing.T) {
	a, clk, mail := setup(ten)
	for i := 0; i < 4; i++ {
		a.AIResult(true)
	}
	clk.advance(11 * time.Minute)
	a.AIResult(true) // the four are too old: this is the first of a new run
	mail.none(t)
}

func TestConfigFromEnv(t *testing.T) {
	t.Setenv("ALERT_EMAIL", "  me@example.com ")
	t.Setenv("ALERT_ACTIVE_USERS", "")
	t.Setenv("ALERT_ACTIVE_USERS_HIGH", "")
	t.Setenv("ALERT_WINDOW_MINUTES", "")
	t.Setenv("ALERT_COOLDOWN_MINUTES", "")
	cfg := ConfigFromEnv()
	if cfg.Email != "me@example.com" || cfg.ActiveUsers != 10 || cfg.ActiveUsersHigh != 25 || cfg.Window != 5*time.Minute || cfg.Cooldown != time.Hour {
		t.Fatalf("defaults wrong: %+v", cfg)
	}

	t.Setenv("ALERT_ACTIVE_USERS", "4")
	t.Setenv("ALERT_ACTIVE_USERS_HIGH", "9")
	t.Setenv("ALERT_WINDOW_MINUTES", "2")
	t.Setenv("ALERT_COOLDOWN_MINUTES", "30")
	cfg = ConfigFromEnv()
	if cfg.ActiveUsers != 4 || cfg.ActiveUsersHigh != 9 || cfg.Window != 2*time.Minute || cfg.Cooldown != 30*time.Minute {
		t.Fatalf("set values wrong: %+v", cfg)
	}

	t.Setenv("ALERT_ACTIVE_USERS", "0") // off
	if cfg = ConfigFromEnv(); cfg.ActiveUsers != 0 || cfg.ActiveUsersHigh != 9 {
		t.Fatalf("zero should switch a level off: %+v", cfg)
	}

	t.Setenv("ALERT_ACTIVE_USERS", "many") // not a number: the default
	t.Setenv("ALERT_WINDOW_MINUTES", "0")  // a window of nothing would count nobody: the default
	if cfg = ConfigFromEnv(); cfg.ActiveUsers != 10 || cfg.Window != 5*time.Minute {
		t.Fatalf("bad values should fall back: %+v", cfg)
	}

	t.Setenv("ALERT_ACTIVE_USERS", "20") // a high level at or below the first is raised above it
	t.Setenv("ALERT_ACTIVE_USERS_HIGH", "15")
	if cfg = ConfigFromEnv(); cfg.ActiveUsersHigh != 21 {
		t.Fatalf("high level should be raised above the first: %+v", cfg)
	}
}

func TestMemoryIsBoundedUnderAFlood(t *testing.T) {
	a, _, _ := setup(ten)
	for i := 0; i < maxTracked+500; i++ {
		a.Touch(strings.Repeat("x", 3) + time.Duration(i).String())
	}
	if got := a.Active(); got != maxTracked {
		t.Fatalf("active = %d, want the cap %d", got, maxTracked)
	}
	a.Touch(strings.Repeat("x", 3) + time.Duration(1).String()) // someone already counted may still be refreshed
}

func TestRunChecksOnEveryTick(t *testing.T) {
	a, _, mail := setup(ten)
	visit(a, 11)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.Run(ctx, 10*time.Millisecond)
	mail.next(t)
}

func TestStartPublishesTheNumberOfPeopleAsAMetric(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer Default.Disable()
	Start(ctx, Config{}, nil)
	Start(ctx, Config{}, nil) // a second start must not register it twice
	Default.Touch("u:1")
	Default.Touch("u:2")
	families, err := metrics.Registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range families {
		if f.GetName() == "active_users" {
			if got := f.GetMetric()[0].GetGauge().GetValue(); got != 2 {
				t.Fatalf("active_users = %v, want 2", got)
			}
			return
		}
	}
	t.Fatal("the active_users metric is not published")
}
