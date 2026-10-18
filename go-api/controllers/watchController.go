package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/mailer"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/notices"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Watching a page: Inkling opens it now and then (a scheduled job, or "check now"), and when its text has changed in a way
// that counts, says what changed. The changes are found by a program, as in a comparison of two documents; the model only
// explains them. A page that has not changed costs no AI at all: its text is compared with the last one first.
//
// A person may watch WATCHES_PER_USER pages (10), each checked every WATCH_MIN_HOURS hours at the soonest (12). A page that
// changed uses one of their daily summaries; when none is left (or the site's budget is used up) the change is not lost: the
// page is simply looked at again a few hours later, and the change is still there. A page that cannot be read five times in
// a row is paused, with an email saying so. Sites that ask in robots.txt not to be checked are refused.

const (
	defaultWatchesPerUser = 10
	defaultWatchMinHours  = 12
	defaultWatchHours     = 24
	maxWatchHours         = 24 * 30
	// maxWatchFailures is how many failed reads in a row pause a watch.
	maxWatchFailures = 5
	// maxChangesKept is how many changes are kept per watch (the newest).
	maxChangesKept = 20
	// maxWatchText bounds the text kept of a page: what a comparison can take.
	maxWatchText = 300_000
	// waitingRetry is how long to wait before looking again when a change could not be explained for want of allowance.
	waitingRetry = 6 * time.Hour
	// explainRetry is the wait after the AI service could not explain a change.
	explainRetry  = time.Hour
	maxWatchError = 300
)

func watchEnvInt(name string, fallback, least int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && v >= least {
		return v
	}
	return fallback
}

func watchesPerUser() int { return watchEnvInt("WATCHES_PER_USER", defaultWatchesPerUser, 1) }
func watchMinHours() int  { return watchEnvInt("WATCH_MIN_HOURS", defaultWatchMinHours, 1) }

// watchCheckNowMinutes is how long after a check "check now" is refused, so a person cannot make Inkling open a page over
// and over (0 turns the wait off, for tests).
func watchCheckNowMinutes() int { return watchEnvInt("WATCH_CHECK_NOW_MINUTES", 10, 0) }

var importanceRank = map[string]int{"low": 1, "medium": 2, "high": 3}

// watchEmailMinImportance is the least important change that is worth an email (WATCH_EMAIL_MIN_IMPORTANCE: low, medium or
// high; medium unless set).
func watchEmailMinImportance() int {
	if rank, ok := importanceRank[strings.ToLower(strings.TrimSpace(os.Getenv("WATCH_EMAIL_MIN_IMPORTANCE")))]; ok {
		return rank
	}
	return importanceRank["medium"]
}

type watchRecord struct {
	ID            uint
	UserID        uint
	URL           string
	Title         string
	LastText      string
	LastHash      string
	EveryHours    int
	Failures      int
	Paused        bool
	LastError     string
	LastCheckedAt *time.Time
	LastChangedAt *time.Time
	CreatedAt     time.Time
}

// ---- keeping the noise out ---------------------------------------------------------------------------------

