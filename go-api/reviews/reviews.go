// Package reviews is spaced repetition for flashcards: a card is shown again after a time that grows each time it is
// remembered and shrinks back when it is forgotten, so what is known is seen rarely and what is not is seen often.
//
// The rule is the Leitner boxes, which is easy to explain: a card is in a box from 1 to 6, and the box says how long to wait.
// Remembering moves it up a box; forgetting puts it back in box 1 and makes it due again today. The waits are 1, 2, 4, 8, 16
// and 32 days.
//
// A card has no id of its own: the cards of a set are kept in documents.study and "write new ones" replaces them. So a card
// is known by the start of the SHA-256 of its front text, and the progress of cards that are no longer in the set is dropped.
//
// Every day here is a calendar day in the person's own time zone, written "2006-01-02": "due today" means their today.
package reviews

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/notices"
)

// MaxBox is the highest box: a card there is shown every 32 days.
const MaxBox = 6

var intervalDays = [MaxBox + 1]int{0, 1, 2, 4, 8, 16, 32}

// Next is where a card goes after being remembered or forgotten, and how many days until it is due. box 0 is a card that has
// never been reviewed. A forgotten card is due again today (0 days), so it comes back before the session is over.
func Next(box int, knew bool) (newBox, days int) {
	if !knew {
		return 1, 0
	}
	newBox = max(min(box+1, MaxBox), 2) // a card never rated starts in box 1, so remembering it goes to box 2
	return newBox, intervalDays[newBox]
}

// Card is a flashcard of a set.
type Card struct {
	Front string `json:"front"`
	Back  string `json:"back"`
}

// Key identifies a card within its set.
func Key(front string) string {
	normal := strings.ToLower(strings.Join(strings.Fields(front), " "))
	sum := sha256.Sum256([]byte(normal))
	return hex.EncodeToString(sum[:])[:16]
}

// StoredCards are the flashcards kept with a document.
func StoredCards(documentID uint) []Card {
	var raw sql.NullString
	if err := initializers.DB.Raw("SELECT (study->'flashcards')::text FROM documents WHERE id = ?", documentID).Scan(&raw).Error; err != nil || !raw.Valid {
		return nil
	}
	var cards []Card
	if err := json.Unmarshal([]byte(raw.String), &cards); err != nil {
		return nil
	}
	return cards
}

// Today is the calendar day of now in a zone.
func Today(now time.Time, loc *time.Location) string { return now.In(loc).Format("2006-01-02") }

// LocationOf is the zone a person set, or UTC.
func LocationOf(userID uint) *time.Location {
	var zone string
	_ = initializers.DB.Raw("SELECT time_zone FROM users WHERE id = ?", userID).Scan(&zone).Error
	return notices.Location(zone)
}

func addDays(day string, n int) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	return t.AddDate(0, 0, n).Format("2006-01-02")
}

// ErrNoSuchCard is returned for a card that is not (or no longer) in the set.
var ErrNoSuchCard = errors.New("that card is not in this set")

// Result is where a rated card went.
type Result struct {
	Box   int    `json:"box"`
	DueOn string `json:"dueOn"`
}

// Rate records that a person remembered a card or not. The card must be one of the set's.
func Rate(userID, documentID uint, front string, knew bool, day string) (Result, error) {
	key := Key(front)
	found := false
	for _, c := range StoredCards(documentID) {
		if Key(c.Front) == key {
			found = true
			break
		}
	}
	if !found {
		return Result{}, ErrNoSuchCard
	}

	var box sql.NullInt64
	if err := initializers.DB.Raw("SELECT box FROM card_reviews WHERE document_id = ? AND card_key = ?", documentID, key).Scan(&box).Error; err != nil {
		return Result{}, err
	}
	newBox, days := Next(int(box.Int64), knew)
	due := addDays(day, days)
	lapse := 0
	if !knew {
		lapse = 1
	}
	err := initializers.DB.Exec(`INSERT INTO card_reviews (user_id, document_id, card_key, box, due_on, reviews, lapses, last_reviewed_at)
		VALUES (?, ?, ?, ?, ?::date, 1, ?, now())
		ON CONFLICT (document_id, card_key) DO UPDATE SET box = EXCLUDED.box, due_on = EXCLUDED.due_on,
			reviews = card_reviews.reviews + 1, lapses = card_reviews.lapses + EXCLUDED.lapses, last_reviewed_at = now()`,
		userID, documentID, key, newBox, due, lapse).Error
	if err != nil {
		return Result{}, err
	}
	err = initializers.DB.Exec(`INSERT INTO review_days (user_id, day, count) VALUES (?, ?::date, 1)
		ON CONFLICT (user_id, day) DO UPDATE SET count = review_days.count + 1`, userID, day).Error
	if err != nil {
		return Result{}, err
	}
	return Result{Box: newBox, DueOn: due}, nil
}

// DueCard is a card to review now, with the document it belongs to.
type DueCard struct {
	DocumentID uint   `json:"documentId"`
	Title      string `json:"title"`
	Front      string `json:"front"`
	Back       string `json:"back"`
	Box        int    `json:"box"`
	DueOn      string `json:"dueOn"`
}

// maxDueLookup bounds how many due rows are read to find the cards behind them.
const maxDueLookup = 400

