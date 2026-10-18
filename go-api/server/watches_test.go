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

// Watching a page. The fake AI service serves "the page" (a.ai.readText) and, for a change, the same two changes as a
// comparison of two documents: one of high and one of medium importance.

const pageURL = "https://news.example/terms"

func watchPath(id int, suffix string) string { return "/watches/" + strconv.Itoa(id) + suffix }

// newConfirmedUser is a person whose address is confirmed: emails go only to those.
func newConfirmedUser(a *app) (*client, string) {
	cl, email := a.newUser()
	if err := a.db.Exec("UPDATE users SET email_verified_at = now() WHERE email = ?", email).Error; err != nil {
		a.t.Fatal(err)
	}
	return cl, email
}

func startWatching(t *testing.T, cl *client, address string) (id int, r reply) {
	t.Helper()
	r = cl.post("/watches", map[string]any{"url": address})
	if r.Status != http.StatusCreated {
		t.Fatalf("watch %s: %d %s", address, r.Status, r.Body)
	}
	return int(r.JSON()["id"].(float64)), r
}

func checkNow(t *testing.T, cl *client, id int) map[string]any {
	t.Helper()
	r := cl.post(watchPath(id, "/check"), nil)
	if r.Status != http.StatusOK {
		t.Fatalf("check: %d %s", r.Status, r.Body)
	}
	return r.JSON()["result"].(map[string]any)
}