// Parts of a page that differ on every visit without the page having changed: the time, "5 minutes ago". They are taken
// out of the text before it is hashed, so a page that only ticks is not a change.
var watchNoise = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b`),
	regexp.MustCompile(`(?i)\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b`),
}

// watchHash identifies the text of a page for deciding whether it changed: spacing, line breaks and the noise above do
// not count.
func watchHash(text string) string {
	normal := strings.Join(strings.Fields(text), " ")
	for _, noise := range watchNoise {
		normal = noise.ReplaceAllString(normal, "#")
	}
	sum := sha256.Sum256([]byte(normal))
	return hex.EncodeToString(sum[:])
}

// ---- reading a page ----------------------------------------------------------------------------------------

// readWatchedPage opens a page through the AI service, which refuses addresses off the public internet and sites whose
// robots.txt says no to being checked automatically.
func readWatchedPage(ctx context.Context, requestID, address string) (title, text string, apiErr *apiError) {
	body, apiErr := postToAIContext(ctx, requestID, "/read-url?watch=true", URLPayload{URL: address})
	if apiErr != nil {
		return "", "", apiErr
	}
	var out aiRead
	if err := json.Unmarshal(body, &out); err != nil || strings.TrimSpace(out.Text) == "" {
		return "", "", &apiError{http.StatusBadGateway, "The page had no readable text."}
	}
	return cleanLine(out.Filename), truncateRunes(out.Text, maxWatchText), nil
}

// ---- what a check found -------------------------------------------------------------------------------------

// Outcomes of a check.
const (
	checkUnchanged = "unchanged" // the page is as it was
	checkIdentical = "identical" // its text differs only in ways that do not count (spacing, punctuation)
	checkChanged   = "changed"   // something changed and was written up
	checkWaiting   = "waiting"   // something changed, but there was no allowance to explain it: looked at again later
	checkFailed    = "failed"    // the page could not be read, or the change could not be explained
)

type checkResult struct {
	Status string `json:"status"`
	// Changes is how many changes were found, Important how many of them are worth an email.
	Changes   int    `json:"changes"`
	Important int    `json:"important"`
	Message   string `json:"message,omitempty"`
}

func topImportance(changes []compareChange) string {
	top := ""
	for _, c := range changes {
		if importanceRank[c.Importance] > importanceRank[top] {
			top = c.Importance
		}
	}
	return top
}

func countAtLeast(changes []compareChange, least int) int {
	n := 0
	for _, c := range changes {
		if importanceRank[c.Importance] >= least {
			n++
		}
	}
	return n
}

// checkWatch opens a watched page and, if it changed, writes the change up. It records what happened in either case (when
// the page is next due, what went wrong) and emails the person when something worth knowing changed.
func checkWatch(ctx context.Context, m mailer.Mailer, w watchRecord, requestID string) checkResult {
	now := time.Now()
	every := time.Duration(w.EveryHours) * time.Hour

	title, text, apiErr := readWatchedPage(ctx, requestID, w.URL)
	if apiErr != nil {
		return recordWatchFailure(m, w, apiErr.Message, now)
	}
	hash := watchHash(text)
	if title == "" {
		title = w.Title
	}

	if hash == w.LastHash {
		saveWatchState(w.ID, `last_checked_at = ?, next_check_at = ?, failures = 0, last_error = '', title = ?`, now, now.Add(every), title)
		return checkResult{Status: checkUnchanged}
	}

	claim, reason, err := middleware.ClaimBackgroundWork(w.UserID)
	if err != nil || claim == nil {
		message := "Waiting for your daily allowance: the change will be looked at again later."
		if reason == middleware.NoBudget {
			message = "Waiting: Inkling's AI limit for today was reached. The change will be looked at again later."
		}
		if err != nil {
			message = "Could not check your usage just now: the change will be looked at again later."
		}
		saveWatchState(w.ID, `last_checked_at = ?, next_check_at = ?, last_error = ?`, now, now.Add(waitingRetry), message)
		return checkResult{Status: checkWaiting, Message: message}
	}

	result, apiErr := compareTexts(ctx, requestID, w.Title, w.LastText, title, text, "")
	if apiErr != nil {
		claim.Release()
		message := "Could not explain the changes just now: they will be looked at again later."
		saveWatchState(w.ID, `last_checked_at = ?, next_check_at = ?, last_error = ?`, now, now.Add(explainRetry), message)
		return checkResult{Status: checkFailed, Message: message}
	}

	if result.Identical || len(result.Changes) == 0 {
		// Nothing that counts as a change (spacing, line breaks, punctuation): move on without keeping a record. No model was
		// asked, so the allowance is given back.
		claim.Release()
		saveWatchState(w.ID, `last_text = ?, last_hash = ?, title = ?, last_checked_at = ?, next_check_at = ?, failures = 0, last_error = ''`,
			text, hash, title, now, now.Add(every))
		return checkResult{Status: checkIdentical}
	}

	top := topImportance(result.Changes)
	comparison, _ := json.Marshal(result)
	counts, _ := json.Marshal(result.Counts)
	err = initializers.DB.Exec(`INSERT INTO watch_changes (watch_id, found_at, title, comparison, bottom_line, top_importance, counts)
		VALUES (?, ?, ?, ?::jsonb, ?, ?, ?::jsonb)`, w.ID, now, title, string(comparison), result.BottomLine, top, string(counts)).Error
	if err != nil {
		slog.Error("keeping a change of a watched page failed", "watch_id", w.ID, "error", err, "request_id", requestID)
		return checkResult{Status: checkFailed, Message: "Could not keep the change just now."}
	}
	_ = initializers.DB.Exec(`DELETE FROM watch_changes WHERE watch_id = ? AND id NOT IN
		(SELECT id FROM watch_changes WHERE watch_id = ? ORDER BY found_at DESC, id DESC LIMIT ?)`, w.ID, w.ID, maxChangesKept).Error
	saveWatchState(w.ID, `last_text = ?, last_hash = ?, title = ?, last_checked_at = ?, last_changed_at = ?, next_check_at = ?, failures = 0, last_error = ''`,
		text, hash, title, now, now, now.Add(every))

	important := countAtLeast(result.Changes, watchEmailMinImportance())
	if important > 0 {
		emailWatchChange(m, w, title, result, important)
	}
	return checkResult{Status: checkChanged, Changes: len(result.Changes), Important: important}
}

func saveWatchState(id uint, set string, args ...any) {
	args = append(args, id)
	if err := initializers.DB.Exec("UPDATE page_watches SET "+set+" WHERE id = ?", args...).Error; err != nil {
		slog.Error("saving the state of a watched page failed", "watch_id", id, "error", err)
	}
}

// recordWatchFailure notes that a page could not be read. After maxWatchFailures in a row the watch is paused, and the person
// is told once.
func recordWatchFailure(m mailer.Mailer, w watchRecord, reason string, now time.Time) checkResult {
	failures := w.Failures + 1
	paused := failures >= maxWatchFailures
	reason = truncateRunes(reason, maxWatchError)
	saveWatchState(w.ID, `failures = ?, last_error = ?, last_checked_at = ?, next_check_at = ?, paused = ?`,
		failures, reason, now, now.Add(time.Duration(w.EveryHours)*time.Hour), paused)
	if paused {
		emailWatchPaused(m, w, reason)
	}
	return checkResult{Status: checkFailed, Message: reason}
}

func watcherEmail(userID uint) string {
	var address string
	_ = initializers.DB.Raw(`SELECT email FROM users WHERE id = ? AND deleted_at IS NULL AND email_verified_at IS NOT NULL`, userID).Scan(&address).Error
	return address
}

func emailWatchChange(m mailer.Mailer, w watchRecord, title string, result compareResult, important int) {
	address := watcherEmail(w.UserID)
	if address == "" {
		return
	}
	shown := append([]compareChange(nil), result.Changes...)
	sort.SliceStable(shown, func(i, j int) bool { return importanceRank[shown[i].Importance] > importanceRank[shown[j].Importance] })
	lines := []string{}
	for _, c := range shown {
		if len(lines) == 5 {
			break
		}
		say := strings.TrimSpace(c.Summary)
		if say == "" {
			say = clip(strings.TrimSpace(c.After+c.Before), 140)
		}
		lines = append(lines, strings.ToUpper(c.Kind[:1])+c.Kind[1:]+" ("+c.Importance+"): "+clip(say, 160))
	}
	subject := fmt.Sprintf("Changes on %s: %d that matter", clip(title, 60), important)
	if important == 1 {
		subject = fmt.Sprintf("A change on %s that matters", clip(title, 60))
	}
	intro := strings.TrimSpace(result.BottomLine)
	if intro == "" {
		intro = "A page you watch has changed."
	}
	notices.Send(m, w.UserID, address, notices.KindWatch, func(unsubscribe string) mailer.Message {
		return mailer.Notice("", subject, clip(title, 100), intro, lines, "See the changes",
			notices.PageURL("/watches?open="+strconv.Itoa(int(w.ID))), "You get this because you chose to watch this page.", unsubscribe)
	})
}

func emailWatchPaused(m mailer.Mailer, w watchRecord, reason string) {
	address := watcherEmail(w.UserID)
	if address == "" {
		return
	}
	title := w.Title
	if title == "" {
		title = w.URL
	}
	notices.Send(m, w.UserID, address, notices.KindWatch, func(unsubscribe string) mailer.Message {
		return mailer.Notice("", "Inkling stopped watching "+clip(title, 60), "Stopped watching "+clip(title, 100),
			fmt.Sprintf("The page could not be read %d times in a row, so Inkling paused it. The last problem: %s", maxWatchFailures, reason),
			nil, "See your watched pages", notices.PageURL("/watches"), "You get this because you chose to watch this page.", unsubscribe)
	})
}

// ---- the routes -------------------------------------------------------------------------------------------------

type watchLatest struct {
	WatchID       uint      `json:"-"`
	FoundAt       time.Time `json:"foundAt"`
	BottomLine    string    `json:"bottomLine"`
	TopImportance string    `json:"topImportance"`
}

// watchListRow is a watch as listed: what identifies it and how it is doing, and how many changes are kept. (Written out in
// full rather than built on watchRecord: the list does not need the stored page text.)
type watchListRow struct {
	ID            uint
	UserID        uint
	URL           string
	Title         string
	EveryHours    int
	Failures      int
	Paused        bool
	LastError     string
	LastCheckedAt *time.Time
	LastChangedAt *time.Time
	CreatedAt     time.Time
	Changes       int
}

func watchView(w watchListRow, latest *watchLatest) gin.H {
	return gin.H{
		"id": w.ID, "url": w.URL, "title": w.Title, "everyHours": w.EveryHours, "paused": w.Paused, "failures": w.Failures,
		"lastError": w.LastError, "lastCheckedAt": w.LastCheckedAt, "lastChangedAt": w.LastChangedAt, "createdAt": w.CreatedAt,
		"changes": w.Changes, "latest": latest,
	}
}

func listWatches(userID uint) ([]watchListRow, map[uint]*watchLatest, error) {
	var rows []watchListRow
	err := initializers.DB.Raw(`SELECT w.id, w.user_id, w.url, w.title, w.every_hours, w.failures, w.paused, w.last_error,
			w.last_checked_at, w.last_changed_at, w.created_at,
			(SELECT count(*) FROM watch_changes c WHERE c.watch_id = w.id) AS changes
		FROM page_watches w WHERE w.user_id = ? ORDER BY w.created_at DESC, w.id DESC`, userID).Scan(&rows).Error
	if err != nil {
		return nil, nil, err
	}
	latest := map[uint]*watchLatest{}
	if len(rows) > 0 {
		ids := make([]uint, len(rows))
		for i, r := range rows {
			ids[i] = r.ID
		}
		var found []watchLatest
		err := initializers.DB.Raw(`SELECT DISTINCT ON (watch_id) watch_id, found_at, bottom_line, top_importance
			FROM watch_changes WHERE watch_id IN ? ORDER BY watch_id, found_at DESC, id DESC`, ids).Scan(&found).Error
		if err != nil {
			return nil, nil, err
		}
		for i := range found {
			latest[found[i].WatchID] = &found[i]
		}
	}
	return rows, latest, nil
}

// ListWatches returns the person's watched pages.
func ListWatches(c *gin.Context) {
	user := middleware.CurrentUser(c)
	rows, latest, err := listWatches(user.ID)
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not load your watched pages."})
		return
	}
	views := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		views = append(views, watchView(r, latest[r.ID]))
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"watches": views, "limit": watchesPerUser(), "minHours": watchMinHours()})
}

type createWatchRequest struct {
	URL        string `json:"url"`
	EveryHours int    `json:"everyHours"`
}

func checkEveryHours(hours int) (int, *apiError) {
	if hours == 0 {
		hours = max(defaultWatchHours, watchMinHours())
	}
	if hours < watchMinHours() || hours > maxWatchHours {
		return 0, &apiError{http.StatusBadRequest, fmt.Sprintf("Check every %d to %d hours.", watchMinHours(), maxWatchHours)}
	}
	return hours, nil
}

// CreateWatch starts watching a page. The page is read once straight away: that text is what later versions are compared
// against, and a page that cannot be read (or whose site asks not to be checked) is refused here, with the reason.
func CreateWatch(c *gin.Context) {
	var body createWatchRequest
	if !bindJSON(c, &body) {
		return
	}
	address, apiErr := cleanWebAddress(body.URL)
	if apiErr != nil {
		apiErr.send(c)
		return
	}
	hours, apiErr := checkEveryHours(body.EveryHours)
	if apiErr != nil {
		apiErr.send(c)
		return
	}
	user := middleware.CurrentUser(c)

	var have int64
	if err := initializers.DB.Raw("SELECT count(*) FROM page_watches WHERE user_id = ?", user.ID).Scan(&have).Error; err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not start watching that page."})
		return
	}
	if int(have) >= watchesPerUser() {
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("You can watch up to %d pages. Remove one to watch another.", watchesPerUser())})
		return
	}
	var already int64
	_ = initializers.DB.Raw("SELECT count(*) FROM page_watches WHERE user_id = ? AND url = ?", user.ID, address).Scan(&already).Error
	if already > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "You are already watching that page."})
		return
	}

	title, text, apiErr := readWatchedPage(c.Request.Context(), middleware.RequestIDFrom(c), address)
	if apiErr != nil {
		apiErr.send(c)
		return
	}
	now := time.Now()
	var id uint
	err := initializers.DB.Raw(`INSERT INTO page_watches (user_id, url, title, last_text, last_hash, every_hours, next_check_at, last_checked_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
		user.ID, address, title, text, watchHash(text), hours, now.Add(time.Duration(hours)*time.Hour), now).Scan(&id).Error
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not start watching that page."})
		return
	}
	if id == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "You are already watching that page."})
		return
	}
	rows, latest, _ := listWatches(user.ID)
	for _, r := range rows {
		if r.ID == id {
			c.JSON(http.StatusCreated, watchView(r, latest[r.ID]))
			return
		}
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

func ownedWatch(c *gin.Context) (watchRecord, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid id"})
		return watchRecord{}, false
	}
	user := middleware.CurrentUser(c)
	var w []watchRecord
	if err := initializers.DB.Raw("SELECT * FROM page_watches WHERE id = ? AND user_id = ?", id, user.ID).Scan(&w).Error; err != nil || len(w) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Watched page not found"})
		return watchRecord{}, false
	}
	return w[0], true
}

