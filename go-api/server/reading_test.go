package server

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"ai-summarizer/go-api/controllers"
	"ai-summarizer/go-api/jobs"
)

// The reading list and the weekly digest. The fake AI service answers a page with the title "Fake Page Title" and a summary
// that shows the options it was asked for.

func readingPath(id int) string { return "/reading-list/" + strconv.Itoa(id) }

func saveForLater(t *testing.T, cl *client, body map[string]any) (int, reply) {
	t.Helper()
	r := cl.post("/reading-list", body)
	if r.Status != http.StatusCreated {
		t.Fatalf("save: %d %s", r.Status, r.Body)
	}
	return int(r.JSON()["id"].(float64)), r
}

func listed(t *testing.T, cl *client, state string) []map[string]any {
	t.Helper()
	r := cl.get("/reading-list?state=" + state)
	if r.Status != http.StatusOK {
		t.Fatalf("list %s: %d %s", state, r.Status, r.Body)
	}
	var out []map[string]any
	for _, item := range r.JSON()["items"].([]any) {
		out = append(out, item.(map[string]any))
	}
	return out
}

func usedSummaries(t *testing.T, a *app) int {
	return count(t, a.db, "SELECT COALESCE(SUM(summaries),0) FROM daily_usage")
}

func TestAPageIsSavedForLaterWithAShortSummaryAndKeptInTheLibrary(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, r := saveForLater(t, cl, map[string]any{"url": "https://blog.example/post"})
	if r.JSON()["title"] != "Fake Page Title" || r.JSON()["alreadySaved"] != false {
		t.Errorf("reply: %s", r.Body)
	}
	if sent, _ := a.ai.lastSummary.Load().(string); !strings.Contains(sent, "style=glance") || !strings.Contains(sent, "word_count=60") {
		t.Errorf("a short summary is asked for: %q", sent)
	} else if !strings.Contains(sent, "skim_chars=12000") {
		t.Errorf("of the start of a long page only: %q", sent)
	}
	if docs := listedDocuments(t, cl); len(docs) != 1 || int(docs[0]["ID"].(float64)) != id {
		t.Errorf("it is in the library too: %v", docs)
	}
	items := listed(t, cl, "unread")
	if len(items) != 1 || items[0]["url"] != "https://blog.example/post" || items[0]["summary"] != "fake url summary" || items[0]["readAt"] != nil {
		t.Errorf("unread: %v", items)
	}
	if n := usedSummaries(t, a); n != 1 {
		t.Errorf("one summary of the allowance: %d", n)
	}
}

func TestATextIsSavedForLaterToo(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	_, r := saveForLater(t, cl, map[string]any{"text": "Some long article about heat pumps and how they work."})
	if r.JSON()["summary"] == "" {
		t.Errorf("a summary: %s", r.Body)
	}
	items := listed(t, cl, "unread")
	if len(items) != 1 || items[0]["url"] != "" {
		t.Errorf("a text has no address: %v", items)
	}
	if sent, _ := a.ai.lastSummary.Load().(string); !strings.Contains(sent, "skim_chars=12000") {
		t.Errorf("a long text is skimmed too: %q", sent)
	}
}

func TestAPageThatIsSavedAlreadyIsShownNotSummarizedAgain(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := saveForLater(t, cl, map[string]any{"url": "https://blog.example/post"})
	calls := a.ai.calls.Load()
	r := cl.post("/reading-list", map[string]any{"url": "https://blog.example/post"})
	if r.Status != http.StatusOK || r.JSON()["alreadySaved"] != true || int(r.JSON()["id"].(float64)) != id {
		t.Errorf("again: %d %s", r.Status, r.Body)
	}
	if a.ai.calls.Load() != calls {
		t.Error("the model was not asked again")
	}
	if n := usedSummaries(t, a); n != 1 {
		t.Errorf("and nothing more was charged: %d", n)
	}
	if got := len(listed(t, cl, "unread")); got != 1 {
		t.Errorf("one item: %d", got)
	}
}

func TestSavingNeedsAnAddressOrATextAndAFailureCostsNothing(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	for name, body := range map[string]map[string]any{
		"nothing":     {},
		"both":        {"url": "https://blog.example/a", "text": "x"},
		"blank":       {"text": "   "},
		"not http":    {"url": "ftp://blog.example/file"},
		"with spaces": {"url": "https://blog.example/a b"},
	} {
		if r := cl.post("/reading-list", body); r.Status != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, r.Status, r.Body)
		}
	}
	a.ai.fail.Store(true)
	if r := cl.post("/reading-list", map[string]any{"url": "https://blog.example/post"}); r.Status < 500 {
		t.Errorf("a failing AI service: %d", r.Status)
	}
	a.ai.fail.Store(false)
	if n := usedSummaries(t, a); n != 0 {
		t.Errorf("nothing was charged: %d", n)
	}
	if n := count(t, a.db, "SELECT count(*) FROM reading_items"); n != 0 {
		t.Errorf("nothing was saved: %d", n)
	}
}