// mailsAbout returns the emails whose subject has the words, waiting a moment for them to go out.
func mailsAbout(a *app, words string, want int) []sentMail {
	deadline := time.Now().Add(3 * time.Second)
	for {
		var found []sentMail
		for _, m := range a.mail.all() {
			if strings.Contains(m.Subject, words) {
				found = append(found, m)
			}
		}
		if len(found) >= want || time.Now().After(deadline) {
			return found
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestWatchingAPageReadsItOnceForTheBaselineAndAsksForTheRobotsCheck(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, r := startWatching(t, cl, pageURL)

	view := r.JSON()
	if view["title"] != "Fake Page Title" || view["everyHours"] != float64(24) || view["changes"] != float64(0) || view["paused"] != false || view["url"] != pageURL {
		t.Errorf("the watch: %s", r.Body)
	}
	if q, _ := a.ai.lastReadQuery.Load().(string); !strings.Contains(q, "watch=true") {
		t.Errorf("a watched page is read with the robots.txt check: %q", q)
	}
	if n := summariesUsed(t, a); n != 0 {
		t.Errorf("starting to watch costs no AI: %d", n)
	}
	list := cl.get("/watches").JSON()
	watches, _ := list["watches"].([]any)
	if len(watches) != 1 || watches[0].(map[string]any)["id"] != float64(id) || list["limit"] != float64(10) || list["minHours"] != float64(12) {
		t.Errorf("the list: %v", list)
	}
}

func TestOnlyAGoodAddressAndAWholeTimeAreAccepted(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	for _, bad := range []map[string]any{
		{"url": ""}, {"url": "ftp://news.example/x"}, {"url": "not an address"}, {"url": pageURL, "everyHours": 3}, {"url": pageURL, "everyHours": 100000},
	} {
		if r := cl.post("/watches", bad); r.Status != http.StatusBadRequest {
			t.Errorf("%v: %d %s", bad, r.Status, r.Body)
		}
	}
	if r := a.newClient().post("/watches", map[string]any{"url": pageURL}); r.Status != http.StatusUnauthorized {
		t.Errorf("signed out: %d", r.Status)
	}
	if n := count(t, a.db, "SELECT count(*) FROM page_watches"); n != 0 {
		t.Errorf("nothing was started: %d", n)
	}
}

func TestAPageThatCannotBeReadIsRefusedWithTheReasonAndNotWatched(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	a.ai.readFail.Store(true)
	r := cl.post("/watches", map[string]any{"url": pageURL})
	if r.Status != http.StatusUnprocessableEntity || !strings.Contains(r.Str("error"), "not found") {
		t.Errorf("unreadable: %d %s", r.Status, r.Body)
	}
	if n := count(t, a.db, "SELECT count(*) FROM page_watches"); n != 0 {
		t.Errorf("not watched: %d", n)
	}
}

func TestAPageCanBeWatchedOnceAndOnlyUpToTheLimit(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCHES_PER_USER", "2")
	cl, _ := a.newUser()
	startWatching(t, cl, pageURL)
	if r := cl.post("/watches", map[string]any{"url": pageURL}); r.Status != http.StatusConflict || !strings.Contains(r.Str("error"), "already watching") {
		t.Errorf("twice: %d %s", r.Status, r.Body)
	}
	startWatching(t, cl, "https://other.example/a")
	if r := cl.post("/watches", map[string]any{"url": "https://third.example/a"}); r.Status != http.StatusConflict || !strings.Contains(r.Str("error"), "up to 2") {
		t.Errorf("over the limit: %d %s", r.Status, r.Body)
	}
	other, _ := a.newUser()
	if _, r := startWatching(t, other, pageURL); r.Status != http.StatusCreated {
		t.Errorf("another person may watch the same page: %d", r.Status)
	}
}

func TestAPageThatHasNotChangedCostsNothingAndNeedsNoAI(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	cl, _ := a.newUser()
	a.ai.readText.Store("Cancellation is possible within 30 days.")
	id, _ := startWatching(t, cl, pageURL)

	if got := checkNow(t, cl, id); got["status"] != "unchanged" {
		t.Errorf("same page: %v", got)
	}
	if a.ai.compareCalls.Load() != 0 || summariesUsed(t, a) != 0 {
		t.Errorf("no model call and nothing charged: %d, %d", a.ai.compareCalls.Load(), summariesUsed(t, a))
	}
}

func TestAPageThatOnlyTicksIsNotAChange(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	cl, _ := a.newUser()
	// What differs on every visit (the time, "5 minutes ago") is taken out before pages are compared.
	a.ai.readText.Store("Prices as of 14:32, updated 3 minutes ago. Rent is 950 euros.")
	id, _ := startWatching(t, cl, pageURL)
	a.ai.readText.Store("Prices as of 14:48,   updated 1 minute ago. Rent is 950 euros.")
	if got := checkNow(t, cl, id); got["status"] != "unchanged" {
		t.Errorf("a ticking page: %v", got)
	}
	if a.ai.compareCalls.Load() != 0 || summariesUsed(t, a) != 0 {
		t.Errorf("no model call and nothing charged: %d, %d", a.ai.compareCalls.Load(), summariesUsed(t, a))
	}
	// A real change in the same page is still a change.
	a.ai.readText.Store("Prices as of 15:02, updated 2 minutes ago. Rent is 1,050 euros.")
	if got := checkNow(t, cl, id); got["status"] != "changed" {
		t.Errorf("a real change: %v", got)
	}
}

func TestAChangeIsWrittenUpKeptAndEmailed(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	t.Setenv("FRONTEND_URL", "https://inkling.example")
	cl, _ := newConfirmedUser(a)
	a.ai.readText.Store("Payment is due within 30 days. Records are kept.")
	id, _ := startWatching(t, cl, pageURL)

	a.ai.readText.Store("Payment is due within 60 days. Records are kept. Audits happen yearly.")
	got := checkNow(t, cl, id)
	if got["status"] != "changed" || got["changes"] != float64(2) || got["important"] != float64(2) {
		t.Fatalf("a change: %v", got)
	}
	if n := summariesUsed(t, a); n != 1 {
		t.Errorf("one use of the allowance: %d", n)
	}

	mails := mailsAbout(a, "Changes on Fake Page Title", 1)
	if len(mails) != 1 {
		t.Fatalf("one email: %+v", a.mail.all())
	}
	body := mails[0].Text
	for _, want := range []string{"Payment terms changed and a duty was added.", "https://inkling.example/watches?open=" + strconv.Itoa(id), "Stop these emails: https://inkling.example/unsubscribe?token="} {
		if !strings.Contains(body, want) {
			t.Errorf("the email is missing %q:\n%s", want, body)
		}
	}
	if !strings.Contains(body, "Changed (high)") || !strings.Contains(body, "Added (medium)") {
		t.Errorf("the most important change comes first, with its importance:\n%s", body)
	}

	// The history and the detail.
	list := cl.get("/watches").JSON()["watches"].([]any)[0].(map[string]any)
	latest, _ := list["latest"].(map[string]any)
	if list["changes"] != float64(1) || latest["topImportance"] != "high" || latest["bottomLine"] != "Payment terms changed and a duty was added." || list["lastChangedAt"] == nil {
		t.Errorf("the list shows the change: %v", list)
	}
	changes := cl.get(watchPath(id, "/changes")).JSON()["changes"].([]any)
	if len(changes) != 1 {
		t.Fatalf("history: %v", changes)
	}
	changeID := int(changes[0].(map[string]any)["id"].(float64))
	detail := cl.get(watchPath(id, "/changes/"+strconv.Itoa(changeID))).JSON()
	comparison, _ := detail["comparison"].(map[string]any)
	if detail["url"] != pageURL || len(comparison["changes"].([]any)) != 2 || comparison["bottomLine"] != "Payment terms changed and a duty was added." {
		t.Errorf("detail: %v", detail)
	}

	// The new version is now the baseline: the same page is no change.
	if again := checkNow(t, cl, id); again["status"] != "unchanged" {
		t.Errorf("checked again: %v", again)
	}
}

func TestOnlyChangesThatMatterAreEmailed(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	cl, _ := a.newUser()
	a.ai.readText.Store("Version one of the page.")
	id, _ := startWatching(t, cl, pageURL)

	// Only a small change: kept in the history, no email.
	a.ai.compareReply.Store(`{"identical":false,"counts":{"added":0,"removed":0,"changed":1,"moved":0},"changes":[` +
		`{"id":1,"kind":"changed","before":"one","after":"two","beforePage":1,"afterPage":1,"segments":null,"numbers":{"removed":[],"added":[]},` +
		`"importance":"low","summary":"A word changed.","impact":"None.","explained":true}],"bottomLine":"A word changed.","explained":true,"omitted":0}`)
	a.ai.readText.Store("Version two of the page.")
	got := checkNow(t, cl, id)
	if got["status"] != "changed" || got["changes"] != float64(1) || got["important"] != float64(0) {
		t.Errorf("a small change: %v", got)
	}
	if mails := mailsAbout(a, "Changes on", 1); len(mails) != 0 {
		t.Errorf("no email for a low change: %+v", mails)
	}
	if n := count(t, a.db, "SELECT count(*) FROM watch_changes"); n != 1 {
		t.Errorf("but it is kept: %d", n)
	}

	// With the bar set at high, a medium change is not emailed either.
	t.Setenv("WATCH_EMAIL_MIN_IMPORTANCE", "high")
	a.ai.compareReply.Store("")
	a.ai.readText.Store("Version three of the page, with a clause.")
	got = checkNow(t, cl, id)
	if got["important"] != float64(1) {
		t.Errorf("only the high one counts: %v", got)
	}
}

func TestChangesThatAreOnlySpacingAreNotKeptAndTheAllowanceIsGivenBack(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	cl, _ := a.newUser()
	a.ai.readText.Store("The same words.")
	id, _ := startWatching(t, cl, pageURL)
	a.ai.compareReply.Store(`{"identical":true,"counts":{"added":0,"removed":0,"changed":0,"moved":0},"changes":[],"bottomLine":"","explained":true,"omitted":0}`)
	a.ai.readText.Store("The same, words.")
	if got := checkNow(t, cl, id); got["status"] != "identical" {
		t.Errorf("identical: %v", got)
	}
	if n := summariesUsed(t, a); n != 0 {
		t.Errorf("nothing was explained, so nothing is charged: %d", n)
	}
	if n := count(t, a.db, "SELECT count(*) FROM watch_changes"); n != 0 {
		t.Errorf("no record: %d", n)
	}
	a.ai.compareReply.Store("")
	if got := checkNow(t, cl, id); got["status"] != "unchanged" {
		t.Errorf("the new version is the baseline: %v", got)
	}
}

func TestWithNoAllowanceALeftChangeIsNotLostButLookedAtLater(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	t.Setenv("QUOTA_SUMMARIES_PER_DAY", "1")
	cl, _ := a.newUser()
	createStudySet(t, cl, "Uses the day's only summary.")
	a.ai.readText.Store("Terms, version one.")
	id, _ := startWatching(t, cl, pageURL)
	a.ai.readText.Store("Terms, version two, with a new fee.")

	got := checkNow(t, cl, id)
	if got["status"] != "waiting" || !strings.Contains(got["message"].(string), "allowance") {
		t.Fatalf("no allowance: %v", got)
	}
	if a.ai.compareCalls.Load() != 0 {
		t.Error("no model call without an allowance")
	}
	if n := count(t, a.db, "SELECT count(*) FROM watch_changes"); n != 0 {
		t.Errorf("nothing written up yet: %d", n)
	}
	var next time.Time
	if err := a.db.Raw("SELECT next_check_at FROM page_watches WHERE id = ?", id).Scan(&next).Error; err != nil || time.Until(next) < 5*time.Hour {
		t.Errorf("looked at again in hours, not days: %v %v", next, err)
	}

	// The next day's allowance: the change is still on the page, and is now written up.
	if err := a.db.Exec("DELETE FROM daily_usage").Error; err != nil {
		t.Fatal(err)
	}
	if got := checkNow(t, cl, id); got["status"] != "changed" {
		t.Errorf("later: %v", got)
	}
}

func TestWhenTheSitesBudgetIsUsedUpTheChangeWaitsToo(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	t.Setenv("AI_REQUESTS_PER_DAY", "1")
	cl, _ := a.newUser()
	a.ai.readText.Store("One.")
	id, _ := startWatching(t, cl, pageURL)
	if err := a.db.Exec("INSERT INTO global_usage (day, requests) VALUES (CURRENT_DATE, 1) ON CONFLICT (day) DO UPDATE SET requests = 1").Error; err != nil {
		t.Fatal(err)
	}
	a.ai.readText.Store("Two.")
	got := checkNow(t, cl, id)
	if got["status"] != "waiting" || !strings.Contains(got["message"].(string), "AI limit") {
		t.Errorf("budget: %v", got)
	}
	if n := summariesUsed(t, a); n != 0 {
		t.Errorf("the allowance claimed first is given back: %d", n)
	}
}

func TestWhenTheChangeCannotBeExplainedNothingIsChargedAndItIsTriedAgain(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	cl, _ := a.newUser()
	a.ai.readText.Store("One.")
	id, _ := startWatching(t, cl, pageURL)
	a.ai.readText.Store("Two.")
	a.ai.compareFail.Store(true)
	got := checkNow(t, cl, id)
	if got["status"] != "failed" || !strings.Contains(got["message"].(string), "Could not explain") {
		t.Errorf("the model failed: %v", got)
	}
	if n := summariesUsed(t, a); n != 0 {
		t.Errorf("not charged: %d", n)
	}
	if n := count(t, a.db, "SELECT failures FROM page_watches WHERE id = ?", id); n != 0 {
		t.Errorf("a model failure is not the page's fault: %d", n)
	}
	a.ai.compareFail.Store(false)
	if got := checkNow(t, cl, id); got["status"] != "changed" {
		t.Errorf("tried again: %v", got)
	}
}

func TestAPageThatCannotBeReadFiveTimesIsPausedWithOneEmail(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	cl, _ := newConfirmedUser(a)
	id, _ := startWatching(t, cl, pageURL)
	a.ai.readFail.Store(true)

	for i := 1; i <= 5; i++ {
		got := checkNow(t, cl, id)
		if got["status"] != "failed" {
			t.Fatalf("check %d: %v", i, got)
		}
		if n := count(t, a.db, "SELECT failures FROM page_watches WHERE id = ?", id); n != i {
			t.Fatalf("failures after %d: %d", i, n)
		}
	}
	view := cl.get("/watches").JSON()["watches"].([]any)[0].(map[string]any)
	if view["paused"] != true || !strings.Contains(view["lastError"].(string), "not found") {
		t.Errorf("paused with the reason: %v", view)
	}
	if mails := mailsAbout(a, "stopped watching", 1); len(mails) != 1 {
		t.Errorf("one email: %+v", a.mail.all())
	}
	if r := cl.post(watchPath(id, "/check"), nil); r.Status != http.StatusConflict {
		t.Errorf("a paused page is not checked: %d", r.Status)
	}

	// Resumed, it starts clean.
	a.ai.readFail.Store(false)
	r := cl.put(watchPath(id, ""), map[string]any{"paused": false})
	view = r.JSON()["watches"].([]any)[0].(map[string]any)
	if r.Status != http.StatusOK || view["paused"] != false || view["failures"] != float64(0) || view["lastError"] != "" {
		t.Errorf("resumed: %d %v", r.Status, view)
	}
	if got := checkNow(t, cl, id); got["status"] != "unchanged" {
		t.Errorf("after resuming: %v", got)
	}
}

func TestCheckNowCannotBeUsedToOpenAPageOverAndOver(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, _ := startWatching(t, cl, pageURL)
	// The page was read a moment ago when it was started: it cannot be checked again at once.
	r := cl.post(watchPath(id, "/check"), nil)
	if r.Status != http.StatusTooManyRequests || r.Header.Get("Retry-After") == "" {
		t.Errorf("too soon: %d %s", r.Status, r.Body)
	}
	if n := a.ai.readCalls.Load(); n != 1 {
		t.Errorf("the page was opened once, for the baseline: %d", n)
	}
}

func TestWatchesBelongToTheirOwner(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	alice, _ := a.newUser()
	bob, _ := a.newUser()
	id, _ := startWatching(t, alice, pageURL)

	if r := bob.put(watchPath(id, ""), map[string]any{"paused": true}); r.Status != http.StatusNotFound {
		t.Errorf("update: %d", r.Status)
	}
	if r := bob.delete(watchPath(id, ""), nil); r.Status != http.StatusNotFound {
		t.Errorf("delete: %d", r.Status)
	}
	if r := bob.post(watchPath(id, "/check"), nil); r.Status != http.StatusNotFound {
		t.Errorf("check: %d", r.Status)
	}
	if r := bob.get(watchPath(id, "/changes")); r.Status != http.StatusNotFound {
		t.Errorf("history: %d", r.Status)
	}
	if list := bob.get("/watches").JSON()["watches"].([]any); len(list) != 0 {
		t.Errorf("bob sees none: %v", list)
	}
	if n := count(t, a.db, "SELECT count(*) FROM page_watches WHERE paused"); n != 0 {
		t.Errorf("alice's watch is untouched: %d", n)
	}
}

func TestHowOftenAPageIsCheckedCanBeChangedWithinLimitsAndAWatchCanBeRemoved(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	cl, _ := a.newUser()
	a.ai.readText.Store("One.")
	id, _ := startWatching(t, cl, pageURL)

	if r := cl.put(watchPath(id, ""), map[string]any{"everyHours": 72}); r.Status != http.StatusOK ||
		r.JSON()["watches"].([]any)[0].(map[string]any)["everyHours"] != float64(72) {
		t.Errorf("every 72 hours: %d %s", r.Status, r.Body)
	}
	if r := cl.put(watchPath(id, ""), map[string]any{"everyHours": 2}); r.Status != http.StatusBadRequest {
		t.Errorf("too often: %d", r.Status)
	}
	a.ai.readText.Store("Two.")
	checkNow(t, cl, id)
	if n := count(t, a.db, "SELECT count(*) FROM watch_changes"); n != 1 {
		t.Fatalf("setup: %d", n)
	}
	if r := cl.delete(watchPath(id, ""), nil); r.Status != http.StatusOK {
		t.Fatalf("remove: %d", r.Status)
	}
	if n := count(t, a.db, "SELECT count(*) FROM page_watches") + count(t, a.db, "SELECT count(*) FROM watch_changes"); n != 0 {
		t.Errorf("its history goes with it: %d", n)
	}
}

func TestOnlyTheNewestChangesAreKept(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	cl, _ := a.newUser()
	a.ai.readText.Store("Version 0.")
	id, _ := startWatching(t, cl, pageURL)
	for i := 1; i <= 23; i++ {
		a.ai.readText.Store("Version " + strconv.Itoa(i) + " with other words each time.")
		if got := checkNow(t, cl, id); got["status"] != "changed" {
			t.Fatalf("change %d: %v", i, got)
		}
	}
	if n := count(t, a.db, "SELECT count(*) FROM watch_changes WHERE watch_id = ?", id); n != 20 {
		t.Errorf("the newest 20 are kept: %d", n)
	}
	if n := count(t, a.db, "SELECT count(*) FROM watch_changes WHERE watch_id = ? AND title <> ''", id); n != 20 {
		t.Errorf("each has its title: %d", n)
	}
}

func TestTheScheduledJobChecksDuePagesAndLeavesTheRest(t *testing.T) {
	a := newApp(t)
	cl, _ := newConfirmedUser(a)
	a.ai.readText.Store("Terms one.")
	due, _ := startWatching(t, cl, pageURL)
	notYet, _ := startWatching(t, cl, "https://other.example/not-yet")
	paused, _ := startWatching(t, cl, "https://other.example/paused")
	if err := a.db.Exec("UPDATE page_watches SET next_check_at = now() - interval '1 hour' WHERE id IN (?, ?)", due, paused).Error; err != nil {
		t.Fatal(err)
	}
	cl.put(watchPath(paused, ""), map[string]any{"paused": true})
	a.ai.readText.Store("Terms two, with a new clause.")

	runner := &jobs.Runner{Jobs: []jobs.Job{controllers.PageWatches(a.mail)}}
	runner.Tick(context.Background())

	checked := func(id int) bool {
		return count(t, a.db, "SELECT count(*) FROM page_watches WHERE id = ? AND last_changed_at IS NOT NULL", id) == 1
	}
	if !checked(due) {
		t.Error("the due page was checked and its change written up")
	}
	if checked(notYet) || checked(paused) {
		t.Error("a page that is not due, or is paused, was left alone")
	}
	if mails := mailsAbout(a, "Changes on", 1); len(mails) != 1 {
		t.Errorf("one email: %+v", a.mail.all())
	}
	// Run again at once: nothing is due any more.
	before := a.ai.readCalls.Load()
	runner.Tick(context.Background())
	if a.ai.readCalls.Load() != before {
		t.Error("the job is not due again for an hour")
	}
}

func TestAPersonWhoSwitchedWatchEmailsOffIsNotEmailedButTheChangeIsKept(t *testing.T) {
	a := newApp(t)
	t.Setenv("WATCH_CHECK_NOW_MINUTES", "0")
	cl, _ := a.newUser()
	cl.put("/account/email-preferences", map[string]any{"watch": false})
	a.ai.readText.Store("One.")
	id, _ := startWatching(t, cl, pageURL)
	a.ai.readText.Store("Two, quite different.")
	if got := checkNow(t, cl, id); got["status"] != "changed" {
		t.Fatalf("changed: %v", got)
	}
	if mails := mailsAbout(a, "Changes on", 1); len(mails) != 0 {
		t.Errorf("no email: %+v", mails)
	}
	if n := count(t, a.db, "SELECT count(*) FROM watch_changes"); n != 1 {
		t.Errorf("but the change is in the history: %d", n)
	}
}

func TestWatchedPagesAreInTheDataExportWithoutTheirText(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	a.ai.readText.Store("A page with private-looking words.")
	startWatching(t, cl, pageURL)
	r := cl.get("/account/export")
	pages, _ := r.JSON()["watchedPages"].([]any)
	if len(pages) != 1 || pages[0].(map[string]any)["url"] != pageURL || pages[0].(map[string]any)["everyHours"] != float64(24) {
		t.Errorf("watched pages: %v", pages)
	}
	if strings.Contains(string(r.Body), "private-looking words") {
		t.Error("the stored text of a page is not exported")
	}
}