type updateWatchRequest struct {
	Paused     *bool `json:"paused"`
	EveryHours *int  `json:"everyHours"`
}

// UpdateWatch pauses or resumes a watch, or changes how often it is checked. Resuming makes it due at once and clears the
// failures that paused it.
func UpdateWatch(c *gin.Context) {
	w, ok := ownedWatch(c)
	if !ok {
		return
	}
	var body updateWatchRequest
	if !bindJSON(c, &body) {
		return
	}
	if body.EveryHours != nil {
		hours, apiErr := checkEveryHours(*body.EveryHours)
		if apiErr != nil {
			apiErr.send(c)
			return
		}
		saveWatchState(w.ID, `every_hours = ?`, hours)
	}
	if body.Paused != nil {
		if *body.Paused {
			saveWatchState(w.ID, `paused = true`)
		} else {
			saveWatchState(w.ID, `paused = false, failures = 0, last_error = '', next_check_at = now()`)
		}
	}
	ListWatches(c)
}

// DeleteWatch stops watching a page and forgets its history.
func DeleteWatch(c *gin.Context) {
	w, ok := ownedWatch(c)
	if !ok {
		return
	}
	if err := initializers.DB.Exec("DELETE FROM page_watches WHERE id = ?", w.ID).Error; err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not remove that page."})
		return
	}
	c.Status(http.StatusOK)
}

