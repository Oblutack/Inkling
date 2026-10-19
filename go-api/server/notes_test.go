package server

import (
	"net/http"
	"strings"
	"testing"
)

// Notes for other apps (Obsidian, Notion): the saved summaries with tags, dates, source page and flashcards.

func TestTheLibraryAsNotesHoldSummariesTagsFlashcardsAndTheSourcePage(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	plain := saveText(t, cl, "Some pasted words about heat pumps and their costs.")
	tagDoc(t, cl, plain, "energy", "home")
	cl.post(docPath(plain, "/study"), map[string]string{"kind": "flashcards"})
	saved, _ := saveForLater(t, cl, map[string]any{"url": "https://blog.example/post"})

	r := cl.get("/library/notes")
	if r.Status != http.StatusOK {
		t.Fatalf("notes: %d %s", r.Status, r.Body)
	}
	notes := r.JSON()["notes"].([]any)
	if len(notes) != 2 || r.JSON()["truncated"] != false {
		t.Fatalf("two notes, oldest first: %s", r.Body)
	}
	first := notes[0].(map[string]any)
	if int(first["id"].(float64)) != plain || first["summary"] == "" || first["createdAt"] == "" {
		t.Errorf("the first note: %v", first)
	}
	tags := first["tags"].([]any)
	if len(tags) != 2 || tags[0] != "energy" {
		t.Errorf("tags: %v", tags)
	}
	cards := first["flashcards"].([]any)
	if len(cards) != 3 || cards[0].(map[string]any)["front"] != "Front one" || cards[0].(map[string]any)["back"] != "Back one" {
		t.Errorf("flashcards: %v", cards)
	}
	second := notes[1].(map[string]any)
	if int(second["id"].(float64)) != saved || second["url"] != "https://blog.example/post" {
		t.Errorf("a saved page keeps the address it came from: %v", second)
	}
	if len(second["flashcards"].([]any)) != 0 || len(second["tags"].([]any)) != 0 {
		t.Errorf("empty lists, not null: %v", second)
	}
	for key := range first {
		if !strings.Contains(" id title createdAt tags summary url flashcards highlights ", " "+key+" ") {
			t.Errorf("the source text is not part of a note, and %q is not a field of one", key)
		}
	}
}

func TestOneNoteAndWhoMayReadIt(t *testing.T) {
	a := newApp(t)
	alice, _ := a.newUser()
	bob, _ := a.newUser()
	id := saveText(t, alice, "Alice's words.")
	tagDoc(t, alice, id, "mine")

	r := alice.get(docPath(id, "/note"))
	if r.Status != http.StatusOK || r.JSON()["tags"].([]any)[0] != "mine" || int(r.JSON()["id"].(float64)) != id {
		t.Fatalf("her note: %d %s", r.Status, r.Body)
	}
	if r := bob.get(docPath(id, "/note")); r.Status != http.StatusNotFound {
		t.Errorf("another person's note: %d", r.Status)
	}
	if notes := bob.get("/library/notes").JSON()["notes"].([]any); len(notes) != 0 {
		t.Errorf("Bob's library is empty: %v", notes)
	}
	if r := a.newClient().get("/library/notes"); r.Status != http.StatusUnauthorized {
		t.Errorf("signed out: %d", r.Status)
	}
	if r := alice.get("/documents/999999/note"); r.Status != http.StatusNotFound {
		t.Errorf("no such document: %d", r.Status)
	}
}

func TestADeletedDocumentIsNotInTheNotes(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	keep := saveText(t, cl, "Keep this one.")
	gone := saveText(t, cl, "Delete this one.")
	cl.delete(docPath(gone, ""), nil)
	notes := cl.get("/library/notes").JSON()["notes"].([]any)
	if len(notes) != 1 || int(notes[0].(map[string]any)["id"].(float64)) != keep {
		t.Errorf("only what is kept: %v", notes)
	}
	if r := cl.get(docPath(gone, "/note")); r.Status != http.StatusNotFound {
		t.Errorf("a deleted note: %d", r.Status)
	}
}
