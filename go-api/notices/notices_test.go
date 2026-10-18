package notices

import (
	"strings"
	"testing"

	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/testutil"
)

func newUser(t *testing.T, email string) uint {
	t.Helper()
	var id uint
	err := initializers.DB.Raw(`INSERT INTO users (email, password, created_at, updated_at, email_verified_at)
		VALUES (?, 'x', now(), now(), now()) RETURNING id`, email).Scan(&id).Error
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func yes() *bool { v := true; return &v }
func no() *bool  { v := false; return &v }

func TestWhatIsOnByDefaultIsOnlyWhatThePersonAskedFor(t *testing.T) {
	testutil.DB(t, "noticestest")
	id := newUser(t, "a@example.com")
	p, err := PrefsOf(id)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Watch || p.Reminders || p.Digest || p.TimeZone != "" {
		t.Errorf("defaults: %+v", p)
	}
	if !Wants(id, KindWatch) || Wants(id, KindReminders) || Wants(id, KindDigest) || Wants(id, "nonsense") {
		t.Error("Wants follows the defaults, and an unknown kind is never wanted")
	}
}

func TestOnlyWhatIsNamedChanges(t *testing.T) {
	testutil.DB(t, "noticestest")
	id := newUser(t, "a@example.com")
	if err := Set(id, Update{Reminders: yes()}); err != nil {
		t.Fatal(err)
	}
	if err := Set(id, Update{Watch: no()}); err != nil {
		t.Fatal(err)
	}
	p, _ := PrefsOf(id)
	if p.Watch || !p.Reminders || p.Digest {
		t.Errorf("after two changes: %+v", p)
	}
	other := newUser(t, "b@example.com")
	if q, _ := PrefsOf(other); !q.Watch || q.Reminders {
		t.Errorf("another person is not affected: %+v", q)
	}
}

func TestATimeZoneMustBeARealOne(t *testing.T) {
	testutil.DB(t, "noticestest")
	id := newUser(t, "a@example.com")
	for _, bad := range []string{"Mars/Olympus", "europe sarajevo", "../../etc/passwd", "Europe/Sarajevo\n"} {
		z := bad
		if err := Set(id, Update{TimeZone: &z}); err != ErrBadTimeZone {
			t.Errorf("%q should be refused, got %v", bad, err)
		}
	}
	good := "Europe/Sarajevo"
	if err := Set(id, Update{TimeZone: &good}); err != nil {
		t.Fatal(err)
	}
	if p, _ := PrefsOf(id); p.TimeZone != good {
		t.Errorf("zone = %q", p.TimeZone)
	}
	if Location("Europe/Sarajevo").String() != "Europe/Sarajevo" || Location("").String() != "UTC" || Location("nope").String() != "UTC" {
		t.Error("Location falls back to UTC")
	}
}

func TestTheUnsubscribeLinkSwitchesOffOneKindOrAll(t *testing.T) {
	testutil.DB(t, "noticestest")
	id := newUser(t, "a@example.com")
	_ = Set(id, Update{Reminders: yes(), Digest: yes()})

	token, err := Token(id)
	if err != nil || len(token) < 40 {
		t.Fatalf("token %q, %v", token, err)
	}
	if again, _ := Token(id); again != token {
		t.Error("the same person always gets the same link")
	}
	if other, _ := Token(newUser(t, "b@example.com")); other == token {
		t.Error("each person has their own")
	}

	Unsubscribe(token, KindReminders)
	if p, _ := PrefsOf(id); p.Reminders || !p.Digest || !p.Watch {
		t.Errorf("one kind off: %+v", p)
	}
	Unsubscribe(token, KindAll)
	if p, _ := PrefsOf(id); p.Watch || p.Reminders || p.Digest {
		t.Errorf("everything off: %+v", p)
	}
}

func TestAnUnsubscribeLinkThatMatchesNobodyChangesNothing(t *testing.T) {
	testutil.DB(t, "noticestest")
	id := newUser(t, "a@example.com")
	_ = Set(id, Update{Reminders: yes()})
	Unsubscribe("", KindAll)
	Unsubscribe("short", KindAll)
	Unsubscribe(strings.Repeat("x", 43), KindAll)
	token, _ := Token(id)
	Unsubscribe(token, "nonsense")
	if p, _ := PrefsOf(id); !p.Watch || !p.Reminders {
		t.Errorf("nothing should have changed: %+v", p)
	}
}

func TestAnEmailOfAKindGoesOncePerDay(t *testing.T) {
	testutil.DB(t, "noticestest")
	id := newUser(t, "a@example.com")
	if !FirstToday(id, KindReminders, "2026-10-18") {
		t.Error("the first time is the first")
	}
	if FirstToday(id, KindReminders, "2026-10-18") {
		t.Error("the second time the same day is not")
	}
	if !FirstToday(id, KindReminders, "2026-10-19") || !FirstToday(id, KindDigest, "2026-10-18") {
		t.Error("another day or another kind is its own")
	}
	Forget(id, KindReminders, "2026-10-18")
	if !FirstToday(id, KindReminders, "2026-10-18") {
		t.Error("after forgetting, it can be sent")
	}
}
