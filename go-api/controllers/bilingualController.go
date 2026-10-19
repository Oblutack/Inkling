package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/models"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
)

// A summary in two languages side by side: its lines (a heading, a bullet or a paragraph each) with their translation into
// another language, and the key words with theirs. The AI service checks that every line is accounted for and that the figures
// of a line are still in its translation (`figuresKept`), and keeps only vocabulary the summary really contains. Made once for
// each language and kept; showing it again is free; a new one counts as one chat question.
const (
	maxBilingualRows  = 80
	maxBilingualText  = 2400
	maxBilingualWord  = 60
	maxBilingualVocab = 12
)

var bilingualKinds = []string{"heading", "bullet", "numbered", "paragraph"}

type bilingualRow struct {
	Kind        string `json:"kind"`
	Source      string `json:"source"`
	Target      string `json:"target"`
	FiguresKept bool   `json:"figuresKept"`
}

type bilingualWord struct {
	Word        string `json:"word"`
	Translation string `json:"translation"`
}

type storedBilingual struct {
	Language   string          `json:"language"`
	Rows       []bilingualRow  `json:"rows"`
	Vocabulary []bilingualWord `json:"vocabulary"`
	Missing    int             `json:"missing"`
	FoundAt    time.Time       `json:"foundAt"`
}

func tidyBilingual(language string, raw storedBilingual) storedBilingual {
	out := storedBilingual{Language: language, Rows: []bilingualRow{}, Vocabulary: []bilingualWord{}}
	for _, row := range raw.Rows {
		row.Source = clip(cleanLine(row.Source), maxBilingualText)
		row.Target = clip(cleanLine(row.Target), maxBilingualText)
		if row.Source == "" {
			continue
		}
		if !contains(bilingualKinds, row.Kind) {
			row.Kind = "paragraph"
		}
		if row.Target == "" {
			row.FiguresKept = true
			out.Missing++
		}
		out.Rows = append(out.Rows, row)
		if len(out.Rows) == maxBilingualRows {
			break
		}
	}
	for _, word := range raw.Vocabulary {
		word.Word = clip(cleanLine(word.Word), maxBilingualWord)
		word.Translation = clip(cleanLine(word.Translation), maxBilingualWord)
		if word.Word == "" || word.Translation == "" {
			continue
		}
		out.Vocabulary = append(out.Vocabulary, word)
		if len(out.Vocabulary) == maxBilingualVocab {
			break
		}
	}
	return out
}

type bilingualRequest struct {
	Language   string `json:"language"`
	Regenerate bool   `json:"regenerate"`
}

func parseBilingualRequest(c *gin.Context) (id uint, body bilingualRequest, ok bool) {
	id, ok = documentIDParam(c)
	if !ok {
		return 0, body, false
	}
	if err := c.ShouldBindBodyWith(&body, binding.JSON); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body."})
		return 0, body, false
	}
	if !contains(summaryLanguages, body.Language) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Choose one of the languages Inkling writes in."})
		return 0, body, false
	}
	return id, body, true
}

func storedBilingualOf(documentID uint, language string) (storedBilingual, bool) {
	var raw sql.NullString
	if err := initializers.DB.Raw("SELECT bilingual->?::text FROM documents WHERE id = ?", language, documentID).Scan(&raw).Error; err != nil || !raw.Valid || raw.String == "" || raw.String == "null" {
		return storedBilingual{}, false
	}
	var stored storedBilingual
	if err := json.Unmarshal([]byte(raw.String), &stored); err != nil || len(stored.Rows) == 0 {
		return storedBilingual{}, false
	}
	return stored, true
}

func bilingualReply(stored storedBilingual, cached bool) gin.H {
	return gin.H{
		"language": stored.Language, "rows": stored.Rows, "vocabulary": stored.Vocabulary, "missing": stored.Missing,
		"foundAt": stored.FoundAt, "cached": cached,
	}
}

// ReplayStoredBilingual shows a stored translation before the daily allowance is touched: it costs no model call.
func ReplayStoredBilingual(c *gin.Context) {
	user := middleware.CurrentUser(c)
	id, body, ok := parseBilingualRequest(c)
	if !ok {
		c.Abort()
		return
	}
	var count int64
	if err := initializers.DB.Model(&models.Document{}).Where("id = ? AND user_id = ?", id, user.ID).Count(&count).Error; err != nil || count == 0 {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "Document not found"})
		return
	}
	if !body.Regenerate {
		if stored, found := storedBilingualOf(id, body.Language); found {
			c.AbortWithStatusJSON(http.StatusOK, bilingualReply(stored, true))
			return
		}
	}
	c.Next()
}

// MakeBilingual translates the saved summary of one of the person's documents into another language, line by line.
func MakeBilingual(c *gin.Context) {
	id, body, ok := parseBilingualRequest(c)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	document, ok := ownedDocument(c, id, false)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	if strings.TrimSpace(document.Summary) == "" {
		middleware.RefundQuota(c)
		c.JSON(http.StatusConflict, gin.H{"error": "This document has no summary to translate."})
		return
	}
	reply, apiErr := postToAI(c, "/bilingual", gin.H{"name": document.Filename, "summary": document.Summary, "language": body.Language})
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	var raw storedBilingual
	if err := json.Unmarshal(reply, &raw); err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadGateway, gin.H{"error": "The AI service returned an unreadable translation."})
		return
	}
	stored := tidyBilingual(body.Language, raw)
	if len(stored.Rows) == 0 || stored.Missing == len(stored.Rows) {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadGateway, gin.H{"error": "The AI service returned no translation."})
		return
	}
	stored.FoundAt = time.Now().UTC()
	if encoded, err := json.Marshal(stored); err == nil {
		err := initializers.DB.Exec(
			"UPDATE documents SET bilingual = COALESCE(bilingual, '{}'::jsonb) || jsonb_build_object(?::text, ?::jsonb) WHERE id = ?",
			body.Language, string(encoded), id,
		).Error
		if err != nil {
			slog.Error("saving the translation failed", "document_id", id, "error", err, "request_id", middleware.RequestIDFrom(c))
		}
	}
	c.JSON(http.StatusOK, bilingualReply(stored, false))
}
