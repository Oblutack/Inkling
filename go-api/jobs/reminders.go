package jobs

import (
	"context"
	"fmt"
	"time"

	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/mailer"
	"ai-summarizer/go-api/notices"
	"ai-summarizer/go-api/reviews"
)

// The daily flashcard reminder goes out in the morning of the person's own day: the first run of the job inside this window
// sends it. A window, not an exact hour, because the job runs about once an hour and may be late (a restart, a busy server).
const (
	reminderFromHour = 8
	reminderToHour   = 11
	reminderBatch    = 200
)

// StudyReminders is the job that emails people who asked for it when they have flashcards due. It runs about every hour,
// and sends each person at most one email a day, only when something is due, and only if they confirmed their address.
func StudyReminders(m mailer.Mailer) Job {
	return Job{
		Name:  "study-reminders",
		Every: time.Hour,
		Run:   func(ctx context.Context, now time.Time) error { return sendReminders(ctx, m, now) },
	}
}

func sendReminders(ctx context.Context, m mailer.Mailer, now time.Time) error {
	var after uint
	for {
		var people []struct {
			ID       uint
			Email    string
			TimeZone string
		}
		err := initializers.DB.WithContext(ctx).Raw(`SELECT id, email, time_zone FROM users
			WHERE id > ? AND deleted_at IS NULL AND email_verified_at IS NOT NULL AND (email_prefs->>'reminders')::boolean IS TRUE
			ORDER BY id LIMIT ?`, after, reminderBatch).Scan(&people).Error
		if err != nil {
			return err
		}
		for _, p := range people {
			after = p.ID
			if ctx.Err() != nil {
				return ctx.Err()
			}
			remindOne(m, p.ID, p.Email, p.TimeZone, now)
		}
		if len(people) < reminderBatch {
			return nil
		}
	}
}

func remindOne(m mailer.Mailer, userID uint, address, zone string, now time.Time) {
	loc := notices.Location(zone)
	if hour := now.In(loc).Hour(); hour < reminderFromHour || hour > reminderToHour {
		return
	}
	day := reviews.Today(now, loc)
	due, total, err := reviews.Due(userID, day, 5)
	if err != nil || total == 0 {
		return
	}
	if !notices.FirstToday(userID, notices.KindReminders, day) {
		return
	}
	sent := notices.Send(m, userID, address, notices.KindReminders, func(unsubscribe string) mailer.Message {
		var lines []string
		seen := map[uint]bool{}
		for _, c := range due {
			if !seen[c.DocumentID] {
				seen[c.DocumentID] = true
				lines = append(lines, c.Title)
			}
		}
		subject := "1 flashcard to review today"
		intro := "One flashcard is due for review today."
		if total != 1 {
			subject = fmt.Sprintf("%d flashcards to review today", total)
			intro = fmt.Sprintf("%d flashcards are due for review today.", total)
		}
		return mailer.Notice("", subject, "Time to review", intro, lines, "Start reviewing",
			notices.PageURL("/review"), "You get this because you switched on study reminders.", unsubscribe)
	})
	if !sent {
		notices.Forget(userID, notices.KindReminders, day)
	}
}
