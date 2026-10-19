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

// A glossary of a document: the specialist terms in it with a one-line plain explanation of each and the pages they are on.
// A program in the AI service keeps only terms that really occur in the text, so every page shown is true; the explanation is
// the model's own words. Made once, kept with the document, shown again for nothing; a new one counts as one chat question.
const (
	maxGlossaryTerms       = 15
	maxGlossaryTerm        = 60
	maxGlossaryExplanation = 220
	maxGlossaryPages       = 6
)

type glossaryTerm struct {
	Term        string `json:"term"`
	Explanation string `json:"explanation"`
	Pages       []int  `json:"pages"`
}

type storedGlossary struct {
	Terms      []glossaryTerm `json:"terms"`
	Suspicious bool           `json:"suspicious"`
	FoundAt    time.Time      `json:"foundAt"`
}

func tidyGlossary(raw storedGlossary) storedGlossary {
	out := storedGlossary{Terms: []glossaryTerm{}, Suspicious: raw.Suspicious}
	seen := map[string]bool{}
	for _, t := range raw.Terms {
		t.Term = clip(cleanLine(t.Term), maxGlossaryTerm)
		t.Explanation = clip(cleanLine(t.Explanation), maxGlossaryExplanation)
		key := strings.ToLower(t.Term)
		if t.Term == "" || t.Explanation == "" || seen[key] {
			continue
		}
		seen[key] = true
		pages := []int{}
		for _, p := range t.Pages {
			if p >= 1 && len(pages) < maxGlossaryPages {
				pages = append(pages, p)
			}
		}
		t.Pages = pages
		out.Terms = append(out.Terms, t)
		if len(out.Terms) == maxGlossaryTerms {
			break
		}
	}
	return out
}

func readStoredGlossary(documentID uint) (storedGlossary, bool) {
	var raw sql.NullString
	if err := initializers.DB.Raw("SELECT glossary::text FROM documents WHERE id = ?", documentID).Scan(&raw).Error; err != nil || !raw.Valid {
		return storedGlossary{}, false
	}
	var stored storedGlossary
	if err := json.Unmarshal([]byte(raw.String), &stored); err != nil {
		return storedGlossary{}, false
	}
	if stored.Terms == nil {
		stored.Terms = []glossaryTerm{}
	}
	return stored, true
}

func glossaryReply(stored storedGlossary, cached bool) gin.H {
	return gin.H{"terms": stored.Terms, "suspicious": stored.Suspicious, "foundAt": stored.FoundAt, "cached": cached}
}

// DocumentGlossary shows what was found before, without asking the model: {"terms": null} when nobody has looked yet.
func DocumentGlossary(c *gin.Context) {
	id, ok := documentIDParam(c)
	if !ok {
		return
	}
	if _, ok := ownedDocument(c, id, false); !ok {
		return
	}
	stored, found := readStoredGlossary(id)
	if !found {
		c.JSON(http.StatusOK, gin.H{"terms": nil})
		return
	}
	c.JSON(http.StatusOK, glossaryReply(stored, true))
}

type glossaryRequest struct {
	Language   string `json:"language"`
	Regenerate bool   `json:"regenerate"`
}

func parseGlossaryRequest(c *gin.Context) (id uint, body glossaryRequest, ok bool) {
	id, ok = documentIDParam(c)
	if !ok {
		return 0, body, false
	}
	if c.Request.ContentLength != 0 {
		if err := c.ShouldBindBodyWith(&body, binding.JSON); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body."})
			return 0, body, false
		}
	}
	if body.Language != "" && !contains(summaryLanguages, body.Language) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported language."})
		return 0, body, false
	}
	return id, body, true
}

// ReplayStoredGlossary shows a stored glossary before the daily allowance is touched: it costs no model call.
func ReplayStoredGlossary(c *gin.Context) {
	user := middleware.CurrentUser(c)
	id, body, ok := parseGlossaryRequest(c)
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
		if stored, found := readStoredGlossary(id); found {
			c.AbortWithStatusJSON(http.StatusOK, glossaryReply(stored, true))
			return
		}
	}
	c.Next()
}

// FindGlossary makes the glossary of a saved document from its text.
func FindGlossary(c *gin.Context) {
	id, body, ok := parseGlossaryRequest(c)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	document, ok := ownedDocument(c, id, true)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	if !document.HasContent || strings.TrimSpace(document.Content) == "" {
		middleware.RefundQuota(c)
		c.JSON(http.StatusConflict, gin.H{"error": "This document has no saved text to find terms in (it was saved before the text was kept)."})
		return
	}
	payload := gin.H{"name": document.Filename, "text": document.Content}
	if body.Language != "" {
		payload["language"] = body.Language
	}
	reply, apiErr := postToAI(c, "/glossary", payload)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	var raw storedGlossary
	if err := json.Unmarshal(reply, &raw); err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadGateway, gin.H{"error": "The AI service returned an unreadable glossary."})
		return
	}
	stored := tidyGlossary(raw)
	stored.FoundAt = time.Now().UTC()
	if encoded, err := json.Marshal(stored); err == nil {
		if err := initializers.DB.Exec("UPDATE documents SET glossary = ?::jsonb WHERE id = ?", string(encoded), id).Error; err != nil {
			slog.Error("saving the glossary failed", "document_id", id, "error", err, "request_id", middleware.RequestIDFrom(c))
		}
	}
	c.JSON(http.StatusOK, glossaryReply(stored, false))
}
