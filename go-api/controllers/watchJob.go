package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/jobs"
	"ai-summarizer/go-api/mailer"
	"context"
	"fmt"
	"time"
)

const (
	// watchBatch is how many due pages are fetched from the database at a time, and maxWatchesPerRun how many one run of the
	// job looks at (the rest wait for the next run, an hour later).
	watchBatch       = 20
	maxWatchesPerRun = 100
)

// PageWatches is the scheduled job that opens the pages people watch when they are due.
func PageWatches(m mailer.Mailer) jobs.Job {
	return jobs.Job{
		Name:    "page-watches",
		Every:   time.Hour,
		Timeout: 30 * time.Minute,
		Run:     func(ctx context.Context, now time.Time) error { return checkDueWatches(ctx, m, now) },
	}
}

func checkDueWatches(ctx context.Context, m mailer.Mailer, now time.Time) error {
	seen := map[uint]bool{}
	for len(seen) < maxWatchesPerRun {
		var due []watchRecord
		err := initializers.DB.WithContext(ctx).Raw(`SELECT * FROM page_watches WHERE NOT paused AND next_check_at <= ?
			ORDER BY next_check_at, id LIMIT ?`, now, watchBatch).Scan(&due).Error
		if err != nil {
			return err
		}
		fresh := 0
		for _, w := range due {
			if seen[w.ID] {
				continue // its state could not be saved: not again in this run
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			seen[w.ID] = true
			fresh++
			checkWatch(ctx, m, w, fmt.Sprintf("watch-%d-%d", w.ID, time.Now().Unix()))
		}
		if fresh == 0 {
			return nil
		}
	}
	return nil
}
