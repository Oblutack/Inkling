package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// Study sets: a document read only to be studied. No summary is made for it; the flashcards are, and the document is
// saved with them.

func createStudySet(t *testing.T, cl *client, text string) (id int, r reply) {
	t.Helper()
	r = cl.post("/study-sets/text", map[string]string{"text": text})
	if r.Status != http.StatusCreated {
		t.Fatalf("study set: %d %s", r.Status, r.Body)
	}
	return int(r.JSON()["id"].(float64)), r
}

func lastStudyRequest(t *testing.T, a *app) map[string]any {
	t.Helper()
	raw, _ := a.ai.lastStudy.Load().([]byte)
	var sent map[string]any
	if err := json.Unmarshal(raw, &sent); err != nil {
		t.Fatalf("the last study request: %v (%q)", err, raw)
	}
	return sent
}

func summariesUsed(t *testing.T, a *app) int {
	t.Helper()
	return count(t, a.db, "SELECT COALESCE(SUM(summaries),0) FROM daily_usage")
}

func TestAStudySetFromTextHasFlashcardsAndNoSummary(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	text := "# Cells\nCells are the basic unit of life."
	id, r := createStudySet(t, cl, text)

	body := r.JSON()
	if body["title"] != "Cells" || body["kind"] != "flashcards" || body["cached"] != false || len(body["cards"].([]any)) != 3 {
		t.Errorf("the reply: %s", r.Body)
	}
	docs := listedDocuments(t, cl)
	if len(docs) != 1 || docs[0]["Summary"] != "" || docs[0]["hasContent"] != true || docs[0]["Filename"] != "Cells" {
		t.Errorf("the document is saved with its text and no summary: %v", docs)
	}
	if n := count(t, a.db, "SELECT count(*) FROM documents WHERE id = ? AND study->'flashcards' IS NOT NULL", id); n != 1 {
		t.Errorf("the flashcards are kept with the document: %d", n)
	}
	if sent, _ := a.ai.lastSummary.Load().(string); sent != "" {
		t.Errorf("no summary was asked for: %q", sent)
	}
	study := lastStudyRequest(t, a)
	if study["summary"] != "" || study["text"] != text || study["kind"] != "flashcards" {
		t.Errorf("the model was given the text itself: %v", study)
	}
	if n := summariesUsed(t, a); n != 1 {
		t.Errorf("one use of the daily allowance, got %d", n)
	}
	if n := a.ai.studyCalls.Load(); n != 1 {
		t.Errorf("one model call, got %d", n)
	}

	// The cards are replayed for free, and a quiz can be made from the same text.
	again := cl.post(docPath(id, "/study"), map[string]string{"kind": "flashcards"})
	if again.Status != http.StatusOK || again.JSON()["cached"] != true || a.ai.studyCalls.Load() != 1 {
		t.Errorf("replay: %d %s", again.Status, again.Body)
	}
	quiz := cl.post(docPath(id, "/study"), map[string]string{"kind": "quiz"})
	if quiz.Status != http.StatusOK || len(quiz.JSON()["questions"].([]any)) != 3 {
		t.Errorf("a quiz from the text alone: %d %s", quiz.Status, quiz.Body)
	}
	if n := count(t, a.db, "SELECT count(*) FROM documents WHERE study->'flashcards' IS NOT NULL AND study->'quiz' IS NOT NULL"); n != 1 {
		t.Errorf("both kinds are kept side by side: %d", n)
	}
}

func TestALongTextIsStudiedThroughASummaryInItsOwnLanguage(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	long := "Chapter one.\n" + strings.Repeat("A long sentence about the subject. ", 500)
	id, _ := createStudySet(t, cl, long)

	if sent, _ := a.ai.lastSummary.Load().(string); !strings.Contains(sent, "language=Same+as+the+text") {
		t.Errorf("the summary is written in the language of the text: %q", sent)
	}
	study := lastStudyRequest(t, a)
	summary, _ := study["summary"].(string)
	if !strings.HasPrefix(summary, "fake summary") || study["text"] != "" {
		t.Errorf("a long text is given to the model through its summary: %v", study)
	}
	docs := listedDocuments(t, cl)
	if got, _ := docs[0]["Summary"].(string); got != summary {
		t.Errorf("the summary is kept with the document: %q", got)
	}
	if n := summariesUsed(t, a); n != 1 {
		t.Errorf("the summary and the cards are one use of the allowance, got %d", n)
	}
	// The quiz is made from the same summary, with the same rule.
	if r := cl.post(docPath(id, "/study"), map[string]string{"kind": "quiz"}); r.Status != http.StatusOK {
		t.Errorf("quiz: %d %s", r.Status, r.Body)
	}
}

func TestAStudySetFromALinkAndFromFiles(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()

	r := cl.post("/study-sets/url", map[string]string{"url": "https://example.com/post"})
	if r.Status != http.StatusCreated || r.JSON()["title"] != "Fake Page Title" {
		t.Fatalf("link: %d %s", r.Status, r.Body)
	}
	if r := cl.post("/study-sets/url", map[string]string{"url": "ftp://example.com/post"}); r.Status != http.StatusBadRequest {
		t.Errorf("only web addresses: %d", r.Status)
	}
	if r := cl.post("/study-sets/url", map[string]string{"url": " "}); r.Status != http.StatusBadRequest {
		t.Errorf("an address is needed: %d", r.Status)
	}

	f := cl.upload("/study-sets/files", "files", map[string][]byte{"notes.pdf": []byte("%PDF-1.4 notes")})
	if f.Status != http.StatusCreated || f.JSON()["title"] != "notes.pdf" || len(f.JSON()["cards"].([]any)) != 3 {
		t.Fatalf("files: %d %s", f.Status, f.Body)
	}
	if n := count(t, a.db, "SELECT count(*) FROM document_files"); n != 1 {
		t.Errorf("the original PDF is kept for the viewer: %d", n)
	}
	if r := cl.upload("/study-sets/files", "files", map[string][]byte{"setup.exe": []byte("MZ")}); r.Status != http.StatusBadRequest {
		t.Errorf("only documents: %d", r.Status)
	}
	if r := cl.post("/study-sets/text", map[string]string{"text": "  "}); r.Status != http.StatusBadRequest {
		t.Errorf("text is needed: %d", r.Status)
	}
	if n := summariesUsed(t, a); n != 2 {
		t.Errorf("only the two that worked are counted, got %d", n)
	}
	if n := count(t, a.db, "SELECT count(*) FROM documents"); n != 2 {
		t.Errorf("two study sets were saved, got %d", n)
	}
}