func TestItemsAreMarkedReadArchivedBroughtBackAndRemoved(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	first, _ := saveForLater(t, cl, map[string]any{"url": "https://blog.example/one"})
	second, _ := saveForLater(t, cl, map[string]any{"url": "https://blog.example/two"})

	if got := listed(t, cl, "unread"); len(got) != 2 || int(got[0]["id"].(float64)) != second {
		t.Fatalf("newest first: %v", got)
	}
	if r := cl.put(readingPath(first), map[string]any{"read": true}); r.Status != http.StatusOK {
		t.Fatalf("read: %d %s", r.Status, r.Body)
	}
	if len(listed(t, cl, "unread")) != 1 || len(listed(t, cl, "read")) != 1 {
		t.Error("it moved to the read list")
	}
	cl.put(readingPath(first), map[string]any{"read": false})
	if len(listed(t, cl, "unread")) != 2 {
		t.Error("and back")
	}
	cl.put(readingPath(second), map[string]any{"archived": true})
	if len(listed(t, cl, "archived")) != 1 || len(listed(t, cl, "unread")) != 1 {
		t.Error("archived items leave the others")
	}
	counts := cl.get("/reading-list").JSON()["counts"].(map[string]any)
	if counts["unread"].(float64) != 1 || counts["archived"].(float64) != 1 || counts["read"].(float64) != 0 {
		t.Errorf("counts: %v", counts)
	}
	cl.put(readingPath(second), map[string]any{"archived": false})
	if len(listed(t, cl, "unread")) != 2 {
		t.Error("brought back")
	}

	if r := cl.delete(readingPath(first), nil); r.Status != http.StatusOK {
		t.Fatalf("remove: %d %s", r.Status, r.Body)
	}
	if len(listed(t, cl, "unread")) != 1 {
		t.Error("it left the list")
	}
	if docs := listedDocuments(t, cl); len(docs) != 2 {
		t.Errorf("but the document stays in the library: %d", len(docs))
	}
	if r := cl.delete(readingPath(first), nil); r.Status != http.StatusNotFound {
		t.Errorf("twice: %d", r.Status)
	}
}

func TestTheReadingListIsPrivateAndTheUpdatesAreChecked(t *testing.T) {
	a := newApp(t)
	alice, _ := a.newUser()
	bob, _ := a.newUser()
	id, _ := saveForLater(t, alice, map[string]any{"url": "https://blog.example/one"})
	if got := listed(t, bob, "unread"); len(got) != 0 {
		t.Errorf("Bob sees nothing: %v", got)
	}
	if r := bob.put(readingPath(id), map[string]any{"read": true}); r.Status != http.StatusNotFound {
		t.Errorf("Bob cannot change it: %d", r.Status)
	}
	if r := bob.delete(readingPath(id), nil); r.Status != http.StatusNotFound {
		t.Errorf("or remove it: %d", r.Status)
	}
	if r := alice.put(readingPath(id), map[string]any{}); r.Status != http.StatusBadRequest {
		t.Errorf("an empty change: %d", r.Status)
	}
	if r := alice.get("/reading-list?state=sideways"); r.Status != http.StatusBadRequest {
		t.Errorf("an unknown list: %d", r.Status)
	}
	if r := a.newClient().get("/reading-list"); r.Status != http.StatusUnauthorized {
		t.Errorf("signed out: %d", r.Status)
	}
	if len(listed(t, alice, "unread")) != 1 {
		t.Error("it is still Alice's")
	}
}

func TestDeletingTheDocumentTakesItOffTheListAndTheAddressCanBeSavedAgain(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := saveForLater(t, cl, map[string]any{"url": "https://blog.example/post"})
	if r := cl.delete("/documents/"+strconv.Itoa(id), nil); r.Status != http.StatusOK {
		t.Fatalf("delete: %d", r.Status)
	}
	if len(listed(t, cl, "unread")) != 0 {
		t.Error("gone from the list")
	}
	again, r := saveForLater(t, cl, map[string]any{"url": "https://blog.example/post"})
	if again == id || r.JSON()["alreadySaved"] != false {
		t.Errorf("saved anew: %s", r.Body)
	}
}

func TestAKeyCanSaveToTheReadingListToo(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "extension")
	r := a.call(http.MethodPost, "/v1/reading-list", key, map[string]any{"url": "https://blog.example/post"})
	if r.Status != http.StatusCreated {
		t.Fatalf("v1: %d %s", r.Status, r.Body)
	}
	if got := listed(t, cl, "unread"); len(got) != 1 {
		t.Errorf("it is on the owner's list: %v", got)
	}
	// but a key cannot read the list
	if r := a.call(http.MethodGet, "/reading-list", key, nil); r.Status == http.StatusOK {
		t.Errorf("a key cannot read the list: %d", r.Status)
	}
}