// Due lists the cards due on or before day, the ones due longest ago first, and how many are due in all (up to a bound).
// Progress of cards that are no longer in their set is removed on the way.
func Due(userID uint, day string, limit int) (cards []DueCard, total int, err error) {
	var rows []struct {
		DocumentID uint
		CardKey    string
		Box        int
		DueOn      string
		Filename   string
	}
	err = initializers.DB.Raw(`SELECT cr.document_id, cr.card_key, cr.box, cr.due_on::text AS due_on, d.filename
		FROM card_reviews cr JOIN documents d ON d.id = cr.document_id AND d.user_id = cr.user_id
		WHERE cr.user_id = ? AND cr.due_on <= ?::date AND d.deleted_at IS NULL
		ORDER BY cr.due_on, cr.box, cr.document_id, cr.card_key LIMIT ?`, userID, day, maxDueLookup).Scan(&rows).Error
	if err != nil {
		return nil, 0, err
	}

	byDocument := map[uint]map[string]Card{}
	for _, r := range rows {
		if _, ok := byDocument[r.DocumentID]; ok {
			continue
		}
		set := map[string]Card{}
		for _, c := range StoredCards(r.DocumentID) {
			set[Key(c.Front)] = c
		}
		byDocument[r.DocumentID] = set
	}
	for _, r := range rows {
		card, ok := byDocument[r.DocumentID][r.CardKey]
		if !ok {
			_ = initializers.DB.Exec("DELETE FROM card_reviews WHERE document_id = ? AND card_key = ?", r.DocumentID, r.CardKey).Error
			continue
		}
		total++
		if limit <= 0 || len(cards) < limit {
			cards = append(cards, DueCard{DocumentID: r.DocumentID, Title: r.Filename, Front: card.Front, Back: card.Back, Box: r.Box, DueOn: r.DueOn})
		}
	}
	return cards, total, nil
}

// ProgressItem is how well one card of a set is known.
type ProgressItem struct {
	Front string `json:"front"`
	Box   int    `json:"box"`
	DueOn string `json:"dueOn"`
	Due   bool   `json:"due"`
}

// Progress is what has been reviewed of a set, by card (a card never rated is not listed).
func Progress(documentID uint, day string) ([]ProgressItem, error) {
	var rows []struct {
		CardKey string
		Box     int
		DueOn   string
	}
	if err := initializers.DB.Raw("SELECT card_key, box, due_on::text AS due_on FROM card_reviews WHERE document_id = ?", documentID).Scan(&rows).Error; err != nil {
		return nil, err
	}
	known := map[string]struct {
		box   int
		dueOn string
	}{}
	for _, r := range rows {
		known[r.CardKey] = struct {
			box   int
			dueOn string
		}{r.Box, r.DueOn}
	}
	items := []ProgressItem{}
	for _, c := range StoredCards(documentID) {
		if k, ok := known[Key(c.Front)]; ok {
			items = append(items, ProgressItem{Front: c.Front, Box: k.box, DueOn: k.dueOn, Due: k.dueOn <= day})
		}
	}
	return items, nil
}

// Keep removes the progress of cards that are not in the set any more (after "write new ones"), and all of it when the set
// has no cards.
func Keep(documentID uint, cards []Card) {
	keys := make([]string, 0, len(cards))
	for _, c := range cards {
		keys = append(keys, Key(c.Front))
	}
	if len(keys) == 0 {
		_ = initializers.DB.Exec("DELETE FROM card_reviews WHERE document_id = ?", documentID).Error
		return
	}
	_ = initializers.DB.Exec("DELETE FROM card_reviews WHERE document_id = ? AND card_key NOT IN ?", documentID, keys).Error
}

// Stats is a person's review record.
type Stats struct {
	DueToday      int `json:"dueToday"`
	ReviewedToday int `json:"reviewedToday"`
	Streak        int `json:"streak"`
	TotalReviews  int `json:"totalReviews"`
}

// StatsOf is the record as of a day: how many cards are due, how many were reviewed today, and the streak (the days in a
// row with at least one card reviewed, counting back from today, or from yesterday if today has no review yet).
func StatsOf(userID uint, day string) (Stats, error) {
	var s Stats
	_, due, err := Due(userID, day, 0)
	if err != nil {
		return s, err
	}
	s.DueToday = due

	var days []string
	if err := initializers.DB.Raw("SELECT day::text FROM review_days WHERE user_id = ? AND count > 0 ORDER BY day DESC LIMIT 800", userID).Scan(&days).Error; err != nil {
		return s, err
	}
	_ = initializers.DB.Raw("SELECT COALESCE(SUM(count), 0) FROM review_days WHERE user_id = ?", userID).Scan(&s.TotalReviews).Error
	var today int
	_ = initializers.DB.Raw("SELECT COALESCE(count, 0) FROM review_days WHERE user_id = ? AND day = ?::date", userID, day).Scan(&today).Error
	s.ReviewedToday = today
	s.Streak = streak(days, day)
	return s, nil
}

// streak counts the consecutive days at the start of days (newest first), beginning at today or, when today has no review,
// at yesterday: a streak is not lost until a whole day has passed without one.
func streak(days []string, today string) int {
	sort.Sort(sort.Reverse(sort.StringSlice(days)))
	want := today
	if len(days) > 0 && days[0] != today {
		want = addDays(today, -1)
	}
	n := 0
	for _, d := range days {
		if d != want {
			if d > want {
				continue
			}
			break
		}
		n++
		want = addDays(want, -1)
	}
	return n
}
