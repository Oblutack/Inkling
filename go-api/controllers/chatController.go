package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/models"
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

const (
	maxQuestionChars   = 1_000
	maxHistoryMessages = 10
	maxHistoryChars    = 4_000
)

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Question string        `json:"question"`
	History  []chatMessage `json:"history"`
}

func (r *chatRequest) validate() *apiError {
	r.Question = strings.TrimSpace(r.Question)
	if r.Question == "" {
		return &apiError{http.StatusBadRequest, "Please type a question."}
	}
	if utf8.RuneCountInString(r.Question) > maxQuestionChars {
		return &apiError{http.StatusBadRequest, "Question is too long (max 1000 characters)."}
	}
	if r.History == nil {
		r.History = []chatMessage{} // marshal as [] rather than null
	}
	if len(r.History) > maxHistoryMessages {
		r.History = r.History[len(r.History)-maxHistoryMessages:]
	}
	for _, m := range r.History {
		if m.Role != "user" && m.Role != "assistant" {
			return &apiError{http.StatusBadRequest, "Invalid chat history."}
		}
		if utf8.RuneCountInString(m.Content) > maxHistoryChars {
			return &apiError{http.StatusBadRequest, "Chat history message is too long."}
		}
	}
	return nil
}

// ChatWithDocument answers a question about one of the signed-in user's saved documents.
func ChatWithDocument(c *gin.Context) {
	user := middleware.CurrentUser(c)

	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid document id"})
		return
	}

	var body chatRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body."})
		return
	}
	if apiErr := body.validate(); apiErr != nil {
		apiErr.send(c)
		return
	}

	// Scoping the query to the user means other users' documents look like they don't exist.
	var document models.Document
	if err := initializers.DB.Where("id = ? AND user_id = ?", id, user.ID).First(&document).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Document not found"})
		return
	}
	if !document.HasContent || document.Content == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "This document was saved before chat was available. Summarize it again to chat with it."})
		return
	}

	payload, err := json.Marshal(gin.H{"text": document.Content, "question": body.Question, "history": body.History, "notes": chatNotesFor(document.ID)})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare the request."})
		return
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, aiServiceURL("/chat"), bytes.NewReader(payload))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare the request."})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	prepareAIRequest(c, req)

	respBody, apiErr := callAIService(req)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	var out struct {
		Answer  string       `json:"answer"`
		Sources []chatSource `json:"sources"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil || strings.TrimSpace(out.Answer) == "" {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadGateway, gin.H{"error": "The AI service returned an empty answer."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"answer": out.Answer, "sources": cleanSources(out.Sources)})
}

// Limits on the citations passed on to the browser. The AI service is trusted, but what reaches a
// user's screen is bounded here regardless.
const (
	maxSources    = 20
	maxSourceText = 3_000
)

// chatSource is a passage of the document that an answer cites.
type chatSource struct {
	ID       int    `json:"id"`
	Text     string `json:"text"`
	Page     *int   `json:"page"`
	PageEnd  *int   `json:"pageEnd"`
	Document string `json:"document,omitempty"`
}

// cleanSources drops malformed citations and bounds the rest. It always returns a slice, so the
// JSON is [] rather than null when there is nothing to cite.
func cleanSources(in []chatSource) []chatSource {
	out := make([]chatSource, 0, len(in))
	seen := map[int]bool{}
	for _, s := range in {
		if s.ID <= 0 || seen[s.ID] || strings.TrimSpace(s.Text) == "" || len(out) >= maxSources {
			continue
		}
		seen[s.ID] = true
		if utf8.RuneCountInString(s.Text) > maxSourceText {
			s.Text = string([]rune(s.Text)[:maxSourceText]) + "…"
		}
		if s.Page != nil && *s.Page < 1 {
			s.Page, s.PageEnd = nil, nil
		}
		if s.PageEnd != nil && (s.Page == nil || *s.PageEnd < *s.Page) {
			s.PageEnd = s.Page
		}
		out = append(out, s)
	}
	return out
}
