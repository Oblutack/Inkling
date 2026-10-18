package jobs

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"

	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/mailer"
	"ai-summarizer/go-api/models"
	"ai-summarizer/go-api/notices"
	"ai-summarizer/go-api/reviews"
	"ai-summarizer/go-api/testutil"
)

type clock struct{ now time.Time }

func (c *clock) Now() time.Time          { return c.now }
func (c *clock) advance(d time.Duration) { c.now = c.now.Add(d) }

func TestAJobRunsWhenDueAndNotAgainUntilItsIntervalHasPassed(t *testing.T) {
	testutil.DB(t, "jobstest")
	clk := &clock{time.Date(2026, 10, 18, 6, 0, 0, 0, time.UTC)}
	runs := 0
	r := &Runner{Now: clk.Now, Jobs: []Job{{Name: "counting", Every: time.Hour, Run: func(context.Context, time.Time) error { runs++; return nil }}}}

	r.Tick(context.Background())
	r.Tick(context.Background())
	if runs != 1 {
		t.Fatalf("it runs the first time it is seen and then waits: %d", runs)
	}
	clk.advance(59 * time.Minute)
	r.Tick(context.Background())
	if runs != 1 {
		t.Fatalf("not yet due: %d", runs)
	}
	clk.advance(2 * time.Minute)
	r.Tick(context.Background())
	if runs != 2 {
		t.Fatalf("due after an hour: %d", runs)
	}
}

func TestWhenAJobRanSurvivesARestart(t *testing.T) {
	testutil.DB(t, "jobstest")
	clk := &clock{time.Date(2026, 10, 18, 6, 0, 0, 0, time.UTC)}
	runs := 0
	job := Job{Name: "counting", Every: time.Hour, Run: func(context.Context, time.Time) error { runs++; return nil }}
	(&Runner{Now: clk.Now, Jobs: []Job{job}}).Tick(context.Background())
	// A new Runner is what a restarted server has: it knows nothing, but the database does.
	(&Runner{Now: clk.Now, Jobs: []Job{job}}).Tick(context.Background())
	if runs != 1 {
		t.Errorf("a restart does not repeat a job: %d", runs)
	}
}

func TestAFailingOrPanickingJobIsRecordedAndNotRetriedEveryMinute(t *testing.T) {
	testutil.DB(t, "jobstest")
	clk := &clock{time.Date(2026, 10, 18, 6, 0, 0, 0, time.UTC)}
	failing, panicking, fine := 0, 0, 0
	r := &Runner{Now: clk.Now, Jobs: []Job{
		{Name: "failing", Every: time.Hour, Run: func(context.Context, time.Time) error { failing++; return errors.New("boom") }},
		{Name: "panicking", Every: time.Hour, Run: func(context.Context, time.Time) error { panicking++; panic("oh no") }},
		{Name: "fine", Every: time.Hour, Run: func(context.Context, time.Time) error { fine++; return nil }},
	}}
	r.Tick(context.Background())
	clk.advance(time.Minute)
	r.Tick(context.Background())
	if failing != 1 || panicking != 1 || fine != 1 {
		t.Errorf("each ran once, and one job's failure did not stop the others: %d %d %d", failing, panicking, fine)
	}
}

func TestAJobThatTakesTooLongIsCutOff(t *testing.T) {
	testutil.DB(t, "jobstest")
	var gotCtxErr error
	r := &Runner{Jobs: []Job{{Name: "slow", Every: time.Hour, Timeout: 30 * time.Millisecond, Run: func(ctx context.Context, _ time.Time) error {
		<-ctx.Done()
		gotCtxErr = ctx.Err()
		return ctx.Err()
	}}}}
	r.Tick(context.Background())
	if !errors.Is(gotCtxErr, context.DeadlineExceeded) {
		t.Errorf("the job was told to stop: %v", gotCtxErr)
	}
}

