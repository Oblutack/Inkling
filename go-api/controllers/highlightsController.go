package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// Highlights and notes in the original PDF: a passage a person marks and a note they write about it. They are the person's own
// words and marks, kept with the document, listed on it, used as extra context by its chat (marked as theirs), searched with the
// document, and part of the notes and data exports.
const (
	maxHighlightQuoteRunes = 1000
	maxHighlightNoteRunes  = 2000
	maxHighlightsPerDoc    = 300
	maxHighlightsPerUser   = 5000
	maxHighlightPage       = 100_000
	chatNotesSent          = 10
)

type highlight struct {
	ID        uint      `json:"id"`
	FileID    *uint     `json:"fileId"`
	Page      int       `json:"page"`
	Quote     string    `json:"quote"`
	Note      string    `json:"note"`
	CreatedAt time.Time `json:"createdAt"`
}

const highlightColumns = "id, file_id, page, quote, note, created_at"

func loadHighlights(documentID uint) []highlight {
	out := []highlight{}
	initializers.DB.Raw("SELECT "+highlightColumns+" FROM document_highlights WHERE document_id = ? ORDER BY page, id", documentID).Scan(&out)
	return out
}

// ListHighlights lists the highlights of one of the person's documents, in page order.
func ListHighlights(c *gin.Context) {
	id, ok := documentIDParam(c)
	if !ok {
		return
	}
	if _, ok := ownedDocument(c, id, false); !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"highlights": loadHighlights(id)})
}

type highlightBody struct {
	FileID *uint   `json:"fileId"`
	Page   int     `json:"page"`
	Quote  string  `json:"quote"`
	Note   *string `json:"note"`
}

// CreateHighlight marks a passage of a stored original ({"fileId", "page", "quote", "note"?}).
func CreateHighlight(c *gin.Context) {
	user := middleware.CurrentUser(c)
	id, ok := documentIDParam(c)
	if !ok {
		return
	}
	if _, ok := ownedDocument(c, id, false); !ok {
		return
	}
	var body highlightBody
	if !bindJSON(c, &body) {
		return
	}
	quote := cleanLine(body.Quote)
	note := ""
	if body.Note != nil {
		note = strings.TrimSpace(*body.Note)
	}
	if body.Page < 1 || body.Page > maxHighlightPage || utf8.RuneCountInString(quote) < 2 || utf8.RuneCountInString(quote) > maxHighlightQuoteRunes ||
		utf8.RuneCountInString(note) > maxHighlightNoteRunes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Select some words on a page to highlight, and keep a note under 2000 characters."})
		return
	}
	if body.FileID != nil {
		var files int64
		initializers.DB.Table("document_files").Where("id = ? AND document_id = ?", *body.FileID, id).Count(&files)
		if files == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "That file is not part of this document."})
			return
		}
	}
	var onDocument, onAccount int64
	initializers.DB.Table("document_highlights").Where("document_id = ?", id).Count(&onDocument)
	initializers.DB.Table("document_highlights").Where("user_id = ?", user.ID).Count(&onAccount)
	if onDocument >= maxHighlightsPerDoc || onAccount >= maxHighlightsPerUser {
		c.JSON(http.StatusConflict, gin.H{"error": "There are too many highlights already. Remove some first."})
		return
	}
	var created highlight
	err := initializers.DB.Raw(`INSERT INTO document_highlights (document_id, user_id, file_id, page, quote, note) VALUES (?, ?, ?, ?, ?, ?)
		RETURNING `+highlightColumns, id, user.ID, body.FileID, body.Page, quote, note).Scan(&created).Error
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not save that."})
		return
	}
	c.JSON(http.StatusCreated, created)
}

// UpdateHighlight changes the note of a highlight ({"note"}).
func UpdateHighlight(c *gin.Context) {
	user := middleware.CurrentUser(c)
	hid, err := strconv.ParseUint(c.Param("hid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid highlight id"})
		return
	}
	var body struct {
		Note *string `json:"note"`
	}
	if !bindJSON(c, &body) {
		return
	}
	if body.Note == nil || utf8.RuneCountInString(strings.TrimSpace(*body.Note)) > maxHighlightNoteRunes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Write a note under 2000 characters."})
		return
	}
	var updated []highlight
	initializers.DB.Raw(`UPDATE document_highlights SET note = ?, updated_at = now() WHERE id = ? AND user_id = ? RETURNING `+highlightColumns,
		strings.TrimSpace(*body.Note), hid, user.ID).Scan(&updated)
	if len(updated) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Highlight not found"})
		return
	}
	c.JSON(http.StatusOK, updated[0])
}

// DeleteHighlight removes a highlight and its note.
func DeleteHighlight(c *gin.Context) {
	user := middleware.CurrentUser(c)
	hid, err := strconv.ParseUint(c.Param("hid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid highlight id"})
		return
	}
	res := initializers.DB.Exec("DELETE FROM document_highlights WHERE id = ? AND user_id = ?", hid, user.ID)
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not remove that."})
		return
	}
	if res.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Highlight not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// chatNotesFor is the person's own highlights and notes on a document, for the chat to use as extra context (the newest ones).
func chatNotesFor(documentID uint) []gin.H {
	var rows []struct {
		Page  int
		Quote string
		Note  string
	}
	initializers.DB.Raw("SELECT page, quote, note FROM document_highlights WHERE document_id = ? ORDER BY id DESC LIMIT ?", documentID, chatNotesSent).Scan(&rows)
	notes := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		notes = append(notes, gin.H{"page": r.Page, "quote": r.Quote, "note": r.Note})
	}
	return notes
}
