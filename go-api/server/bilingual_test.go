package server

import (
	"net/http"
	"strings"
	"testing"
)

// A summary in two languages: its lines with their translation, and the key words.

func bilingualPath(id int) string { return docPath(id, "/bilingual") }

func TestATranslationIsMadeOnceForEachLanguageKeptAndShownAgainForFree(t *testing.T) {
	a := newApp(t)
	t.Setenv("QUOTA_CHAT_PER_DAY", "2")
	cl, _ := a.newUser()
	id := saveText(t, cl, "Some contract words.")

	first := cl.post(bilingualPath(id), map[string]any{"language": "German"})
	if first.Status != http.StatusOK || first.JSON()["cached"] != false || first.JSON()["language"] != "German" {
		t.Fatalf("translating: %d %s", first.Status, first.Body)
	}
	rows := first.JSON()["rows"].([]any)
	if len(rows) != 3 || first.JSON()["missing"].(float64) != 1 {
		t.Fatalf("rows: %s", first.Body)
	}
	notice := rows[1].(map[string]any)
	if notice["kind"] != "bullet" || notice["source"] != "Notice is 60 days." || notice["figuresKept"] != false {
		t.Errorf("a line whose figure changed is marked: %v", notice)
	}
	if rows[2].(map[string]any)["target"] != "" || rows[2].(map[string]any)["figuresKept"] != true {
		t.Errorf("a line that did not come back is empty, not invented: %v", rows[2])
	}
	vocab := first.JSON()["vocabulary"].([]any)
	if len(vocab) != 1 || vocab[0].(map[string]any)["translation"] != "Kündigung" {
		t.Errorf("vocabulary: %v", vocab)
	}
	if sent, _ := a.ai.lastBilingual.Load().([]byte); !strings.Contains(string(sent), `"language":"German"`) || !strings.Contains(string(sent), "fake summary") {
		t.Errorf("the saved summary was sent: %s", sent)
	}

	again := cl.post(bilingualPath(id), map[string]any{"language": "German"})
	if again.Status != http.StatusOK || again.JSON()["cached"] != true || len(again.JSON()["rows"].([]any)) != 3 {
		t.Errorf("shown again: %s", again.Body)
	}
	other := cl.post(bilingualPath(id), map[string]any{"language": "French"})
	if other.Status != http.StatusOK || other.JSON()["cached"] != false || other.JSON()["language"] != "French" {
		t.Errorf("another language is its own: %d %s", other.Status, other.Body)
	}
	if a.ai.bilingualCalls.Load() != 2 {
		t.Errorf("two languages, two calls: %d", a.ai.bilingualCalls.Load())
	}
	if n := count(t, a.db, "SELECT COALESCE(SUM(chats),0) FROM daily_usage"); n != 2 {
		t.Errorf("each new one is a chat question, a replay none: %d", n)
	}
	if r := cl.post(bilingualPath(id), map[string]any{"language": "Italian"}); r.Status != http.StatusTooManyRequests {
		t.Errorf("no allowance left for a new one: %d", r.Status)
	}
	if r := cl.post(bilingualPath(id), map[string]any{"language": "German"}); r.Status != http.StatusOK || r.JSON()["cached"] != true {
		t.Errorf("but the old ones are still shown: %d", r.Status)
	}
}

func TestANewSummaryTakesTheTranslationAway(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Some contract words.")
	cl.post(bilingualPath(id), map[string]any{"language": "German"})
	if n := count(t, a.db, "SELECT count(*) FROM documents WHERE bilingual IS NOT NULL"); n != 1 {
		t.Fatalf("setup: %d", n)
	}
	if r := cl.post(docPath(id, "/rewrite"), map[string]any{"style": "bullets"}); r.Status != http.StatusOK {
		t.Fatalf("rewrite: %d %s", r.Status, r.Body)
	}
	if n := count(t, a.db, "SELECT count(*) FROM documents WHERE bilingual IS NOT NULL"); n != 0 {
		t.Errorf("a translation belongs to the old summary: %d", n)
	}
}

func TestWhatTheAIServiceSendsForATranslationIsCleaned(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Words.")
	a.ai.bilingualReply.Store(`{"rows":[` +
		`{"kind":"weird","source":"  Rent ","target":" Miete ","figuresKept":true},` +
		`{"kind":"bullet","source":"","target":"no source","figuresKept":true}],` +
		`"vocabulary":[{"word":" rent ","translation":" Miete "},{"word":"","translation":"x"},{"word":"y","translation":""}],"missing":9}`)
	r := cl.post(bilingualPath(id), map[string]any{"language": "German"})
	if r.Status != http.StatusOK {
		t.Fatalf("translate: %d %s", r.Status, r.Body)
	}
	rows := r.JSON()["rows"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["kind"] != "paragraph" || rows[0].(map[string]any)["source"] != "Rent" {
		t.Errorf("tidied rows: %s", r.Body)
	}
	if r.JSON()["missing"].(float64) != 0 {
		t.Errorf("the gateway counts the missing lines itself: %s", r.Body)
	}
	if v := r.JSON()["vocabulary"].([]any); len(v) != 1 || v[0].(map[string]any)["word"] != "rent" {
		t.Errorf("vocabulary: %v", v)
	}
}

func TestATranslationWithNothingInItIsRefusedAndCostsNothing(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Words.")
	a.ai.bilingualReply.Store(`{"rows":[{"kind":"paragraph","source":"Rent","target":"","figuresKept":true}],"vocabulary":[],"missing":1}`)
	if r := cl.post(bilingualPath(id), map[string]any{"language": "German"}); r.Status != http.StatusBadGateway {
		t.Errorf("nothing translated: %d %s", r.Status, r.Body)
	}
	a.ai.bilingualReply.Store("")
	a.ai.fail.Store(true)
	if r := cl.post(bilingualPath(id), map[string]any{"language": "German"}); r.Status < 500 {
		t.Errorf("a failing AI service: %d", r.Status)
	}
	a.ai.fail.Store(false)
	if n := count(t, a.db, "SELECT COALESCE(SUM(chats),0) FROM daily_usage"); n != 0 {
		t.Errorf("nothing was charged: %d", n)
	}
}

func TestATranslationIsValidatedPrivateAndNeedsASummary(t *testing.T) {
	a := newApp(t)
	alice, _ := a.newUser()
	bob, _ := a.newUser()
	id := saveText(t, alice, "Alice's words.")
	for name, body := range map[string]map[string]any{
		"no language":      {},
		"unknown language": {"language": "Klingon"},
		"same as the text": {"language": "Same as the text"},
	} {
		if r := alice.post(bilingualPath(id), body); r.Status != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, r.Status, r.Body)
		}
	}
	if r := bob.post(bilingualPath(id), map[string]any{"language": "German"}); r.Status != http.StatusNotFound {
		t.Errorf("another person's document: %d", r.Status)
	}
	a.db.Exec("UPDATE documents SET summary = '' WHERE id = ?", id)
	if r := alice.post(bilingualPath(id), map[string]any{"language": "German"}); r.Status != http.StatusConflict {
		t.Errorf("a study set has no summary to translate: %d", r.Status)
	}
	if a.ai.bilingualCalls.Load() != 0 {
		t.Error("the model was not asked")
	}
}