func TestOnlyOneCopyOfTheServerRunsAJobAtATime(t *testing.T) {
	db := testutil.DB(t, "jobstest")
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	// Another copy of the server is in the middle of the job: it holds the lock.
	conn, err := sqlDB.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	tx, err := conn.BeginTx(context.Background(), &sql.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec("SELECT pg_advisory_xact_lock(hashtext('inkling-job:shared'))"); err != nil {
		t.Fatal(err)
	}

	runs := 0
	r := &Runner{Jobs: []Job{{Name: "shared", Every: time.Hour, Run: func(context.Context, time.Time) error { runs++; return nil }}}}
	r.Tick(context.Background())
	if runs != 0 {
		t.Fatalf("the lock is held elsewhere: %d", runs)
	}
	_ = tx.Rollback()
	r.Tick(context.Background())
	if runs != 1 {
		t.Errorf("once it is free it runs: %d", runs)
	}
}

func TestScheduledWorkCanBeSwitchedOff(t *testing.T) {
	for value, want := range map[string]bool{"": true, "true": true, "yes": true, "false": false, "0": false, "Off": false, "no": false} {
		t.Setenv("JOBS_ENABLED", value)
		if Enabled() != want {
			t.Errorf("JOBS_ENABLED=%q: %v", value, Enabled())
		}
	}
}

// ---- the study reminder -------------------------------------------------------------------------------------

type capture struct {
	mu   sync.Mutex
	sent []mailer.Message
}

func (c *capture) Send(_ context.Context, m mailer.Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, m)
	return nil
}

func (c *capture) wait(t *testing.T, n int) []mailer.Message {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		got := append([]mailer.Message(nil), c.sent...)
		c.mu.Unlock()
		if len(got) >= n {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected %d emails", n)
	return nil
}

func (c *capture) count() int {
	time.Sleep(150 * time.Millisecond) // emails go out in the background
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.sent)
}

type person struct {
	id    uint
	email string
}

// newPerson makes a verified account with flashcards, `due` of them due today.
func newPerson(t *testing.T, email, zone string, reminders bool, due int) person {
	t.Helper()
	var id uint
	err := initializers.DB.Raw(`INSERT INTO users (email, password, created_at, updated_at, email_verified_at, time_zone)
		VALUES (?, 'x', now(), now(), now(), ?) RETURNING id`, email, zone).Scan(&id).Error
	if err != nil {
		t.Fatal(err)
	}
	if reminders {
		on := true
		if err := notices.Set(id, notices.Update{Reminders: &on}); err != nil {
			t.Fatal(err)
		}
	}
	doc := models.Document{Filename: "Cell biology", UserID: id, Summary: "", Content: "notes", HasContent: true}
	if err := initializers.DB.Create(&doc).Error; err != nil {
		t.Fatal(err)
	}
	cards := `{"flashcards":[{"front":"One","back":"1"},{"front":"Two","back":"2"},{"front":"Three","back":"3"}]}`
	if err := initializers.DB.Exec("UPDATE documents SET study = ?::jsonb WHERE id = ?", cards, doc.ID).Error; err != nil {
		t.Fatal(err)
	}
	for i, front := range []string{"One", "Two", "Three"} {
		dueOn := "2026-01-01" // long ago: due
		if i >= due {
			dueOn = "2099-01-01" // far away: not due
		}
		err := initializers.DB.Exec(`INSERT INTO card_reviews (user_id, document_id, card_key, box, due_on) VALUES (?, ?, ?, 2, ?::date)`,
			id, doc.ID, reviews.Key(front), dueOn).Error
		if err != nil {
			t.Fatal(err)
		}
	}
	return person{id, email}
}

// morning is 8:30 in Sarajevo (UTC+2 in October 2026), the first minutes of a reminder's window.
var morning = time.Date(2026, 10, 18, 6, 30, 0, 0, time.UTC)

func runReminders(t *testing.T, m mailer.Mailer, now time.Time) {
	t.Helper()
	if err := sendReminders(context.Background(), m, now); err != nil {
		t.Fatal(err)
	}
}