func TestTheReadingListGoesWithTheAccount(t *testing.T) {
	a := newApp(t)
	cl, email := a.newUser()
	saveForLater(t, cl, map[string]any{"url": "https://blog.example/post"})
	a.db.Exec("DELETE FROM users WHERE email = ?", email)
	if n := count(t, a.db, "SELECT count(*) FROM reading_items"); n != 0 {
		t.Errorf("the list goes with the person: %d", n)
	}
}

// ---- the weekly digest ------------------------------------------------------------------------------------------

// A Sunday morning in UTC, the time zone of a person who has not set one.
var sundayMorning = time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)

// digests are the digest emails sent so far (the sign-up emails are not them). It waits a moment, because emails are sent in
// the background, so that "nothing was sent" means it.
func digests(a *app) []sentMail {
	time.Sleep(250 * time.Millisecond)
	var out []sentMail
	for _, m := range a.mail.all() {
		if strings.Contains(m.Subject, "saved this week") {
			out = append(out, m)
		}
	}
	return out
}

// runDigest runs the job as if it were `at`. The record of its last run is cleared first, so that a test can pretend to be at
// any time (the job itself runs about once an hour).
func runDigest(a *app, at time.Time) {
	a.db.Exec("DELETE FROM job_runs WHERE name = 'reading-digest'")
	runner := &jobs.Runner{Jobs: []jobs.Job{controllers.ReadingDigest(a.mail)}, Now: func() time.Time { return at }}
	runner.Tick(context.Background())
}

// saveAWeekOfItems saves n pages and says they were saved a day before `at`.
func saveAWeekOfItems(t *testing.T, a *app, cl *client, n int, at time.Time) []int {
	t.Helper()
	var ids []int
	for i := 0; i < n; i++ {
		id, _ := saveForLater(t, cl, map[string]any{"url": "https://blog.example/post-" + strconv.Itoa(i)})
		ids = append(ids, id)
	}
	if err := a.db.Exec("UPDATE reading_items SET saved_at = ?", at.Add(-24*time.Hour)).Error; err != nil {
		t.Fatal(err)
	}
	return ids
}

func TestTheDigestHoldsWhatWasSavedThisWeekWithHowItFitsTogether(t *testing.T) {
	a := newApp(t)
	cl, _ := newConfirmedUser(a)
	cl.put("/account/email-preferences", map[string]any{"digest": true})
	saveAWeekOfItems(t, a, cl, 2, sundayMorning)
	before := usedSummaries(t, a)

	runDigest(a, sundayMorning)
	mails := mailsAbout(a, "things you saved this week", 1)
	if len(mails) != 1 {
		t.Fatalf("one digest: %+v", a.mail.all())
	}
	m := mails[0]
	for _, want := range []string{"Fake Page Title: fake url summary", "How they fit together", "/reading", "Stop these emails"} {
		if !strings.Contains(m.Text, want) {
			t.Errorf("the digest holds %q:\n%s", want, m.Text)
		}
	}
	if sent, _ := a.ai.lastSummary.Load().(string); !strings.Contains(sent, "word_count=80") {
		t.Errorf("a short paragraph was asked for: %q", sent)
	}
	if got := usedSummaries(t, a) - before; got != 1 {
		t.Errorf("the paragraph is one summary of the allowance: %d", got)
	}

	// the same Sunday, later: not again
	runDigest(a, sundayMorning.Add(90*time.Minute))
	if got := mailsAbout(a, "things you saved this week", 2); len(got) != 1 {
		t.Errorf("once a week: %d", len(got))
	}
}

func TestOneSavedItemNeedsNoOverviewAndAnEmptyWeekSendsNothing(t *testing.T) {
	a := newApp(t)
	cl, _ := newConfirmedUser(a)
	cl.put("/account/email-preferences", map[string]any{"digest": true})
	runDigest(a, sundayMorning)
	if got := digests(a); len(got) != 0 {
		t.Errorf("nothing saved, nothing sent: %+v", got)
	}

	saveAWeekOfItems(t, a, cl, 1, sundayMorning)
	calls := a.ai.calls.Load()
	runDigest(a, sundayMorning.Add(24*time.Hour*7)) // the next Sunday: the item is now older than a week
	if got := mailsAbout(a, "saved this week", 1); len(got) != 0 {
		t.Errorf("an item from last week is not this week's: %+v", got)
	}
	runDigest(a, sundayMorning)
	mails := mailsAbout(a, "1 thing you saved this week", 1)
	if len(mails) != 1 || strings.Contains(mails[0].Text, "How they fit together") {
		t.Fatalf("one item, no paragraph: %+v", mails)
	}
	if a.ai.calls.Load() != calls {
		t.Error("one item needs no model call")
	}
}

