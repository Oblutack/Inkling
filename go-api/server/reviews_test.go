package server

import (
	"net/http"
	"testing"
	"time"

	"ai-summarizer/go-api/reviews"
)

// Spaced repetition over the real routes. The fake AI service makes the cards "Front one", "Front two" and "Front three".

func today() string { return reviews.Today(time.Now(), time.UTC) }

func plusDays(day string, n int) string {
	t, _ := time.Parse("2006-01-02", day)
	return t.AddDate(0, 0, n).Format("2006-01-02")
}

func rate(cl *client, id int, front string, knew bool) reply {
	return cl.post(docPath(id, "/cards/review"), map[string]any{"front": front, "knew": knew})
}

func TestRatingCardsMovesThemBetweenBoxesAndSaysWhenTheyAreDue(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := createStudySet(t, cl, "Cell biology notes.")
	day := today()

	known := rate(cl, id, "Front one", true)
	if known.Status != http.StatusOK || known.JSON()["box"] != float64(2) || known.JSON()["dueOn"] != plusDays(day, 2) {
		t.Fatalf("a known card: %d %s", known.Status, known.Body)
	}
	missed := rate(cl, id, "Front two", false)
	if missed.JSON()["box"] != float64(1) || missed.JSON()["dueOn"] != day {
		t.Fatalf("a missed card is due again today: %s", missed.Body)
	}
	again := rate(cl, id, "Front one", true)
	if again.JSON()["box"] != float64(3) || again.JSON()["dueOn"] != plusDays(day, 4) {
		t.Errorf("known twice: %s", again.Body)
	}

	progress := cl.get(docPath(id, "/cards/progress"))
	cards, _ := progress.JSON()["cards"].([]any)
	if progress.Status != http.StatusOK || len(cards) != 2 {
		t.Fatalf("progress lists only what was rated: %s", progress.Body)
	}
	for _, c := range cards {
		card := c.(map[string]any)
		if card["front"] == "Front two" && card["due"] != true {
			t.Errorf("the missed card is due: %v", card)
		}
		if card["front"] == "Front one" && card["due"] != false {
			t.Errorf("the known card is not: %v", card)
		}
	}

	due := cl.get("/study/due")
	list, _ := due.JSON()["cards"].([]any)
	if due.Status != http.StatusOK || len(list) != 1 || due.JSON()["total"] != float64(1) {
		t.Fatalf("one card is due: %s", due.Body)
	}
	card := list[0].(map[string]any)
	if card["front"] != "Front two" || card["back"] != "Back two" || card["title"] != "Cell biology notes" || card["documentId"] != float64(id) {
		t.Errorf("the due card: %v", card)
	}

	stats := cl.get("/study/stats").JSON()
	if stats["dueToday"] != float64(1) || stats["reviewedToday"] != float64(3) || stats["streak"] != float64(1) || stats["totalReviews"] != float64(3) {
		t.Errorf("stats: %v", stats)
	}
}

func TestOnlyAValidRatingOfYourOwnCardIsAccepted(t *testing.T) {
	a := newApp(t)
	alice, _ := a.newUser()
	bob, _ := a.newUser()
	id, _ := createStudySet(t, alice, "Alice's notes.")

	if r := rate(alice, id, "A card that is not in the set", true); r.Status != http.StatusNotFound {
		t.Errorf("an unknown card: %d", r.Status)
	}
	if r := alice.post(docPath(id, "/cards/review"), map[string]any{"front": "Front one"}); r.Status != http.StatusBadRequest {
		t.Errorf("knew or not is needed: %d", r.Status)
	}
	if r := alice.post(docPath(id, "/cards/review"), map[string]any{"knew": true}); r.Status != http.StatusBadRequest {
		t.Errorf("which card is needed: %d", r.Status)
	}
	if r := rate(bob, id, "Front one", true); r.Status != http.StatusNotFound {
		t.Errorf("another person's set: %d", r.Status)
	}
	if r := bob.get(docPath(id, "/cards/progress")); r.Status != http.StatusNotFound {
		t.Errorf("another person's progress: %d", r.Status)
	}
	if r := rate(a.newClient(), id, "Front one", true); r.Status != http.StatusUnauthorized {
		t.Errorf("signed out: %d", r.Status)
	}
	for _, path := range []string{"/study/due", "/study/stats"} {
		if r := a.newClient().get(path); r.Status != http.StatusUnauthorized {
			t.Errorf("%s signed out: %d", path, r.Status)
		}
	}
	// And what bob sees of the review is his own: nothing.
	if due := bob.get("/study/due").JSON(); due["total"] != float64(0) {
		t.Errorf("bob has nothing due: %v", due)
	}
	if n := count(t, a.db, "SELECT count(*) FROM card_reviews"); n != 0 {
		t.Errorf("nothing was recorded: %d", n)
	}
}

