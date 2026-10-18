package server

import (
	"net/http"
	"strings"
	"testing"
)

// Contract checklists. The fake AI service answers with three items (found, unclear, missing) and one unusual clause.

func checklistPath(id int) string { return docPath(id, "/checklist") }

func checkBody(kind string) map[string]any { return map[string]any{"kind": kind} }

func TestAChecklistIsMadeOnceKeptPerKindAndShownAgainForFree(t *testing.T) {
	a := newApp(t)
	t.Setenv("QUOTA_CHAT_PER_DAY", "2")
	cl, _ := a.newUser()
	id := saveText(t, cl, "The tenant pays 950 euros per month. The lease renews automatically.")

	first := cl.post(checklistPath(id), checkBody("lease"))
	if first.Status != http.StatusOK || first.JSON()["cached"] != false || first.JSON()["kind"] != "lease" {
		t.Fatalf("checking: %d %s", first.Status, first.Body)
	}
	items := first.JSON()["items"].([]any)
	if len(items) != 3 {
		t.Fatalf("items: %s", first.Body)
	}
	rent := items[0].(map[string]any)
	if rent["id"] != "rent" || rent["status"] != "found" || rent["page"].(float64) != 1 || !strings.Contains(rent["quote"].(string), "950 euros") {
		t.Errorf("the found item: %v", rent)
	}
	counts := first.JSON()["counts"].(map[string]any)
	if counts["found"].(float64) != 1 || counts["unclear"].(float64) != 1 || counts["missing"].(float64) != 1 {
		t.Errorf("counts: %v", counts)
	}
	unusual := first.JSON()["unusual"].([]any)
	if len(unusual) != 1 || unusual[0].(map[string]any)["quote"] != "renews automatically" || first.JSON()["unusualChecked"] != true {
		t.Errorf("unusual: %s", first.Body)
	}
	if sent, _ := a.ai.lastChecklist.Load().([]byte); !strings.Contains(string(sent), `"kind":"lease"`) || !strings.Contains(string(sent), "950 euros") {
		t.Errorf("the saved text and the kind were sent: %s", sent)
	}

	again := cl.post(checklistPath(id), checkBody("lease"))
	if again.Status != http.StatusOK || again.JSON()["cached"] != true || len(again.JSON()["items"].([]any)) != 3 {
		t.Errorf("shown again: %s", again.Body)
	}
	if n := a.ai.checklistCalls.Load(); n != 1 {
		t.Errorf("the model was asked once: %d", n)
	}
	other := cl.post(checklistPath(id), checkBody("nda"))
	if other.Status != http.StatusOK || other.JSON()["cached"] != false || other.JSON()["kind"] != "nda" {
		t.Errorf("another kind is its own checklist: %d %s", other.Status, other.Body)
	}
	if n := a.ai.checklistCalls.Load(); n != 2 {
		t.Errorf("two kinds, two calls: %d", n)
	}
	if n := count(t, a.db, "SELECT COALESCE(SUM(chats),0) FROM daily_usage"); n != 2 {
		t.Errorf("each new checklist is one chat question, a replay none: %d", n)
	}

	if r := cl.post(checklistPath(id), map[string]any{"kind": "lease", "regenerate": true}); r.Status != http.StatusTooManyRequests {
		t.Errorf("a new one needs allowance, and there is none left: %d", r.Status)
	}
	if replay := cl.post(checklistPath(id), checkBody("lease")); replay.Status != http.StatusOK || replay.JSON()["cached"] != true {
		t.Errorf("but the old ones are still shown: %d %s", replay.Status, replay.Body)
	}
}

func TestAChecklistCanBeMadeAgain(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Some contract words.")
	cl.post(checklistPath(id), checkBody("lease"))
	r := cl.post(checklistPath(id), map[string]any{"kind": "lease", "regenerate": true, "language": "German"})
	if r.Status != http.StatusOK || r.JSON()["cached"] != false || a.ai.checklistCalls.Load() != 2 {
		t.Fatalf("again: %d %s", r.Status, r.Body)
	}
	if sent, _ := a.ai.lastChecklist.Load().([]byte); !strings.Contains(string(sent), `"language":"German"`) {
		t.Errorf("the language was sent: %s", sent)
	}
}

