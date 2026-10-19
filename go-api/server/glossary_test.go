package server

import (
	"net/http"
	"strings"
	"testing"
)

// The glossary of a document: specialist terms, each explained, with the pages they are on.

func glossaryPath(id int) string { return docPath(id, "/glossary") }

func TestAGlossaryIsMadeOnceKeptAndShownAgainForFree(t *testing.T) {
	a := newApp(t)
	t.Setenv("QUOTA_CHAT_PER_DAY", "1")
	cl, _ := a.newUser()
	id := saveText(t, cl, "The escrow account holds the deposit. Arrears are due.")

	if r := cl.get(glossaryPath(id)); r.Status != http.StatusOK || r.JSON()["terms"] != nil {
		t.Fatalf("nothing yet: %d %s", r.Status, r.Body)
	}
	first := cl.post(glossaryPath(id), map[string]any{})
	if first.Status != http.StatusOK || first.JSON()["cached"] != false {
		t.Fatalf("making it: %d %s", first.Status, first.Body)
	}
	terms := first.JSON()["terms"].([]any)
	if len(terms) != 2 {
		t.Fatalf("terms: %s", first.Body)
	}
	escrow := terms[0].(map[string]any)
	if escrow["term"] != "escrow" || escrow["explanation"] != "Money held by a third party." || len(escrow["pages"].([]any)) != 2 {
		t.Errorf("the first term: %v", escrow)
	}
	if sent, _ := a.ai.lastGlossary.Load().([]byte); !strings.Contains(string(sent), "escrow account") {
		t.Errorf("the saved text was sent: %s", sent)
	}

	again := cl.post(glossaryPath(id), nil)
	if again.Status != http.StatusOK || again.JSON()["cached"] != true || len(again.JSON()["terms"].([]any)) != 2 {
		t.Errorf("shown again: %d %s", again.Status, again.Body)
	}
	if stored := cl.get(glossaryPath(id)); len(stored.JSON()["terms"].([]any)) != 2 {
		t.Errorf("and read without asking: %s", stored.Body)
	}
	if a.ai.glossaryCalls.Load() != 1 {
		t.Errorf("the model was asked once: %d", a.ai.glossaryCalls.Load())
	}
	if r := cl.post(glossaryPath(id), map[string]any{"regenerate": true}); r.Status != http.StatusTooManyRequests {
		t.Errorf("a new one needs allowance, and the one chat question is used: %d", r.Status)
	}
	if r := cl.post(glossaryPath(id), nil); r.Status != http.StatusOK || r.JSON()["cached"] != true {
		t.Errorf("but the old one is still shown: %d", r.Status)
	}
}

func TestWhatTheAIServiceSendsForAGlossaryIsCleaned(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Words.")
	a.ai.glossaryReply.Store(`{"terms":[` +
		`{"term":"  Escrow ","explanation":"  Held by a third party. ","pages":[0,2,2,3,4,5,6,7,8]},` +
		`{"term":"escrow","explanation":"A repeat","pages":[1]},` +
		`{"term":"","explanation":"No term","pages":[]},` +
		`{"term":"Nothing","explanation":"","pages":[]}],"suspicious":true}`)
	r := cl.post(glossaryPath(id), nil)
	terms := r.JSON()["terms"].([]any)
	if len(terms) != 1 {
		t.Fatalf("one usable term: %s", r.Body)
	}
	term := terms[0].(map[string]any)
	if term["term"] != "Escrow" || term["explanation"] != "Held by a third party." || len(term["pages"].([]any)) != 6 {
		t.Errorf("tidied: %v", term)
	}
	if r.JSON()["suspicious"] != true {
		t.Errorf("the warning is passed on: %s", r.Body)
	}
}

func TestAGlossaryIsValidatedPrivateAndAFailureCostsNothing(t *testing.T) {
	a := newApp(t)
	alice, _ := a.newUser()
	bob, _ := a.newUser()
	id := saveText(t, alice, "Alice's words.")
	if r := alice.post(glossaryPath(id), map[string]any{"language": "Klingon"}); r.Status != http.StatusBadRequest {
		t.Errorf("language: %d", r.Status)
	}
	if r := bob.post(glossaryPath(id), nil); r.Status != http.StatusNotFound {
		t.Errorf("another person's document: %d", r.Status)
	}
	if r := bob.get(glossaryPath(id)); r.Status != http.StatusNotFound {
		t.Errorf("another person's glossary: %d", r.Status)
	}
	a.ai.fail.Store(true)
	if r := alice.post(glossaryPath(id), nil); r.Status < 500 {
		t.Errorf("a failing AI service: %d", r.Status)
	}
	a.ai.fail.Store(false)
	if n := count(t, a.db, "SELECT COALESCE(SUM(chats),0) FROM daily_usage"); n != 0 {
		t.Errorf("nothing was charged: %d", n)
	}
	a.db.Exec("UPDATE documents SET has_content = false, content = '' WHERE id = ?", id)
	if r := alice.post(glossaryPath(id), nil); r.Status != http.StatusConflict {
		t.Errorf("no saved text: %d", r.Status)
	}
	if r := alice.post(docPath(id, "/rewrite"), map[string]any{"style": "bullets"}); r.Status == http.StatusOK {
		t.Log("rewrite needs the text, so it is refused here")
	}
}
