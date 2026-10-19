package server

import (
	"net/http"
	"strings"
	"testing"
)

// "Explain this": a few selected words explained in plain words, through an API key (the browser extension's).

func TestASelectionIsExplainedThroughAKeyAndCountsAsAChatQuestion(t *testing.T) {
	a := newApp(t)
	t.Setenv("QUOTA_CHAT_PER_DAY", "2")
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "extension")

	r := a.call(http.MethodPost, "/v1/explain", key, map[string]any{"text": "  The deposit sits in escrow.  ", "language": "German", "simpler": true})
	if r.Status != http.StatusOK || r.JSON()["explanation"] != "It means money held by a third party." {
		t.Fatalf("explain: %d %s", r.Status, r.Body)
	}
	sent, _ := a.ai.lastExplain.Load().([]byte)
	for _, want := range []string{`"text":"The deposit sits in escrow."`, `"simpler":true`, `"language":"German"`} {
		if !strings.Contains(string(sent), want) {
			t.Errorf("sent %s: %s", want, sent)
		}
	}
	if n := count(t, a.db, "SELECT COALESCE(SUM(chats),0) FROM daily_usage"); n != 1 {
		t.Errorf("one chat question, not a summary: %d", n)
	}
	if n := count(t, a.db, "SELECT COALESCE(SUM(summaries),0) FROM daily_usage"); n != 0 {
		t.Errorf("no summary used: %d", n)
	}
	a.call(http.MethodPost, "/v1/explain", key, map[string]any{"text": "More."})
	if r := a.call(http.MethodPost, "/v1/explain", key, map[string]any{"text": "A third."}); r.Status != http.StatusTooManyRequests {
		t.Errorf("the allowance is the key owner's: %d", r.Status)
	}
}

func TestExplainingIsCheckedAndAFailureCostsNothing(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "extension")
	for name, body := range map[string]map[string]any{
		"nothing":      {"text": "   "},
		"no text":      {},
		"bad language": {"text": "x", "language": "Klingon"},
	} {
		if r := a.call(http.MethodPost, "/v1/explain", key, body); r.Status != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, r.Status, r.Body)
		}
	}
	if r := a.call(http.MethodPost, "/v1/explain", key, map[string]any{"text": strings.Repeat("x", 2001)}); r.Status != http.StatusRequestEntityTooLarge {
		t.Errorf("too long: %d", r.Status)
	}
	a.ai.fail.Store(true)
	if r := a.call(http.MethodPost, "/v1/explain", key, map[string]any{"text": "Escrow."}); r.Status < 500 {
		t.Errorf("a failing AI service: %d", r.Status)
	}
	a.ai.fail.Store(false)
	if n := count(t, a.db, "SELECT COALESCE(SUM(chats),0) FROM daily_usage"); n != 0 {
		t.Errorf("nothing was charged: %d", n)
	}
	if r := a.call(http.MethodPost, "/v1/explain", key, map[string]any{"text": "Escrow."}); r.Status != http.StatusOK {
		t.Errorf("and it recovers: %d", r.Status)
	}
	if a.ai.explainCalls.Load() != 1 {
		t.Errorf("the invalid ones never reached the AI service: %d", a.ai.explainCalls.Load())
	}
}

func TestExplainingNeedsAKey(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	if r := cl.post("/v1/explain", map[string]any{"text": "Escrow."}); r.Status != http.StatusUnauthorized {
		t.Errorf("a signed-in session is not a key: %d", r.Status)
	}
	if r := a.call(http.MethodPost, "/v1/explain", "", map[string]any{"text": "Escrow."}); r.Status != http.StatusUnauthorized {
		t.Errorf("no key: %d", r.Status)
	}
}
