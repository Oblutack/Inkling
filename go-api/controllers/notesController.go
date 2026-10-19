package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// Notes for other apps: the summaries a person has saved, with their tags, dates, the page they came from (when they were
// saved from one) and their flashcards, in a shape a note-taking app's files are made from (Obsidian, Notion, or any app that
// reads Markdown). The source text is not part of it. The files themselves are made in the browser.
const maxLibraryNotes = 2000

type libraryNote struct {
	ID         uint        `json:"id"`
	Title      string      `json:"title"`
	CreatedAt  time.Time   `json:"createdAt"`
	Tags       []string    `json:"tags"`
	Summary    string      `json:"summary"`
	URL        string      `json:"url"`
	Flashcards []studyCard `json:"flashcards"`
	Highlights []highlight `json:"highlights"`
}

type libraryNoteRow struct {
	ID        uint
	Filename  string
	CreatedAt time.Time
	Tags      string
	Summary   string
	URL       sql.NullString
	Study     sql.NullString
}

const libraryNoteSelect = `d.id, d.filename, d.created_at, d.tags::text AS tags, d.summary, r.url, d.study::text AS study
	FROM documents d LEFT JOIN reading_items r ON r.document_id = d.id`

func noteOf(row libraryNoteRow) libraryNote {
	note := libraryNote{ID: row.ID, Title: row.Filename, CreatedAt: row.CreatedAt, Summary: row.Summary, Tags: []string{}, Flashcards: []studyCard{}}
	_ = json.Unmarshal([]byte(row.Tags), &note.Tags)
	if row.URL.Valid {
		note.URL = row.URL.String
	}
	if row.Study.Valid {
		var material studyMaterial
		if json.Unmarshal([]byte(row.Study.String), &material) == nil && len(material.Flashcards) > 0 {
			note.Flashcards = material.Flashcards
		}
	}
	note.Highlights = []highlight{}
	return note
}

// withHighlights adds the highlights of each note (one query for all of them).
func withHighlights(userID uint, notes []libraryNote) {
	var rows []struct {
		DocumentID uint
		Page       int
		Quote      string
		Note       string
		CreatedAt  time.Time
		ID         uint
	}
	initializers.DB.Raw("SELECT id, document_id, page, quote, note, created_at FROM document_highlights WHERE user_id = ? ORDER BY document_id, page, id", userID).Scan(&rows)
	byDocument := map[uint][]highlight{}
	for _, r := range rows {
		byDocument[r.DocumentID] = append(byDocument[r.DocumentID], highlight{ID: r.ID, Page: r.Page, Quote: r.Quote, Note: r.Note, CreatedAt: r.CreatedAt})
	}
	for i := range notes {
		if found := byDocument[notes[i].ID]; found != nil {
			notes[i].Highlights = found
		}
	}
}

// LibraryNotes lists everything the person has saved as notes, oldest first (up to 2000; `truncated` says there were more).
func LibraryNotes(c *gin.Context) {
	user := middleware.CurrentUser(c)
	var rows []libraryNoteRow
	err := initializers.DB.Raw("SELECT "+libraryNoteSelect+" WHERE d.user_id = ? AND d.deleted_at IS NULL ORDER BY d.id ASC LIMIT ?", user.ID, maxLibraryNotes+1).Scan(&rows).Error
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load your library."})
		return
	}
	truncated := len(rows) > maxLibraryNotes
	if truncated {
		rows = rows[:maxLibraryNotes]
	}
	notes := make([]libraryNote, 0, len(rows))
	for _, row := range rows {
		notes = append(notes, noteOf(row))
	}
	withHighlights(user.ID, notes)
	c.JSON(http.StatusOK, gin.H{"notes": notes, "truncated": truncated})
}

// DocumentNote is the note of one of the person's documents.
func DocumentNote(c *gin.Context) {
	user := middleware.CurrentUser(c)
	id, ok := documentIDParam(c)
	if !ok {
		return
	}
	var rows []libraryNoteRow
	err := initializers.DB.Raw("SELECT "+libraryNoteSelect+" WHERE d.id = ? AND d.user_id = ? AND d.deleted_at IS NULL", id, user.ID).Scan(&rows).Error
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load the note."})
		return
	}
	if len(rows) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Document not found"})
		return
	}
	one := []libraryNote{noteOf(rows[0])}
	withHighlights(user.ID, one)
	c.JSON(http.StatusOK, one[0])
}
