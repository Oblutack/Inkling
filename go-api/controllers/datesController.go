package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Dates and deadlines in a document ("notice by 28 February 2027", "rent is due on the first of each month"), to be put on
// a calendar. A program in the AI service picks the sentences that can hold a date and checks every date the model gives
// against its sentence, so each date arrives with the document's own words as its quote and a mark for whether it checks
// out. They are found once and kept with the document.
const (
	maxDates         = 30
	maxDateWhatRunes = 120
	maxDateRelRunes  = 200
	maxDateQuote     = 500
	maxDateReason    = 200
)

var dateRepeats = []string{"none", "weekly", "monthly", "yearly"}

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

type documentDate struct {
	What     string  `json:"what"`
	Date     *string `json:"date"`
	Repeat   string  `json:"repeat"`
	Relative string  `json:"relative"`
	Quote    string  `json:"quote"`
	Page     *int    `json:"page"`
	Verified bool    `json:"verified"`
	Reason   string  `json:"reason"`
}

// storedDates is what is kept for a document: the dates, and whether any sentence reads like an instruction to an AI.
type storedDates struct {
	Dates      []documentDate `json:"dates"`
	Suspicious bool           `json:"suspicious"`
	FoundAt    time.Time      `json:"foundAt"`
}

// cleanDates keeps well-formed dates only, so whatever the AI service sends, what is kept and shown is in the right shape.
func cleanDates(in []documentDate) []documentDate {
	out := make([]documentDate, 0, len(in))
	for _, d := range in {
		d.What = clip(cleanLine(d.What), maxDateWhatRunes)
		d.Relative = clip(cleanLine(d.Relative), maxDateRelRunes)
		d.Quote = clip(cleanLine(d.Quote), maxDateQuote)
		d.Reason = clip(cleanLine(d.Reason), maxDateReason)
		if d.What == "" {
			continue
		}
		if d.Date != nil {
			day := strings.TrimSpace(*d.Date)
			if _, err := time.Parse("2006-01-02", day); err != nil || !isoDate.MatchString(day) {
				d.Date = nil
				d.Verified = false
			} else {
				d.Date = &day
			}
		}
		if d.Date == nil && d.Relative == "" {
			continue
		}
		if !contains(dateRepeats, d.Repeat) {
			d.Repeat = "none"
		}
		if d.Page != nil && *d.Page < 1 {
			d.Page = nil
		}
		out = append(out, d)
		if len(out) == maxDates {
			break
		}
	}
	return out
}

func readStoredDates(documentID uint) (storedDates, bool) {
	var raw sql.NullString
	if err := initializers.DB.Raw("SELECT dates::text FROM documents WHERE id = ?", documentID).Scan(&raw).Error; err != nil || !raw.Valid {
		return storedDates{}, false
	}
	var stored storedDates
	if err := json.Unmarshal([]byte(raw.String), &stored); err != nil {
		return storedDates{}, false
	}
	if stored.Dates == nil {
		stored.Dates = []documentDate{}
	}
	return stored, true
}

// DocumentDates answers with what was found in a document before, without asking the model: {"dates": null} when nobody
// has looked yet.
func DocumentDates(c *gin.Context) {
	id, ok := documentIDParam(c)
	if !ok {
		return
	}
	if _, ok := ownedDocument(c, id, false); !ok {
		return
	}
	stored, found := readStoredDates(id)
	if !found {
		c.JSON(http.StatusOK, gin.H{"dates": nil})
		return
	}
	c.JSON(http.StatusOK, gin.H{"dates": stored.Dates, "suspicious": stored.Suspicious, "foundAt": stored.FoundAt, "cached": true})
}

// FindDocumentDates looks for the dates in a document's saved text. What was found before is shown again for nothing;
// asking again ("regenerate") looks anew. A failure gives the rate-limit and budget count back.
func FindDocumentDates(c *gin.Context) {
	id, ok := documentIDParam(c)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	var body struct {
		Regenerate bool   `json:"regenerate"`
		Language   string `json:"language"`
	}
	if c.Request.ContentLength != 0 {
		if !bindJSON(c, &body) {
			middleware.RefundQuota(c)
			return
		}
	}
	if body.Language != "" && !contains(summaryLanguages, body.Language) {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported language."})
		return
	}
	document, ok := ownedDocument(c, id, true)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	if !body.Regenerate {
		if stored, found := readStoredDates(id); found {
			middleware.RefundQuota(c)
			c.JSON(http.StatusOK, gin.H{"dates": stored.Dates, "suspicious": stored.Suspicious, "foundAt": stored.FoundAt, "cached": true})
			return
		}
	}
	if !document.HasContent || strings.TrimSpace(document.Content) == "" {
		middleware.RefundQuota(c)
		c.JSON(http.StatusConflict, gin.H{"error": "This document has no saved text to look for dates in (it was saved before the text was kept)."})
		return
	}

	payload := gin.H{"name": document.Filename, "text": document.Content}
	if body.Language != "" {
		payload["language"] = body.Language
	}
	reply, apiErr := postToAI(c, "/dates", payload)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	var out struct {
		Dates      []documentDate `json:"dates"`
		Suspicious bool           `json:"suspicious"`
	}
	if err := json.Unmarshal(reply, &out); err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadGateway, gin.H{"error": "The AI service returned unreadable dates."})
		return
	}
	stored := storedDates{Dates: cleanDates(out.Dates), Suspicious: out.Suspicious, FoundAt: time.Now().UTC()}
	if raw, err := json.Marshal(stored); err == nil {
		// Keeping them is a convenience: if they cannot be saved the person still sees them.
		if err := initializers.DB.Exec("UPDATE documents SET dates = ?::jsonb WHERE id = ?", string(raw), id).Error; err != nil {
			slog.Error("saving the dates failed", "document_id", id, "error", err, "request_id", middleware.RequestIDFrom(c))
		}
	}
	c.JSON(http.StatusOK, gin.H{"dates": stored.Dates, "suspicious": stored.Suspicious, "foundAt": stored.FoundAt, "cached": false})
}