func TestWhatTheAIServiceSendsForAChecklistIsCleaned(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Words.")
	long := strings.Repeat("x", 900)
	a.ai.checklistReply.Store(`{"kind":"lease","items":[` +
		`{"id":"rent","status":"found","value":"  950 euros ","quote":"` + long + `","page":0,"reason":""},` +
		`{"id":"rent","status":"found","value":"again","quote":"q","page":1,"reason":""},` +
		`{"id":"Bad Id","status":"found","value":"v","quote":"q","page":1,"reason":""},` +
		`{"id":"deposit","status":"perhaps","value":"v","quote":"q","page":1,"reason":""},` +
		`{"id":"pets","status":"missing","value":"leftover","quote":"leftover","page":3,"reason":"leftover"}` +
		`],"counts":{"found":99,"unclear":0,"missing":0},"unusual":[` +
		`{"what":"  Something odd ","quote":"odd words","page":-2},{"what":"","quote":"q","page":1},{"what":"w","quote":"","page":1}],` +
		`"unusualChecked":true,"suspicious":true}`)
	r := cl.post(checklistPath(id), checkBody("lease"))
	if r.Status != http.StatusOK {
		t.Fatalf("checklist: %d %s", r.Status, r.Body)
	}
	items := r.JSON()["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("a repeated id, a bad id and a bad status are dropped: %s", r.Body)
	}
	rent := items[0].(map[string]any)
	if rent["value"] != "950 euros" || len([]rune(rent["quote"].(string))) > 300 || rent["page"] != nil {
		t.Errorf("tidied: %v", rent)
	}
	pets := items[1].(map[string]any)
	if pets["value"] != "" || pets["quote"] != "" || pets["reason"] != "" || pets["page"] != nil {
		t.Errorf("a missing item has nothing attached: %v", pets)
	}
	counts := r.JSON()["counts"].(map[string]any)
	if counts["found"].(float64) != 1 || counts["missing"].(float64) != 1 {
		t.Errorf("the gateway counts for itself: %v", counts)
	}
	unusual := r.JSON()["unusual"].([]any)
	if len(unusual) != 1 || unusual[0].(map[string]any)["what"] != "Something odd" || unusual[0].(map[string]any)["page"] != nil {
		t.Errorf("unusual: %v", unusual)
	}
	if r.JSON()["suspicious"] != true {
		t.Errorf("the warning about instructions is passed on: %s", r.Body)
	}
}

func TestAnEmptyOrUnreadableChecklistIsRefusedAndCostsNothing(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Words.")
	a.ai.checklistReply.Store(`{"kind":"lease","items":[],"counts":{},"unusual":[]}`)
	if r := cl.post(checklistPath(id), checkBody("lease")); r.Status != http.StatusBadGateway {
		t.Errorf("empty: %d %s", r.Status, r.Body)
	}
	a.ai.checklistReply.Store(`not json`)
	if r := cl.post(checklistPath(id), checkBody("lease")); r.Status != http.StatusBadGateway {
		t.Errorf("unreadable: %d %s", r.Status, r.Body)
	}
	a.ai.checklistReply.Store("")
	a.ai.fail.Store(true)
	if r := cl.post(checklistPath(id), checkBody("lease")); r.Status < 500 {
		t.Errorf("a failing AI service: %d", r.Status)
	}
	a.ai.fail.Store(false)
	if n := count(t, a.db, "SELECT COALESCE(SUM(chats),0) FROM daily_usage"); n != 0 {
		t.Errorf("nothing was charged: %d", n)
	}
	if n := count(t, a.db, "SELECT count(*) FROM documents WHERE checks IS NOT NULL"); n != 0 {
		t.Errorf("nothing was kept: %d", n)
	}
}

func TestChecklistRequestsAreValidatedAndStayWithTheOwner(t *testing.T) {
	a := newApp(t)
	alice, _ := a.newUser()
	bob, _ := a.newUser()
	id := saveText(t, alice, "Alice's contract.")
	for name, body := range map[string]map[string]any{
		"no kind":      {},
		"unknown kind": {"kind": "mortgage"},
		"bad language": {"kind": "lease", "language": "Klingon"},
	} {
		if r := alice.post(checklistPath(id), body); r.Status != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, r.Status, r.Body)
		}
	}
	if r := bob.post(checklistPath(id), checkBody("lease")); r.Status != http.StatusNotFound {
		t.Errorf("another person's document: %d", r.Status)
	}
	a.db.Exec("UPDATE documents SET has_content = false, content = '' WHERE id = ?", id)
	if r := alice.post(checklistPath(id), checkBody("lease")); r.Status != http.StatusConflict {
		t.Errorf("no saved text: %d %s", r.Status, r.Body)
	}
	if a.ai.checklistCalls.Load() != 0 {
		t.Error("the model was not asked")
	}
	if r := a.newClient().post(checklistPath(id), checkBody("lease")); r.Status != http.StatusUnauthorized {
		t.Errorf("signed out: %d", r.Status)
	}
}

func TestRewritingTheSummaryKeepsTheChecklists(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "The tenant pays 950 euros per month.")
	cl.post(checklistPath(id), checkBody("lease"))
	if r := cl.post(docPath(id, "/rewrite"), map[string]any{"style": "bullets"}); r.Status != http.StatusOK {
		t.Fatalf("rewrite: %d %s", r.Status, r.Body)
	}
	if n := count(t, a.db, "SELECT count(*) FROM documents WHERE checks IS NOT NULL"); n != 1 {
		t.Errorf("a checklist comes from the text, not the summary: %d", n)
	}
}