// CheckWatchNow opens a watched page now instead of waiting for its turn. Not more often than WATCH_CHECK_NOW_MINUTES, so it
// cannot be used to make Inkling open a page over and over.
func CheckWatchNow(c *gin.Context) {
	w, ok := ownedWatch(c)
	if !ok {
		return
	}
	if w.Paused {
		c.JSON(http.StatusConflict, gin.H{"error": "This page is paused. Resume it first."})
		return
	}
	if wait := watchCheckNowMinutes(); wait > 0 && w.LastCheckedAt != nil && time.Since(*w.LastCheckedAt) < time.Duration(wait)*time.Minute {
		c.Header("Retry-After", strconv.Itoa(int((time.Duration(wait)*time.Minute-time.Since(*w.LastCheckedAt)).Seconds())+1))
		c.JSON(http.StatusTooManyRequests, gin.H{"error": fmt.Sprintf("This page was checked a moment ago. You can check it again after %d minutes.", wait)})
		return
	}
	result := checkWatch(c.Request.Context(), Mail, w, middleware.RequestIDFrom(c))
	user := middleware.CurrentUser(c)
	rows, latest, _ := listWatches(user.ID)
	for _, r := range rows {
		if r.ID == w.ID {
			c.JSON(http.StatusOK, gin.H{"result": result, "watch": watchView(r, latest[r.ID])})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"result": result})
}

