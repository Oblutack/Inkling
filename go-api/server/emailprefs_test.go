package server

import (
	"net/http"
	"testing"

	"ai-summarizer/go-api/notices"
)

// The emails a person chose to receive, and the link in each that stops them.

func TestEmailPreferencesStartWithOnlyWhatWasAskedFor(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	r := cl.get("/account/email-preferences")
	body := r.JSON()
	if r.Status != http.StatusOK || body["watch"] != true || body["reminders"] != false || body["digest"] != false || body["timeZone"] != "" {
		t.Errorf("defaults: %d %s", r.Status, r.Body)
	}
}

func TestOnlyWhatIsSentChanges(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	r := cl.put("/account/email-preferences", map[string]any{"reminders": true, "timeZone": "Europe/Sarajevo"})
	body := r.JSON()
	if r.Status != http.StatusOK || body["reminders"] != true || body["watch"] != true || body["digest"] != false || body["timeZone"] != "Europe/Sarajevo" {
		t.Fatalf("after the first change: %d %s", r.Status, r.Body)
	}
	body = cl.put("/account/email-preferences", map[string]any{"watch": false}).JSON()
	if body["watch"] != false || body["reminders"] != true || body["timeZone"] != "Europe/Sarajevo" {
		t.Errorf("a second change keeps the first: %v", body)
	}
	if got := cl.get("/account/email-preferences").JSON(); got["watch"] != false || got["reminders"] != true {
		t.Errorf("and it is kept: %v", got)
	}
}

func TestAnInvalidTimeZoneAndSignedOutAccessAreRefused(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	if r := cl.put("/account/email-preferences", map[string]any{"timeZone": "Mars/Olympus"}); r.Status != http.StatusBadRequest {
		t.Errorf("a made-up zone: %d", r.Status)
	}
	if r := cl.put("/account/email-preferences", "not json"); r.Status != http.StatusBadRequest {
		t.Errorf("a broken body: %d", r.Status)
	}
	out := a.newClient()
	if r := out.get("/account/email-preferences"); r.Status != http.StatusUnauthorized {
		t.Errorf("signed out, read: %d", r.Status)
	}
	if r := out.put("/account/email-preferences", map[string]any{"reminders": true}); r.Status != http.StatusUnauthorized {
		t.Errorf("signed out, change: %d", r.Status)
	}
}

func TestOneClickUnsubscribeNeedsNoLoginAndOnlySwitchesEmailOff(t *testing.T) {
	a := newApp(t)
	cl, email := a.newUser()
	cl.put("/account/email-preferences", map[string]any{"reminders": true, "digest": true})
	token, err := notices.Token(a.userByEmail(email).ID)
	if err != nil {
		t.Fatal(err)
	}

	visitor := a.newClient() // not signed in: the link is opened from an email
	if r := visitor.post("/email/unsubscribe", map[string]string{"token": token, "kind": "reminders"}); r.Status != http.StatusOK {
		t.Fatalf("unsubscribe: %d %s", r.Status, r.Body)
	}
	got := cl.get("/account/email-preferences").JSON()
	if got["reminders"] != false || got["digest"] != true || got["watch"] != true {
		t.Errorf("only reminders went off: %v", got)
	}
	visitor.post("/email/unsubscribe", map[string]string{"token": token, "kind": "all"})
	got = cl.get("/account/email-preferences").JSON()
	if got["watch"] != false || got["digest"] != false {
		t.Errorf("all went off: %v", got)
	}
}

func TestAnUnsubscribeLinkRevealsNothingAboutAccounts(t *testing.T) {
	a := newApp(t)
	cl, email := a.newUser()
	cl.put("/account/email-preferences", map[string]any{"reminders": true})
	token, _ := notices.Token(a.userByEmail(email).ID)
	visitor := a.newClient()

	right := visitor.post("/email/unsubscribe", map[string]string{"token": token, "kind": "digest"})
	wrong := visitor.post("/email/unsubscribe", map[string]string{"token": "a-token-that-matches-nobody-at-all-0123456789", "kind": "digest"})
	if right.Status != wrong.Status || string(right.Body) != string(wrong.Body) {
		t.Errorf("the same answer either way: %d %s / %d %s", right.Status, right.Body, wrong.Status, wrong.Body)
	}
	if r := visitor.post("/email/unsubscribe", map[string]string{"token": token, "kind": "nonsense"}); r.Status != http.StatusBadRequest {
		t.Errorf("an unknown kind: %d", r.Status)
	}
	if got := cl.get("/account/email-preferences").JSON(); got["reminders"] != true {
		t.Errorf("a wrong request changed nothing: %v", got)
	}
}
