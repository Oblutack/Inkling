package reviews

import (
	"testing"
	"time"
)

func TestARememberedCardMovesUpAFewBoxesAndWaitsLonger(t *testing.T) {
	box := 0
	var waits []int
	for i := 0; i < 8; i++ {
		var days int
		box, days = Next(box, true)
		waits = append(waits, days)
	}
	want := []int{2, 4, 8, 16, 32, 32, 32, 32} // the first time a card is known it skips box 1; the top box stays the top box
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("waits = %v, want %v", waits, want)
		}
	}
	if box != MaxBox {
		t.Errorf("box = %d, want %d", box, MaxBox)
	}
}

func TestAForgottenCardGoesBackToTheFirstBoxAndIsDueAgainToday(t *testing.T) {
	for _, from := range []int{0, 1, 3, MaxBox} {
		box, days := Next(from, false)
		if box != 1 || days != 0 {
			t.Errorf("forgotten from box %d: box %d, %d days; want box 1, due today", from, box, days)
		}
	}
}

func TestACardIsNamedByItsFrontWhateverTheSpacingAndCase(t *testing.T) {
	a := Key("What is a cell?")
	if a != Key("  what   IS a cell? ") {
		t.Error("spacing and capital letters do not make another card")
	}
	if a == Key("What is a cell") {
		t.Error("a different text is a different card")
	}
	if len(a) != 16 {
		t.Errorf("key length %d", len(a))
	}
}

func TestTodayIsTheCalendarDayInThePersonsOwnZone(t *testing.T) {
	moment := time.Date(2026, 10, 18, 23, 30, 0, 0, time.UTC)
	if got := Today(moment, time.UTC); got != "2026-10-18" {
		t.Errorf("UTC: %s", got)
	}
	tokyo, _ := time.LoadLocation("Asia/Tokyo")
	if got := Today(moment, tokyo); got != "2026-10-19" {
		t.Errorf("Tokyo is already tomorrow: %s", got)
	}
	honolulu, _ := time.LoadLocation("Pacific/Honolulu")
	if got := Today(moment, honolulu); got != "2026-10-18" {
		t.Errorf("Honolulu: %s", got)
	}
}

func TestDaysAreCountedAcrossMonthAndYearEnds(t *testing.T) {
	if got := addDays("2026-12-30", 5); got != "2027-01-04" {
		t.Errorf("year end: %s", got)
	}
	if got := addDays("2026-03-01", -1); got != "2026-02-28" {
		t.Errorf("month start: %s", got)
	}
	if got := addDays("not a day", 3); got != "not a day" {
		t.Errorf("a bad day is left as it is: %s", got)
	}
}

func TestAStreakIsDaysInARowAndSurvivesUntilAWholeDayIsMissed(t *testing.T) {
	cases := []struct {
		name  string
		days  []string
		today string
		want  int
	}{
		{"none", nil, "2026-10-18", 0},
		{"only today", []string{"2026-10-18"}, "2026-10-18", 1},
		{"three days ending today", []string{"2026-10-18", "2026-10-17", "2026-10-16"}, "2026-10-18", 3},
		{"today not done yet keeps yesterday's streak", []string{"2026-10-17", "2026-10-16"}, "2026-10-18", 2},
		{"a missed day ends it", []string{"2026-10-18", "2026-10-16", "2026-10-15"}, "2026-10-18", 1},
		{"two days ago is already over", []string{"2026-10-16", "2026-10-15"}, "2026-10-18", 0},
		{"order does not matter", []string{"2026-10-16", "2026-10-18", "2026-10-17"}, "2026-10-18", 3},
		{"across a month end", []string{"2026-11-01", "2026-10-31", "2026-10-30"}, "2026-11-01", 3},
	}
	for _, c := range cases {
		if got := streak(append([]string(nil), c.days...), c.today); got != c.want {
			t.Errorf("%s: streak %d, want %d", c.name, got, c.want)
		}
	}
}
