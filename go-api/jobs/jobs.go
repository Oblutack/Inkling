// Package jobs runs the work that happens on a schedule rather than because someone clicked: the daily flashcard
// reminder, and later checking watched pages and sending the weekly digest.
//
// One ticker wakes every minute and runs each job that is due. When a job last ran and when it is next due are kept in the
// database (job_runs), so a restart neither repeats a job nor skips one. A job runs under a database advisory lock, so if
// the API were ever run as several copies, only one of them does a given job at a time.
//
// A job that fails, takes too long or panics is logged and tried again at its next turn; it never takes the server down.
// JOBS_ENABLED=false turns all of this off.
package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"ai-summarizer/go-api/initializers"

	"gorm.io/gorm"
)

// Job is one piece of scheduled work.
type Job struct {
	Name string
	// Every is how long to wait between runs.
	Every time.Duration
	// Timeout is how long one run may take (five minutes when not set).
	Timeout time.Duration
	// Run does the work. now is the time the run was started at.
	Run func(ctx context.Context, now time.Time) error
}

// Runner decides which jobs are due and runs them.
type Runner struct {
	Jobs []Job
	// Now is the clock; a test replaces it. Nil means the real one.
	Now func() time.Time
}

// Enabled says whether scheduled work is on (it is, unless JOBS_ENABLED says otherwise).
func Enabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("JOBS_ENABLED"))) {
	case "false", "0", "no", "off":
		return false
	}
	return true
}

// Start runs the jobs on a ticker until ctx ends.
func Start(ctx context.Context, jobs ...Job) {
	if !Enabled() {
		slog.Info("JOBS_ENABLED is off: scheduled work (reminders, page checks, digests) will not run")
		return
	}
	r := &Runner{Jobs: jobs}
	go r.Loop(ctx, time.Minute)
}

// Loop ticks every `every` until ctx ends.
func (r *Runner) Loop(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	r.Tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.Tick(ctx)
		}
	}
}

func (r *Runner) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Tick runs every job that is due.
func (r *Runner) Tick(ctx context.Context) {
	for _, j := range r.Jobs {
		if ctx.Err() != nil {
			return
		}
		r.runOne(ctx, j)
	}
}

func (r *Runner) runOne(ctx context.Context, j Job) {
	now := r.now()
	err := initializers.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var locked bool
		if err := tx.Raw("SELECT pg_try_advisory_xact_lock(hashtext(?))", "inkling-job:"+j.Name).Scan(&locked).Error; err != nil {
			return err
		}
		if !locked {
			return nil // another copy of the server is doing it
		}
		var due []time.Time
		if err := tx.Raw("SELECT next_run_at FROM job_runs WHERE name = ?", j.Name).Scan(&due).Error; err != nil {
			return err
		}
		if len(due) > 0 && due[0].After(now) {
			return nil
		}

		if runErr := invoke(ctx, j, now); runErr != nil {
			slog.Error("scheduled job failed", "job", j.Name, "error", runErr)
		}
		// Whether it worked or not, it is next due after its interval: a job that keeps failing must not be retried every minute.
		return tx.Exec(`INSERT INTO job_runs (name, last_run_at, next_run_at) VALUES (?, ?, ?)
			ON CONFLICT (name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, next_run_at = EXCLUDED.next_run_at`,
			j.Name, now, now.Add(j.Every)).Error
	})
	if err != nil {
		slog.Error("scheduling a job failed", "job", j.Name, "error", err)
	}
}

// invoke runs a job with its time limit, turning a panic into an error.
func invoke(ctx context.Context, j Job, now time.Time) (err error) {
	timeout := j.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return j.Run(ctx, now)
}
