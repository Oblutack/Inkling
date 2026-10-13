package server

import (
	"ai-summarizer/go-api/alerts"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The alerts, through the real router: what the server reports into the alerter, and the emails that come out.

func alertsOn(t *testing.T, a *app, cfg alerts.Config) {
	t.Helper()
	if cfg.Email == "" {
		cfg.Email = "owner@example.com"
	}
	alerts.Default.Reset(cfg, a.mail, nil)
	t.Cleanup(alerts.Default.Disable)
}

// alertMail waits for an email to the owner whose subject holds want (emails are sent in the background).
func alertMail(t *testing.T, a *app, want string) sentMail {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, m := range a.mail.all() {
			if m.To == "owner@example.com" && strings.Contains(m.Subject, want) {
				return m
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no alert email about %q arrived; sent: %+v", want, a.mail.all())
	return sentMail{}
}

func alertMails(a *app) int {
	n := 0
	for _, m := range a.mail.all() {
		if m.To == "owner@example.com" {
			n++
		}
	}
	return n
}

func TestACrowdOfPeopleEmailsTheOwnerOnce(t *testing.T) {
	a := newApp(t)
	alertsOn(t, a, alerts.Config{ActiveUsers: 3, ActiveUsersHigh: 0})
	for i := 0; i < 3; i++ {
		cl, _ := a.newUser()
		if r := cl.get("/auth/me"); r.Status != http.StatusOK {
			t.Fatalf("me: %d", r.Status)
		}
	}
	if got := alerts.Default.Active(); got < 3 {
		t.Fatalf("three signed-in people are active, the count says %d", got)
	}
	alerts.Default.Check()
	m := alertMail(t, a, "people are using Inkling")
	if strings.Contains(m.Text, "@") {
		t.Fatalf("the alert must not carry anyone's address: %q", m.Text)
	}
	alerts.Default.Check()
	time.Sleep(150 * time.Millisecond)
	if n := alertMails(a); n != 1 {
		t.Fatalf("one rush, one email; got %d", n)
	}
}

func TestHealthChecksAndMetricsAreNotACrowd(t *testing.T) {
	a := newApp(t)
	alertsOn(t, a, alerts.Config{ActiveUsers: 2})
	probe := a.newClient()
	for i := 0; i < 20; i++ {
		probe.get("/healthz")
		probe.get("/readyz")
	}
	if got := alerts.Default.Active(); got != 0 {
		t.Fatalf("monitors counted as %d people", got)
	}
}

func TestUsingUpTheDaysBudgetEmailsTheOwnerOnce(t *testing.T) {
	a := newApp(t)
	t.Setenv("AI_REQUESTS_PER_DAY", "2")
	alertsOn(t, a, alerts.Config{ActiveUsers: 0})
	cl, _ := a.newUser()
	summarize(cl)
	summarize(cl) // the second one uses the budget up
	alertMail(t, a, "AI budget")
	for i := 0; i < 5; i++ { // and every one refused afterwards is only refused
		if r := summarize(cl); r.Status != http.StatusServiceUnavailable {
			t.Fatalf("expected the pause, got %d", r.Status)
		}
	}
	time.Sleep(150 * time.Millisecond)
	if n := alertMails(a); n != 1 {
		t.Fatalf("one email for the whole day, got %d", n)
	}
}

func TestAnAIServiceThatKeepsFailingEmailsTheOwner(t *testing.T) {
	a := newApp(t)
	alertsOn(t, a, alerts.Config{ActiveUsers: 0})
	a.ai.fail.Store(true)
	cl, _ := a.newUser()
	for i := 0; i < 5; i++ {
		if r := summarize(cl); r.Status == http.StatusOK {
			t.Fatal("the fake AI service is failing: the summary cannot succeed")
		}
	}
	m := alertMail(t, a, "AI service is failing")
	if !strings.Contains(m.Text, "GROQ_API_KEY") {
		t.Fatalf("the email should say what to check: %q", m.Text)
	}
}

func TestAnAIServiceThatRefusesWhatItWasSentIsNotFailing(t *testing.T) {
	a := newApp(t)
	alertsOn(t, a, alerts.Config{ActiveUsers: 0})
	cl, _ := a.newUser()
	for i := 0; i < 8; i++ { // empty text is refused by the gateway before it ever reaches the AI service
		cl.post("/summarize-text", map[string]string{"text": ""})
	}
	time.Sleep(150 * time.Millisecond)
	if n := alertMails(a); n != 0 {
		t.Fatalf("refusals are not failures, got %d emails", n)
	}
}
