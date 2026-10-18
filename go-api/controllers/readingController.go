package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// The reading list: pages and texts saved to read later. Saving one makes a short summary of it (a few lines, one summary
// of the daily allowance) and keeps it in the library like any summary, so everything that works on a document works on it;
// the list adds when it was saved, whether it was read, and whether it was put away. The weekly digest (see digestJob.go)
// is built from what was saved this week.
const (
	// savedSummaryWords is how long the summary of a saved item is: about three lines. Only the start of a long page or text is
	// summarized (savedSkimChars): a few lines do not need dozens of model calls, and a long page would take minutes.
	savedSummaryWords = 60
	savedSkimChars    = 12_000
	maxReadingItems   = 500
	readingListLimit  = 200
	maxReadingURL     = 2000
)

// readingItem is one saved item as the list shows it. ID is the id of the document behind it.
type readingItem struct {
	ID         uint       `json:"id"`
	Title      string     `json:"title"`
	Summary    string     `json:"summary"`
	URL        string     `json:"url"`
	SavedAt    time.Time  `json:"savedAt"`
	ReadAt     *time.Time `json:"readAt"`
	ArchivedAt *time.Time `json:"archivedAt"`
}

// SaveForLater saves a web address or a text to the reading list ({"url"} or {"text"}), with a short summary made now. A page
// that is on the list already is not summarized again. It uses one summary of the daily allowance, given back on a failure
// or when there was nothing new to do.
func SaveForLater(c *gin.Context) {
	user := middleware.CurrentUser(c)
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body."})
		return
	}
	var body struct {
		URL  string `json:"url"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || (strings.TrimSpace(body.URL) == "") == (strings.TrimSpace(body.Text) == "") {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Give a web address or a text to save."})
		return
	}
	// The builders read the body themselves.
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))

	var total int64
	if err := initializers.DB.Table("reading_items").Where("user_id = ?", user.ID).Count(&total).Error; err == nil && total >= maxReadingItems {
		middleware.RefundQuota(c)
		c.JSON(http.StatusConflict, gin.H{"error": "Your reading list is full. Remove or archive some items first."})
		return
	}

	// A page that is saved already is shown, not made again.
	address := ""
	if body.URL != "" {
		address, _ = cleanWebAddressOnly(body.URL)
		if address != "" {
			var existing readingItem
			err := initializers.DB.Raw(`SELECT d.id, d.filename AS title, d.summary, r.url, r.saved_at, r.read_at, r.archived_at
				FROM reading_items r JOIN documents d ON d.id = r.document_id
				WHERE r.user_id = ? AND r.url = ? AND d.deleted_at IS NULL`, user.ID, address).Scan(&existing).Error
			if err == nil && existing.ID != 0 {
				middleware.RefundQuota(c)
				c.JSON(http.StatusOK, gin.H{"id": existing.ID, "title": existing.Title, "summary": existing.Summary, "alreadySaved": true})
				return
			}
		}
	}

	// A short summary, in the style that reads in a few lines.
	q := c.Request.URL.Query()
	q.Set("style", "glance")
	q.Set("wordCount", strconv.Itoa(savedSummaryWords))
	q.Del("pageLimit")
	c.Request.URL.RawQuery = q.Encode()

	c.Set(skimKey, savedSkimChars)
	build := summaryBuilder(buildTextRequest)
	if body.URL != "" {
		build = buildURLRequest
	}
	result, apiErr := buffered(build)(c)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	title := result.Filename
	if body.URL == "" {
		title = titleFromText(result.Text, "Saved text")
	}
	id := saveDocument(c, title, result)
	if id == 0 {
		middleware.RefundQuota(c)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not save that."})
		return
	}
	if err := initializers.DB.Exec("INSERT INTO reading_items (document_id, user_id, url) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", id, user.ID, address).Error; err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not save that."})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id, "title": title, "summary": result.Summary, "alreadySaved": false})
}

// cleanWebAddressOnly is the address as cleanWebAddress accepts it, or "" when it is not one.
func cleanWebAddressOnly(raw string) (string, bool) {
	address, apiErr := cleanWebAddress(raw)
	if apiErr != nil || utf8.RuneCountInString(address) > maxReadingURL {
		return "", false
	}
	if parsed, err := url.Parse(address); err != nil || parsed.Host == "" {
		return "", false
	}
	return address, true
}

// ReadingList lists the saved items of one kind: unread (the default), read, or archived. It also counts each kind.
func ReadingList(c *gin.Context) {
	user := middleware.CurrentUser(c)
	state := c.DefaultQuery("state", "unread")
	var filter string
	switch state {
	case "unread":
		filter = "r.read_at IS NULL AND r.archived_at IS NULL"
	case "read":
		filter = "r.read_at IS NOT NULL AND r.archived_at IS NULL"
	case "archived":
		filter = "r.archived_at IS NOT NULL"
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "Choose unread, read or archived."})
		return
	}
	items := []readingItem{}
	err := initializers.DB.Raw(`SELECT d.id, d.filename AS title, d.summary, r.url, r.saved_at, r.read_at, r.archived_at
		FROM reading_items r JOIN documents d ON d.id = r.document_id
		WHERE r.user_id = ? AND d.deleted_at IS NULL AND `+filter+`
		ORDER BY r.saved_at DESC, d.id DESC LIMIT ?`, user.ID, readingListLimit).Scan(&items).Error
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load your reading list."})
		return
	}
	var counts struct{ Unread, Read, Archived int }
	err = initializers.DB.Raw(`SELECT
			count(*) FILTER (WHERE r.read_at IS NULL AND r.archived_at IS NULL) AS unread,
			count(*) FILTER (WHERE r.read_at IS NOT NULL AND r.archived_at IS NULL) AS read,
			count(*) FILTER (WHERE r.archived_at IS NOT NULL) AS archived
		FROM reading_items r JOIN documents d ON d.id = r.document_id
		WHERE r.user_id = ? AND d.deleted_at IS NULL`, user.ID).Scan(&counts).Error
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load your reading list."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "counts": gin.H{"unread": counts.Unread, "read": counts.Read, "archived": counts.Archived}})
}

// UpdateReadingItem marks an item read or unread, or puts it away in the archive and brings it back
// ({"read"?, "archived"?}).
func UpdateReadingItem(c *gin.Context) {
	user := middleware.CurrentUser(c)
	id, ok := documentIDParam(c)
	if !ok {
		return
	}
	var body struct {
		Read     *bool `json:"read"`
		Archived *bool `json:"archived"`
	}
	if !bindJSON(c, &body) {
		return
	}
	if body.Read == nil && body.Archived == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Say whether it is read, or archived."})
		return
	}
	sets := []string{}
	if body.Read != nil {
		sets = append(sets, "read_at = "+nowOrNull(*body.Read))
	}
	if body.Archived != nil {
		sets = append(sets, "archived_at = "+nowOrNull(*body.Archived))
	}
	res := initializers.DB.Exec("UPDATE reading_items SET "+strings.Join(sets, ", ")+" WHERE document_id = ? AND user_id = ?", id, user.ID)
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not save that."})
		return
	}
	if res.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "That is not on your reading list."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func nowOrNull(set bool) string {
	if set {
		return "now()"
	}
	return "NULL"
}

// RemoveReadingItem takes an item off the list. The document stays in the library: this only forgets that it was saved to
// be read later.
func RemoveReadingItem(c *gin.Context) {
	user := middleware.CurrentUser(c)
	id, ok := documentIDParam(c)
	if !ok {
		return
	}
	res := initializers.DB.Exec("DELETE FROM reading_items WHERE document_id = ? AND user_id = ?", id, user.ID)
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not remove that."})
		return
	}
	if res.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "That is not on your reading list."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