func TestADueDayIsTheCalendarDayInThePersonsOwnZone(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := createStudySet(t, cl, "Notes.")
	if r := cl.put("/account/email-preferences", map[string]any{"timeZone": "Pacific/Kiritimati"}); r.Status != http.StatusOK {
		t.Fatalf("zone: %d %s", r.Status, r.Body)
	}
	loc, _ := time.LoadLocation("Pacific/Kiritimati")
	r := rate(cl, id, "Front one", false)
	if want := reviews.Today(time.Now(), loc); r.JSON()["dueOn"] != want {
		t.Errorf("due %v, want their today %s", r.JSON()["dueOn"], want)
	}
}

func TestProgressOnCardsThatAreGoneIsDropped(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := createStudySet(t, cl, "Notes.")
	rate(cl, id, "Front one", false)
	rate(cl, id, "Front two", false)
	// The cards are replaced by others.
	if err := a.db.Exec(`UPDATE documents SET study = '{"flashcards":[{"front":"Brand new","back":"x"},{"front":"Front two","back":"2"},{"front":"Third","back":"3"}]}'::jsonb WHERE id = ?`, id).Error; err != nil {
		t.Fatal(err)
	}
	due := cl.get("/study/due").JSON()
	list, _ := due["cards"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["front"] != "Front two" {
		t.Errorf("only the card that is still there is due: %v", due)
	}
	if n := count(t, a.db, "SELECT count(*) FROM card_reviews"); n != 1 {
		t.Errorf("the row of the card that is gone was removed: %d", n)
	}
}

func TestNewCardsReplacingOldOnesTakeTheirProgressAwayAndASummaryDoes(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Some words about cells.")
	if r := cl.post(docPath(id, "/study"), map[string]string{"kind": "flashcards"}); r.Status != http.StatusOK {
		t.Fatalf("cards: %d", r.Status)
	}
	rate(cl, id, "Front one", true)
	rate(cl, id, "Front two", true)
	if n := count(t, a.db, "SELECT count(*) FROM card_reviews"); n != 2 {
		t.Fatalf("setup: %d", n)
	}
	// Writing the summary again drops the study material made from the old one, and the progress with it.
	if r := cl.post(docPath(id, "/rewrite"), map[string]any{"style": "brief"}); r.Status != http.StatusOK {
		t.Fatalf("rewrite: %d", r.Status)
	}
	if n := count(t, a.db, "SELECT count(*) FROM card_reviews"); n != 0 {
		t.Errorf("progress goes with the cards it was about: %d", n)
	}
}

func TestSummarizingAStudySetDoesNotCostItsProgress(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := createStudySet(t, cl, "Some notes about leases.")
	rate(cl, id, "Front one", true)
	if r := cl.post(docPath(id, "/rewrite"), map[string]any{"style": "brief"}); r.Status != http.StatusOK {
		t.Fatalf("rewrite: %d", r.Status)
	}
	if n := count(t, a.db, "SELECT count(*) FROM card_reviews"); n != 1 {
		t.Errorf("the cards of a study set were made from its text, so they and their progress stay: %d", n)
	}
}

func TestDeletingADocumentRemovesItsProgressFromTheReview(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := createStudySet(t, cl, "Notes.")
	rate(cl, id, "Front one", false)
	if r := cl.delete(docPath(id, ""), nil); r.Status != http.StatusOK {
		t.Fatalf("delete: %d", r.Status)
	}
	if n := count(t, a.db, "SELECT count(*) FROM card_reviews"); n != 0 {
		t.Errorf("rows left behind: %d", n)
	}
	if due := cl.get("/study/due").JSON(); due["total"] != float64(0) {
		t.Errorf("nothing is due from a deleted set: %v", due)
	}
}

func TestStudyProgressIsPartOfTheDataExport(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := createStudySet(t, cl, "Notes.")
	rate(cl, id, "Front one", true)
	rate(cl, id, "Front two", false)
	cl.put("/account/email-preferences", map[string]any{"reminders": true})

	export := cl.get("/account/export").JSON()
	progress, _ := export["studyProgress"].(map[string]any)
	cards, _ := progress["cards"].([]any)
	days, _ := progress["days"].([]any)
	if len(cards) != 2 || len(days) != 1 || days[0].(map[string]any)["count"] != float64(2) {
		t.Errorf("study progress: %v", progress)
	}
	if prefs, _ := export["emailPreferences"].(map[string]any); prefs["reminders"] != true {
		t.Errorf("email preferences: %v", export["emailPreferences"])
	}
}