func TestTheDigestOnlyGoesToThoseWhoWantItOnTheirSundayMorning(t *testing.T) {
	a := newApp(t)
	wants, _ := newConfirmedUser(a)
	off, _ := newConfirmedUser(a)
	unconfirmed, _ := a.newUser()
	for _, cl := range []*client{wants, unconfirmed} {
		cl.put("/account/email-preferences", map[string]any{"digest": true})
	}
	_ = off
	// the unconfirmed person has switched it on, but cannot save (saving needs a confirmed address): give them an item directly
	saveAWeekOfItems(t, a, wants, 2, sundayMorning)
	saveAWeekOfItems(t, a, off, 2, sundayMorning)

	runDigest(a, sundayMorning.Add(24*time.Hour)) // a Monday
	if got := digests(a); len(got) != 0 {
		t.Errorf("not on a Monday: %+v", got)
	}
	runDigest(a, sundayMorning.Add(-3*time.Hour)) // Sunday, 6 in the morning
	if got := digests(a); len(got) != 0 {
		t.Errorf("not before the morning: %+v", got)
	}
	runDigest(a, sundayMorning)
	if got := mailsAbout(a, "saved this week", 1); len(got) != 1 {
		t.Errorf("only the one who wants it: %d", len(got))
	}
}

func TestTheDigestFollowsThePersonsOwnTimeZone(t *testing.T) {
	a := newApp(t)
	cl, _ := newConfirmedUser(a)
	cl.put("/account/email-preferences", map[string]any{"digest": true, "timeZone": "Pacific/Auckland"})
	saveAWeekOfItems(t, a, cl, 2, sundayMorning)
	// 09:00 UTC on Sunday is 22:00 on Sunday in Auckland: not their morning
	runDigest(a, sundayMorning)
	if got := digests(a); len(got) != 0 {
		t.Errorf("not their morning: %+v", got)
	}
	// 20:00 UTC on Saturday is 09:00 on Sunday in Auckland
	runDigest(a, time.Date(2026, 10, 17, 20, 0, 0, 0, time.UTC))
	if got := mailsAbout(a, "saved this week", 1); len(got) != 1 {
		t.Errorf("their Sunday morning: %d", len(got))
	}
}

func TestTheDigestLeavesOutWhatIsReadOrArchivedAndGoesOutWithoutTheParagraphWhenThereIsNoAllowance(t *testing.T) {
	a := newApp(t)
	t.Setenv("QUOTA_SUMMARIES_PER_DAY", "3")
	cl, _ := newConfirmedUser(a)
	cl.put("/account/email-preferences", map[string]any{"digest": true})
	ids := saveAWeekOfItems(t, a, cl, 3, sundayMorning)
	cl.put(readingPath(ids[0]), map[string]any{"read": true})
	cl.put(readingPath(ids[1]), map[string]any{"archived": true})
	// the three saves used the allowance: there is none for the paragraph
	saveAWeekOfItems(t, a, cl, 0, sundayMorning)
	a.db.Exec("UPDATE reading_items SET saved_at = ? WHERE document_id = ?", sundayMorning.Add(-time.Hour), ids[2])
	cl2, _ := newConfirmedUser(a)
	cl2.put("/account/email-preferences", map[string]any{"digest": true})
	other := saveAWeekOfItems(t, a, cl2, 2, sundayMorning)
	_ = other
	a.db.Exec("UPDATE daily_usage SET summaries = 3")

	runDigest(a, sundayMorning)
	mails := mailsAbout(a, "saved this week", 2)
	if len(mails) != 2 {
		t.Fatalf("two digests: %+v", a.mail.all())
	}
	for _, m := range mails {
		if strings.Contains(m.Text, "How they fit together") {
			t.Errorf("no allowance, no paragraph:\n%s", m.Text)
		}
	}
	var mine sentMail
	for _, m := range mails {
		if strings.Contains(m.Subject, "1 thing") {
			mine = m
		}
	}
	if mine.Subject == "" {
		t.Errorf("only the unread, unarchived item is in the first person's digest: %+v", mails)
	}
}

func TestSwitchingTheDigestOffStopsIt(t *testing.T) {
	a := newApp(t)
	t.Setenv("DIGEST_ENABLED", "false")
	cl, _ := newConfirmedUser(a)
	cl.put("/account/email-preferences", map[string]any{"digest": true})
	saveAWeekOfItems(t, a, cl, 2, sundayMorning)
	runDigest(a, sundayMorning)
	if got := digests(a); len(got) != 0 {
		t.Errorf("DIGEST_ENABLED=false: %+v", got)
	}
}