type watchChangeRow struct {
	ID            uint
	FoundAt       time.Time
	Title         string
	BottomLine    string
	TopImportance string
	Counts        string
}

// WatchChanges lists the changes kept for a watch, newest first (without the changes themselves: see WatchChange).
func WatchChanges(c *gin.Context) {
	w, ok := ownedWatch(c)
	if !ok {
		return
	}
	var rows []watchChangeRow
	err := initializers.DB.Raw(`SELECT id, found_at, title, bottom_line, top_importance, counts::text AS counts FROM watch_changes
		WHERE watch_id = ? ORDER BY found_at DESC, id DESC`, w.ID).Scan(&rows).Error
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not load the changes."})
		return
	}
	changes := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		counts := json.RawMessage(r.Counts)
		if !json.Valid(counts) {
			counts = json.RawMessage("{}")
		}
		changes = append(changes, gin.H{"id": r.ID, "foundAt": r.FoundAt, "title": r.Title, "bottomLine": r.BottomLine, "topImportance": r.TopImportance, "counts": counts})
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"changes": changes})
}

// WatchChange returns one kept change: the comparison, in the same shape as a comparison of two documents.
func WatchChange(c *gin.Context) {
	w, ok := ownedWatch(c)
	if !ok {
		return
	}
	changeID, err := strconv.ParseUint(c.Param("changeId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid id"})
		return
	}
	var row []struct {
		ID         uint
		FoundAt    time.Time
		Title      string
		Comparison string
	}
	err = initializers.DB.Raw(`SELECT id, found_at, title, comparison::text AS comparison FROM watch_changes WHERE id = ? AND watch_id = ?`, changeID, w.ID).Scan(&row).Error
	if err != nil || len(row) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Change not found"})
		return
	}
	comparison := json.RawMessage(row[0].Comparison)
	if !json.Valid(comparison) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not load that change."})
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"id": row[0].ID, "foundAt": row[0].FoundAt, "title": row[0].Title, "url": w.URL, "comparison": comparison})
}