func TestStudySetsNeedAnAccountAndAFailureCostsNothing(t *testing.T) {
	a := newApp(t)
	if r := a.newClient().post("/study-sets/text", map[string]string{"text": "Some notes."}); r.Status != http.StatusUnauthorized {
		t.Errorf("signed out: %d", r.Status)
	}
	cl, _ := a.newUser()
	a.ai.fail.Store(true)
	if r := cl.post("/study-sets/text", map[string]string{"text": "Some notes."}); r.Status < 500 {
		t.Errorf("a failing AI service: %d", r.Status)
	}
	if n := summariesUsed(t, a); n != 0 {
		t.Errorf("a failure is not charged, got %d", n)
	}
	if n := count(t, a.db, "SELECT count(*) FROM documents"); n != 0 {
		t.Errorf("and nothing is saved, got %d", n)
	}
}

func TestStudySetsUseTheDailyAllowanceOfSummaries(t *testing.T) {
	a := newApp(t)
	t.Setenv("QUOTA_SUMMARIES_PER_DAY", "1")
	cl, _ := a.newUser()
	createStudySet(t, cl, "First notes.")
	if r := cl.post("/study-sets/text", map[string]string{"text": "Second notes."}); r.Status != http.StatusTooManyRequests {
		t.Errorf("the allowance is used up: %d", r.Status)
	}
}

func TestWhatNeedsASummaryRefusesAStudySetAndChatAndStudyStillWork(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := createStudySet(t, cl, "Some notes about leases.")

	if r := cl.post(docPath(id, "/share"), nil); r.Status != http.StatusConflict {
		t.Errorf("sharing needs a summary: %d %s", r.Status, r.Body)
	}
	if r := cl.post(docPath(id, "/email"), map[string]string{}); r.Status != http.StatusConflict {
		t.Errorf("emailing needs a summary: %d %s", r.Status, r.Body)
	}
	if r := cl.post(docPath(id, "/podcast"), map[string]string{}); r.Status != http.StatusConflict {
		t.Errorf("a podcast needs a summary: %d %s", r.Status, r.Body)
	}
	if r := cl.post(docPath(id, "/proof"), nil); r.Status < 400 || r.Status >= 500 {
		t.Errorf("the proof check needs a summary: %d %s", r.Status, r.Body)
	}
	if r := cl.post(docPath(id, "/chat"), map[string]any{"question": "What is this?"}); r.Status != http.StatusOK {
		t.Errorf("chat works on the text: %d %s", r.Status, r.Body)
	}
	if r := cl.post(docPath(id, "/suggestions"), nil); r.Status != http.StatusOK || a.ai.suggestCalls.Load() != 1 {
		t.Errorf("suggested questions work from the text: %d %s", r.Status, r.Body)
	}
}

func TestSummarizingAStudySetKeepsItsFlashcards(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := createStudySet(t, cl, "Some notes about leases.")

	r := cl.post(docPath(id, "/rewrite"), map[string]any{"style": "brief"})
	if r.Status != http.StatusOK {
		t.Fatalf("rewrite: %d %s", r.Status, r.Body)
	}
	docs := listedDocuments(t, cl)
	if got, _ := docs[0]["Summary"].(string); !strings.HasPrefix(got, "fake summary") {
		t.Errorf("it now has a summary: %q", got)
	}
	if n := count(t, a.db, "SELECT count(*) FROM documents WHERE id = ? AND study->'flashcards' IS NOT NULL", id); n != 1 {
		t.Errorf("the cards were made from the text, so they stay: %d", n)
	}
	// Once there is a summary, a new one drops what was made from the old one, as it always has.
	if r := cl.post(docPath(id, "/rewrite"), map[string]any{"style": "bullets"}); r.Status != http.StatusOK {
		t.Fatalf("second rewrite: %d", r.Status)
	}
	if n := count(t, a.db, "SELECT count(*) FROM documents WHERE id = ? AND study IS NULL", id); n != 1 {
		t.Errorf("study material of a summarized document goes with the old summary: %d", n)
	}
}

func TestAStudySetIsInTheLibraryButNotInAnOverview(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := createStudySet(t, cl, "Some notes about leases.")
	saveText(t, cl, "A second document with a summary.")
	other := listedDocuments(t, cl)[0]["ID"]
	for _, doc := range []any{float64(id), other} {
		if r := cl.put("/documents/"+itoa(int(doc.(float64))), map[string]any{"tags": []string{"course"}}); r.Status != http.StatusOK {
			t.Fatalf("tag: %d %s", r.Status, r.Body)
		}
	}
	// Only one of the two has a summary to write an overview from.
	if r := cl.post("/library/overview", map[string]string{"tag": "course"}); r.Status != http.StatusBadRequest {
		t.Errorf("an overview needs two documents with summaries: %d %s", r.Status, r.Body)
	}
}