func TestAPersonWhoAskedIsRemindedInTheirMorningOfWhatIsDue(t *testing.T) {
	testutil.DB(t, "jobstest")
	t.Setenv("FRONTEND_URL", "https://inkling.example")
	p := newPerson(t, "ana@example.com", "Europe/Sarajevo", true, 2)
	m := &capture{}

	runReminders(t, m, morning)
	got := m.wait(t, 1)
	if len(got) != 1 {
		t.Fatalf("one email: %d", len(got))
	}
	msg := got[0]
	if msg.To != p.email || msg.Subject != "2 flashcards to review today" {
		t.Errorf("to %q, subject %q", msg.To, msg.Subject)
	}
	if !contains(msg.Text, "https://inkling.example/review") || !contains(msg.Text, "Cell biology") || !contains(msg.Text, "https://inkling.example/unsubscribe?token=") {
		t.Errorf("the text has the review link, the set's title and the way to stop: %s", msg.Text)
	}
	if msg.Headers["List-Unsubscribe"] == "" {
		t.Error("mail programs get an unsubscribe header")
	}
	if contains(msg.Text, "One") && contains(msg.Text, "Two") {
		t.Error("the cards themselves are not in the email")
	}
}

func TestTheReminderGoesOncePerDay(t *testing.T) {
	testutil.DB(t, "jobstest")
	newPerson(t, "ana@example.com", "Europe/Sarajevo", true, 1)
	m := &capture{}
	runReminders(t, m, morning)
	runReminders(t, m, morning.Add(time.Hour))
	runReminders(t, m, morning.Add(2*time.Hour))
	if n := m.count(); n != 1 {
		t.Errorf("one a day however often the job runs: %d", n)
	}
	runReminders(t, m, morning.Add(24*time.Hour))
	if n := m.count(); n != 2 {
		t.Errorf("and one the next day: %d", n)
	}
}

func TestNoReminderOutsideTheMorningWindowOrWhenNothingIsDueOrNotAskedFor(t *testing.T) {
	testutil.DB(t, "jobstest")
	newPerson(t, "late@example.com", "Europe/Sarajevo", true, 1)    // asked, due: but it is the wrong hour
	newPerson(t, "none@example.com", "Europe/Sarajevo", true, 0)    // asked, nothing due
	newPerson(t, "silent@example.com", "Europe/Sarajevo", false, 3) // due, but never asked
	m := &capture{}

	runReminders(t, m, time.Date(2026, 10, 18, 14, 0, 0, 0, time.UTC)) // 16:00 in Sarajevo
	runReminders(t, m, time.Date(2026, 10, 18, 3, 0, 0, 0, time.UTC))  // 05:00 in Sarajevo
	if n := m.count(); n != 0 {
		t.Fatalf("wrong hour: %d", n)
	}
	runReminders(t, m, morning)
	got := m.wait(t, 1)
	if len(got) != 1 || got[0].To != "late@example.com" {
		t.Errorf("only the person who asked and has cards due: %+v", got)
	}
}

func TestTheMorningIsThePersonsOwn(t *testing.T) {
	testutil.DB(t, "jobstest")
	newPerson(t, "tokyo@example.com", "Asia/Tokyo", true, 1)
	m := &capture{}
	// 06:30 UTC is 15:30 in Tokyo: not their morning. 23:30 UTC the evening before is 08:30 there.
	runReminders(t, m, morning)
	if n := m.count(); n != 0 {
		t.Fatalf("afternoon in Tokyo: %d", n)
	}
	runReminders(t, m, time.Date(2026, 10, 17, 23, 30, 0, 0, time.UTC))
	if n := m.count(); n != 1 {
		t.Errorf("morning in Tokyo: %d", n)
	}
}

func TestAnUnconfirmedAddressIsNotWrittenTo(t *testing.T) {
	testutil.DB(t, "jobstest")
	p := newPerson(t, "new@example.com", "Europe/Sarajevo", true, 1)
	if err := initializers.DB.Exec("UPDATE users SET email_verified_at = NULL WHERE id = ?", p.id).Error; err != nil {
		t.Fatal(err)
	}
	m := &capture{}
	runReminders(t, m, morning)
	if n := m.count(); n != 0 {
		t.Errorf("not confirmed: %d", n)
	}
}

func TestSwitchingRemindersOffStopsThem(t *testing.T) {
	testutil.DB(t, "jobstest")
	p := newPerson(t, "ana@example.com", "Europe/Sarajevo", true, 1)
	token, _ := notices.Token(p.id)
	notices.Unsubscribe(token, notices.KindReminders)
	m := &capture{}
	runReminders(t, m, morning)
	if n := m.count(); n != 0 {
		t.Errorf("after unsubscribing: %d", n)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
