package server

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// Highlights and notes in the original PDF.

func highlightsPath(id int) string { return docPath(id, "/highlights") }

func makeHighlight(t *testing.T, cl *client, id int, body map[string]any) map[string]any {
	t.Helper()
	r := cl.post(highlightsPath(id), body)
	if r.Status != http.StatusCreated {
		t.Fatalf("highlight: %d %s", r.Status, r.Body)
	}
	return r.JSON()
}

func TestAPassageIsHighlightedWithANoteListedEditedAndRemoved(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "The notice period is sixty days.")

	first := makeHighlight(t, cl, id, map[string]any{"page": 3, "quote": "  notice period \n is sixty days ", "note": " ask about this "})
	if first["quote"] != "notice period is sixty days" || first["note"] != "ask about this" || first["page"].(float64) != 3 {
		t.Errorf("tidied: %v", first)
	}
	makeHighlight(t, cl, id, map[string]any{"page": 1, "quote": "The notice"})
	list := cl.get(highlightsPath(id)).JSON()["highlights"].([]any)
	if len(list) != 2 || list[0].(map[string]any)["page"].(float64) != 1 {
		t.Fatalf("listed in page order: %v", list)
	}
	hid := strconv.Itoa(int(first["id"].(float64)))
	r := cl.put("/highlights/"+hid, map[string]any{"note": "changed my mind"})
	if r.Status != http.StatusOK || r.JSON()["note"] != "changed my mind" || r.JSON()["quote"] != "notice period is sixty days" {
		t.Errorf("edit: %d %s", r.Status, r.Body)
	}
	if r := cl.delete("/highlights/"+hid, nil); r.Status != http.StatusOK {
		t.Errorf("remove: %d", r.Status)
	}
	if n := len(cl.get(highlightsPath(id)).JSON()["highlights"].([]any)); n != 1 {
		t.Errorf("one left: %d", n)
	}
	if r := cl.delete("/highlights/"+hid, nil); r.Status != http.StatusNotFound {
		t.Errorf("twice: %d", r.Status)
	}
}

func TestHighlightsAreCheckedAndPrivate(t *testing.T) {
	a := newApp(t)
	alice, _ := a.newUser()
	bob, _ := a.newUser()
	id := saveText(t, alice, "Alice's words.")
	for name, body := range map[string]map[string]any{
		"no page":      {"quote": "words"},
		"page zero":    {"page": 0, "quote": "words"},
		"no quote":     {"page": 1, "quote": " "},
		"a one-letter": {"page": 1, "quote": "a"},
		"too long":     {"page": 1, "quote": strings.Repeat("x", 1001)},
		"a long note":  {"page": 1, "quote": "words", "note": strings.Repeat("n", 2001)},
		"a stranger's": {"page": 1, "quote": "words", "fileId": 999999},
	} {
		if r := alice.post(highlightsPath(id), body); r.Status != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, r.Status, r.Body)
		}
	}
	h := makeHighlight(t, alice, id, map[string]any{"page": 1, "quote": "Alice's words"})
	hid := strconv.Itoa(int(h["id"].(float64)))
	if r := bob.post(highlightsPath(id), map[string]any{"page": 1, "quote": "Alice's words"}); r.Status != http.StatusNotFound {
		t.Errorf("a stranger's document: %d", r.Status)
	}
	if r := bob.get(highlightsPath(id)); r.Status != http.StatusNotFound {
		t.Errorf("a stranger's list: %d", r.Status)
	}
	if r := bob.put("/highlights/"+hid, map[string]any{"note": "mine now"}); r.Status != http.StatusNotFound {
		t.Errorf("a stranger's edit: %d", r.Status)
	}
	if r := bob.delete("/highlights/"+hid, nil); r.Status != http.StatusNotFound {
		t.Errorf("a stranger's delete: %d", r.Status)
	}
	if r := alice.put("/highlights/"+hid, map[string]any{}); r.Status != http.StatusBadRequest {
		t.Errorf("an edit with no note: %d", r.Status)
	}
	if r := a.newClient().get(highlightsPath(id)); r.Status != http.StatusUnauthorized {
		t.Errorf("signed out: %d", r.Status)
	}
}

func TestHighlightsGoWithTheDocumentAndTheAccount(t *testing.T) {
	a := newApp(t)
	cl, email := a.newUser()
	id := saveText(t, cl, "Words to mark.")
	makeHighlight(t, cl, id, map[string]any{"page": 1, "quote": "Words to mark"})
	cl.delete(docPath(id, ""), nil)
	if n := count(t, a.db, "SELECT count(*) FROM document_highlights"); n != 0 {
		t.Errorf("deleting the document removes its highlights: %d", n)
	}
	other := saveText(t, cl, "More words to mark.")
	makeHighlight(t, cl, other, map[string]any{"page": 1, "quote": "More words"})
	a.db.Exec("DELETE FROM users WHERE email = ?", email)
	if n := count(t, a.db, "SELECT count(*) FROM document_highlights"); n != 0 {
		t.Errorf("and the account: %d", n)
	}
}

func TestTheChatIsGivenTheReadersNotesAndTheLibrarySearchFindsThem(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Plain pasted words about leases.")
	makeHighlight(t, cl, id, map[string]any{"page": 2, "quote": "returned in 30 days", "note": "ask about interest on the deposit"})

	if r := cl.post(docPath(id, "/chat"), map[string]any{"question": "What did I note?", "history": []any{}}); r.Status != http.StatusOK {
		t.Fatalf("chat: %d %s", r.Status, r.Body)
	}
	sent, _ := a.ai.lastChat.Load().([]byte)
	if !strings.Contains(string(sent), `"notes":[`) || !strings.Contains(string(sent), "ask about interest on the deposit") || !strings.Contains(string(sent), "returned in 30 days") {
		t.Errorf("the notes were sent with the question: %s", sent)
	}

	found := cl.getDocs(t, "?q=interest")
	if len(found) != 1 || int(found[0]["ID"].(float64)) != id {
		t.Errorf("a note is searched with its document: %v", found)
	}
	if got := cl.getDocs(t, "?q=nothing-like-this"); len(got) != 0 {
		t.Errorf("and only then: %v", got)
	}
}

func TestHighlightsAreInTheNotesAndTheDataExport(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Plain pasted words about leases.")
	makeHighlight(t, cl, id, map[string]any{"page": 2, "quote": "returned in 30 days", "note": "ask about interest"})
	saveForLater(t, cl, map[string]any{"url": "https://blog.example/post"})
	cl.post("/exams/results", map[string]any{"documentIds": []int{id}, "questions": 3, "correct": 2, "seconds": 40, "breakdown": []any{}, "missed": []any{}})

	note := cl.get(docPath(id, "/note")).JSON()
	hs := note["highlights"].([]any)
	if len(hs) != 1 || hs[0].(map[string]any)["note"] != "ask about interest" {
		t.Errorf("the note has its highlights: %v", note)
	}
	notes := cl.get("/library/notes").JSON()["notes"].([]any)
	if len(notes[0].(map[string]any)["highlights"].([]any)) != 1 || len(notes[1].(map[string]any)["highlights"].([]any)) != 0 {
		t.Errorf("each note has its own: %v", notes)
	}

	export := cl.get("/account/export").JSON()
	for key, want := range map[string]int{"highlights": 1, "readingList": 1, "examResults": 1} {
		if got := len(export[key].([]any)); got != want {
			t.Errorf("the export holds %s: %d", key, got)
		}
	}
}
