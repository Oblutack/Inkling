package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/jobs"
	"ai-summarizer/go-api/mailer"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/notices"
	"ai-summarizer/go-api/reviews"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// The weekly digest: for people who switched it on, one email on Sunday morning (their own) with what they saved to read
// this week, each item in a few lines, and one short paragraph on how those fit together. It is sent only when something
// was saved, only to a confirmed address, and never twice in a day.
const (
	digestWeekday  = time.Sunday
	digestFromHour = 8
	digestToHour   = 11
	digestBatch    = 100
	// An item is "this week's" when it was saved in the last seven days, and the digest holds the newest of them.
	digestWindow = 7 * 24 * time.Hour
	maxDigestIDs = 12
	// The paragraph on how the items fit together is one summary of the person's allowance, made only for two or more.
	digestConnectionWords = 80
	digestLineRunes       = 320
	digestConnectionRunes = 600
)

// digestEnabled is DIGEST_ENABLED: the weekly digest is on unless it is set to false.
func digestEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("DIGEST_ENABLED")))
	return v != "false" && v != "0" && v != "off"
}

// ReadingDigest is the scheduled job that sends the weekly digest. It runs about every hour; the first run inside the
// window of a person's Sunday morning sends theirs.
func ReadingDigest(m mailer.Mailer) jobs.Job {
	return jobs.Job{
		Name:    "reading-digest",
		Every:   time.Hour,
		Timeout: 30 * time.Minute,
		Run: func(ctx context.Context, now time.Time) error {
			if !digestEnabled() {
				return nil
			}
			return sendDigests(ctx, m, now)
		},
	}
}

func sendDigests(ctx context.Context, m mailer.Mailer, now time.Time) error {
	var after uint
	for {
		var people []struct {
			ID       uint
			Email    string
			TimeZone string
		}
		err := initializers.DB.WithContext(ctx).Raw(`SELECT id, email, time_zone FROM users
			WHERE id > ? AND deleted_at IS NULL AND email_verified_at IS NOT NULL AND (email_prefs->>'digest')::boolean IS TRUE
			ORDER BY id LIMIT ?`, after, digestBatch).Scan(&people).Error
		if err != nil {
			return err
		}
		for _, p := range people {
			after = p.ID
			if ctx.Err() != nil {
				return ctx.Err()
			}
			digestOne(ctx, m, p.ID, p.Email, p.TimeZone, now)
		}
		if len(people) < digestBatch {
			return nil
		}
	}
}

type digestItem struct {
	ID      uint
	Title   string
	Summary string
}

func digestOne(ctx context.Context, m mailer.Mailer, userID uint, address, zone string, now time.Time) {
	loc := notices.Location(zone)
	local := now.In(loc)
	if local.Weekday() != digestWeekday || local.Hour() < digestFromHour || local.Hour() > digestToHour {
		return
	}
	var items []digestItem
	err := initializers.DB.WithContext(ctx).Raw(`SELECT d.id, d.filename AS title, d.summary
		FROM reading_items r JOIN documents d ON d.id = r.document_id
		WHERE r.user_id = ? AND d.deleted_at IS NULL AND r.read_at IS NULL AND r.archived_at IS NULL AND r.saved_at > ?
		ORDER BY r.saved_at DESC, d.id DESC LIMIT ?`, userID, now.Add(-digestWindow), maxDigestIDs).Scan(&items).Error
	if err != nil || len(items) == 0 {
		return
	}
	day := reviews.Today(now, loc)
	if !notices.FirstToday(userID, notices.KindDigest, day) {
		return
	}

	connection := digestConnection(ctx, userID, items)
	sent := notices.Send(m, userID, address, notices.KindDigest, func(unsubscribe string) mailer.Message {
		lines := make([]string, 0, len(items))
		for _, item := range items {
			lines = append(lines, item.Title+": "+clip(plainSummaryLine(item.Summary), digestLineRunes))
		}
		subject := "1 thing you saved this week"
		intro := "Here is what you saved to read this week."
		if len(items) != 1 {
			subject = fmt.Sprintf("%d things you saved this week", len(items))
		}
		if connection != "" {
			intro += " How they fit together: " + connection
		}
		return mailer.Notice("", subject, "Your week in reading", intro, lines, "Open your reading list",
			notices.PageURL("/reading"), "You get this because you switched on the weekly reading digest.", unsubscribe)
	})
	if !sent {
		notices.Forget(userID, notices.KindDigest, day)
	}
}

var markdownMarks = regexp.MustCompile(`[#*_` + "`" + `>]+|^\s*[-•]\s+`)

// plainSummaryLine is a Markdown text as one plain line: no marks, no line breaks.
func plainSummaryLine(markdown string) string {
	lines := strings.Split(markdown, "\n")
	for i, line := range lines {
		lines[i] = markdownMarks.ReplaceAllString(strings.TrimSpace(line), "")
	}
	return strings.Join(strings.Fields(strings.Join(lines, " ")), " ")
}

// digestConnection asks for one short paragraph on how the saved items fit together: what they share and where they differ,
// written from their short summaries. It is made only for two or more items, and counts as one summary of the person's
// allowance and of the site's budget (like any work the server starts by itself); with neither to spare, or if the model
// fails, the email goes out without it.
func digestConnection(ctx context.Context, userID uint, items []digestItem) string {
	if len(items) < 2 {
		return ""
	}
	claim, why, err := middleware.ClaimBackgroundWork(userID)
	if err != nil || claim == nil {
		if err != nil {
			slog.Error("digest: could not count the overview", "user_id", userID, "error", err)
		} else {
			slog.Info("digest: no overview for this one", "user_id", userID, "why", why)
		}
		return ""
	}
	documents := make([]overviewDocument, 0, len(items))
	for i := len(items) - 1; i >= 0; i-- { // oldest first
		documents = append(documents, overviewDocument{Name: items[i].Title, Text: truncateRunes(items[i].Summary, maxOverviewSummaryRunes)})
	}
	reply, apiErr := postToAIContext(ctx, fmt.Sprintf("digest-%d-%d", userID, time.Now().Unix()),
		fmt.Sprintf("/overview?style=glance&word_count=%d", digestConnectionWords), map[string]any{"name": "this week", "documents": documents})
	if apiErr != nil {
		claim.Release()
		slog.Warn("digest: the overview could not be made", "user_id", userID, "status", apiErr.Status)
		return ""
	}
	var out struct {
		Summary string `json:"summary"`
	}
	if json.Unmarshal(reply, &out) != nil || strings.TrimSpace(out.Summary) == "" {
		claim.Release()
		return ""
	}
	text := plainSummaryLine(out.Summary)
	if utf8.RuneCountInString(text) > digestConnectionRunes {
		text = clip(text, digestConnectionRunes)
	}
	return text
}
