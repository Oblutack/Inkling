package server

import (
	"net/http"
	"strings"
	"testing"
)

// Dates and deadlines found in a saved document.

func TestDatesAreFoundOnceKeptAndShownAgainForFree(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "The lease ends on 28 February 2027. Rent is due on the first day of each month.")

	if r := cl.get(docPath(id, "/dates")); r.Status != http.StatusOK || r.JSON()["dates"] != nil {
		t.Fatalf("nothing found yet: %d %s", r.Status, r.Body)
	}

	first := cl.post(docPath(id, "/dates"), nil)
	if first.Status != http.StatusOK || first.JSON()["cached"] != false {
		t.Fatalf("finding: %d %s", first.Status, first.Body)
	}
	found := first.JSON()["dates"].([]any)
	if len(found) != 2 {
		t.Fatalf("dates: %s", first.Body)
	}
	lease := found[0].(map[string]any)
	if lease["date"] != "2027-02-28" || lease["verified"] != true || !strings.Contains(lease["quote"].(string), "28 February 2027") {
		t.Errorf("the lease date: %v", lease)
	}
	rent := found[1].(map[string]any)
	if rent["date"] != nil || rent["repeat"] != "monthly" || rent["relative"] != "the first day of each month" {
		t.Errorf("a date without a day: %v", rent)
	}
	if sent, _ := a.ai.lastDates.Load().([]byte); !strings.Contains(string(sent), "28 February 2027") {
		t.Errorf("the saved text was what the model looked in: %s", sent)
	}

	again := cl.post(docPath(id, "/dates"), nil)
	if again.Status != http.StatusOK || again.JSON()["cached"] != true || len(again.JSON()["dates"].([]any)) != 2 {
		t.Errorf("the same dates again: %s", again.Body)
	}
	if stored := cl.get(docPath(id, "/dates")); len(stored.JSON()["dates"].([]any)) != 2 {
		t.Errorf("and they can be read without asking: %s", stored.Body)
	}
	if n := a.ai.datesCalls.Load(); n != 1 {
		t.Errorf("the model was asked once, not %d times", n)
	}

	cl.post(docPath(id, "/dates"), map[string]any{"regenerate": true})
	if n := a.ai.datesCalls.Load(); n != 2 {
		t.Errorf("asking anew looks again: %d", n)
	}
}

func TestDatesAreNotCountedAgainstTheDailyAllowance(t *testing.T) {
	a := newApp(t)
	t.Setenv("QUOTA_CHAT_PER_DAY", "1")
	t.Setenv("QUOTA_SUMMARIES_PER_DAY", "1")
	cl, _ := a.newUser()
	id := saveText(t, cl, "The lease ends on 28 February 2027.")
	if r := cl.post(docPath(id, "/dates"), nil); r.Status != http.StatusOK {
		t.Fatalf("dates: %d %s", r.Status, r.Body)
	}
	if n := count(t, a.db, "SELECT COALESCE(SUM(chats),0) FROM daily_usage"); n != 0 {
		t.Errorf("chat allowance used: %d", n)
	}
}

func TestWhatTheAIServiceSendsIsCleanedBeforeItIsKept(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Some pasted words.")
	a.ai.datesReply.Store(`{"dates":[` +
		`{"what":"  Fine  ","date":"2027-02-28","repeat":"fortnightly","relative":"","quote":"x","page":0,"verified":true,"reason":""},` +
		`{"what":"Impossible","date":"2027-02-30","repeat":"none","relative":"","quote":"x","page":null,"verified":true,"reason":""},` +
		`{"what":"Impossible but described","date":"2027-13-01","repeat":"none","relative":"within 30 days","quote":"x","page":null,"verified":true,"reason":""},` +
		`{"what":"","date":"2027-01-01","repeat":"none","relative":"","quote":"x","page":null,"verified":true,"reason":""},` +
		`{"what":"Nothing to say","date":null,"repeat":"none","relative":"","quote":"x","page":null,"verified":true,"reason":""}` +
		`],"suspicious":true}`)
	r := cl.post(docPath(id, "/dates"), nil)
	if r.Status != http.StatusOK {
		t.Fatalf("dates: %d %s", r.Status, r.Body)
	}
	found := r.JSON()["dates"].([]any)
	if len(found) != 2 {
		t.Fatalf("only the usable ones are kept: %s", r.Body)
	}
	fine := found[0].(map[string]any)
	if fine["what"] != "Fine" || fine["repeat"] != "none" || fine["page"] != nil {
		t.Errorf("a fine one is tidied: %v", fine)
	}
	waiting := found[1].(map[string]any)
	if waiting["date"] != nil || waiting["verified"] != false || waiting["relative"] != "within 30 days" {
		t.Errorf("a date that is not real is dropped and no longer vouched for: %v", waiting)
	}
	if r.JSON()["suspicious"] != true {
		t.Errorf("the warning about instructions is passed on: %s", r.Body)
	}
}

func TestDatesAreValidatedRefusedForOthersAndFailuresDoNotUseTheBudget(t *testing.T) {
	a := newApp(t)
	alice, _ := a.newUser()
	bob, _ := a.newUser()
	id := saveText(t, alice, "The lease ends on 28 February 2027.")

	if r := bob.post(docPath(id, "/dates"), nil); r.Status != http.StatusNotFound {
		t.Errorf("another user's document: %d", r.Status)
	}
	if r := bob.get(docPath(id, "/dates")); r.Status != http.StatusNotFound {
		t.Errorf("another user's dates: %d", r.Status)
	}
	if r := alice.post(docPath(id, "/dates"), map[string]any{"language": "Klingon"}); r.Status != http.StatusBadRequest {
		t.Errorf("a language that does not exist: %d", r.Status)
	}
	a.ai.fail.Store(true)
	if r := alice.post(docPath(id, "/dates"), nil); r.Status < 500 {
		t.Errorf("a failing AI service: %d", r.Status)
	}
	a.ai.fail.Store(false)
	if n := count(t, a.db, "SELECT count(*) FROM documents WHERE dates IS NOT NULL"); n != 0 {
		t.Errorf("a failure is not kept: %d", n)
	}
	if r := alice.post(docPath(id, "/dates"), nil); r.Status != http.StatusOK {
		t.Errorf("and it recovers: %d", r.Status)
	}
}

func TestADocumentWithoutItsSavedTextCannotBeSearchedForDates(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Some pasted words.")
	a.db.Exec("UPDATE documents SET has_content = false, content = '' WHERE id = ?", id)
	if r := cl.post(docPath(id, "/dates"), nil); r.Status != http.StatusConflict {
		t.Errorf("no saved text: %d %s", r.Status, r.Body)
	}
	if n := a.ai.datesCalls.Load(); n != 0 {
		t.Errorf("the model was not asked: %d", n)
	}
}

func TestRewritingTheSummaryKeepsTheDates(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "The lease ends on 28 February 2027.")
	cl.post(docPath(id, "/dates"), nil)
	if r := cl.post(docPath(id, "/rewrite"), map[string]any{"style": "brief"}); r.Status != http.StatusOK {
		t.Fatalf("rewrite: %d %s", r.Status, r.Body)
	}
	if n := count(t, a.db, "SELECT count(*) FROM documents WHERE dates IS NOT NULL"); n != 1 {
		t.Errorf("the dates come from the text, not the summary: %d", n)
	}
}
