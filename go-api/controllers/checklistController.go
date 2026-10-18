package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/models"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
)

// Contract checklists: a saved contract (a lease, a job offer, a freelance agreement, an NDA, purchase terms) checked
// against the things a person should look for. Each item comes back found (with the document's own quote and page),
// unclear or not found, and clauses that look unusual come with their quotes. A program in the AI service checks every
// quote against the document; this only stores the result. One checklist of each kind is kept with a document, so showing
// it again costs nothing; making a new one counts as one chat question. It is a reading aid, not legal advice.
const (
	maxChecklistItems     = 20
	maxChecklistValue     = 400
	maxChecklistQuote     = 300
	maxChecklistReason    = 200
	maxChecklistUnusual   = 6
	maxChecklistUnusualTx = 240
)

var checklistKinds = []string{"lease", "job_offer", "freelance", "nda", "purchase"}

var checklistStatuses = []string{"found", "unclear", "missing"}

var checklistItemID = regexp.MustCompile(`^[a-z][a-z_]{0,29}$`)

type checklistItem struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Value  string `json:"value"`
	Quote  string `json:"quote"`
	Page   *int   `json:"page"`
	Reason string `json:"reason"`
}

type unusualClause struct {
	What  string `json:"what"`
	Quote string `json:"quote"`
	Page  *int   `json:"page"`
}

// storedChecklist is what is kept for one kind of checklist (and shown again).
type storedChecklist struct {
	Kind           string          `json:"kind"`
	Items          []checklistItem `json:"items"`
	Counts         map[string]int  `json:"counts"`
	Unusual        []unusualClause `json:"unusual"`
	UnusualChecked bool            `json:"unusualChecked"`
	Suspicious     bool            `json:"suspicious"`
	FoundAt        time.Time       `json:"foundAt"`
}

// tidyChecklist keeps only well-formed items and clauses, whatever the AI service sent, and counts them itself.
func tidyChecklist(kind string, raw storedChecklist) storedChecklist {
	out := storedChecklist{Kind: kind, Items: []checklistItem{}, Unusual: []unusualClause{}, UnusualChecked: raw.UnusualChecked, Suspicious: raw.Suspicious}
	seen := map[string]bool{}
	for _, item := range raw.Items {
		if !checklistItemID.MatchString(item.ID) || seen[item.ID] || !contains(checklistStatuses, item.Status) {
			continue
		}
		seen[item.ID] = true
		item.Value = clip(cleanLine(item.Value), maxChecklistValue)
		item.Quote = clip(cleanLine(item.Quote), maxChecklistQuote)
		item.Reason = clip(cleanLine(item.Reason), maxChecklistReason)
		if item.Status == "missing" {
			item.Value, item.Quote, item.Reason, item.Page = "", "", "", nil
		}
		if item.Page != nil && *item.Page < 1 {
			item.Page = nil
		}
		out.Items = append(out.Items, item)
		if len(out.Items) == maxChecklistItems {
			break
		}
	}
	out.Counts = map[string]int{"found": 0, "unclear": 0, "missing": 0}
	for _, item := range out.Items {
		out.Counts[item.Status]++
	}
	for _, clause := range raw.Unusual {
		clause.What = clip(cleanLine(clause.What), maxChecklistUnusualTx)
		clause.Quote = clip(cleanLine(clause.Quote), maxChecklistQuote)
		if clause.What == "" || clause.Quote == "" {
			continue
		}
		if clause.Page != nil && *clause.Page < 1 {
			clause.Page = nil
		}
		out.Unusual = append(out.Unusual, clause)
		if len(out.Unusual) == maxChecklistUnusual {
			break
		}
	}
	return out
}

type checklistRequest struct {
	Kind       string `json:"kind"`
	Language   string `json:"language"`
	Regenerate bool   `json:"regenerate"`
}

func parseChecklistRequest(c *gin.Context) (id uint, body checklistRequest, ok bool) {
	id, ok = documentIDParam(c)
	if !ok {
		return 0, body, false
	}
	if err := c.ShouldBindBodyWith(&body, binding.JSON); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body."})
		return 0, body, false
	}
	if !contains(checklistKinds, body.Kind) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Choose lease, job_offer, freelance, nda or purchase."})
		return 0, body, false
	}
	if body.Language != "" && !contains(summaryLanguages, body.Language) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported language."})
		return 0, body, false
	}
	return id, body, true
}

func storedChecklistOf(documentID uint, kind string) (storedChecklist, bool) {
	var raw sql.NullString
	if err := initializers.DB.Raw("SELECT checks->?::text FROM documents WHERE id = ?", kind, documentID).Scan(&raw).Error; err != nil || !raw.Valid || raw.String == "" || raw.String == "null" {
		return storedChecklist{}, false
	}
	var stored storedChecklist
	if err := json.Unmarshal([]byte(raw.String), &stored); err != nil || len(stored.Items) == 0 {
		return storedChecklist{}, false
	}
	return stored, true
}

func checklistReply(stored storedChecklist, cached bool) gin.H {
	return gin.H{
		"kind": stored.Kind, "items": stored.Items, "counts": stored.Counts, "unusual": stored.Unusual,
		"unusualChecked": stored.UnusualChecked, "suspicious": stored.Suspicious, "foundAt": stored.FoundAt, "cached": cached,
	}
}

// ReplayStoredChecklist answers from a stored checklist before the daily allowance is touched: showing one again costs no
// model call, so it works even for someone who has used their allowance up.
func ReplayStoredChecklist(c *gin.Context) {
	user := middleware.CurrentUser(c)
	id, body, ok := parseChecklistRequest(c)
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
		if stored, found := storedChecklistOf(id, body.Kind); found {
			c.AbortWithStatusJSON(http.StatusOK, checklistReply(stored, true))
			return
		}
	}
	c.Next()
}

// CheckContract checks one of the signed-in user's documents against a checklist. It runs after ReplayStoredChecklist, so it
// only has new work to do, and it is what the allowance is charged for (given back if it fails).
func CheckContract(c *gin.Context) {
	id, body, ok := parseChecklistRequest(c)
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
		c.JSON(http.StatusConflict, gin.H{"error": "This document has no saved text to check (it was saved before the text was kept)."})
		return
	}

	payload := gin.H{"name": document.Filename, "text": document.Content, "kind": body.Kind}
	if body.Language != "" {
		payload["language"] = body.Language
	}
	reply, apiErr := postToAI(c, "/checklist", payload)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	var raw storedChecklist
	if err := json.Unmarshal(reply, &raw); err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadGateway, gin.H{"error": "The AI service returned an unreadable checklist."})
		return
	}
	stored := tidyChecklist(body.Kind, raw)
	if len(stored.Items) == 0 {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadGateway, gin.H{"error": "The AI service returned an empty checklist."})
		return
	}
	stored.FoundAt = time.Now().UTC()
	if encoded, err := json.Marshal(stored); err == nil {
		// Keeping it is a convenience: if it cannot be saved the person still sees it.
		err := initializers.DB.Exec(
			"UPDATE documents SET checks = COALESCE(checks, '{}'::jsonb) || jsonb_build_object(?::text, ?::jsonb) WHERE id = ?",
			body.Kind, string(encoded), id,
		).Error
		if err != nil {
			slog.Error("saving the checklist failed", "document_id", id, "error", err, "request_id", middleware.RequestIDFrom(c))
		}
	}
	c.JSON(http.StatusOK, checklistReply(stored, false))
}
