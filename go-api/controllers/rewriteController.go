package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

type rewriteRequest struct {
	WordCount int    `json:"wordCount"`
	Style     string `json:"style"`
	Language  string `json:"language"`
}

// RewriteDocument writes a new summary of a saved document in another style, length or language,
// from the source text kept for chat. It replaces the stored summary, and with it everything made
// from the old one (the podcast, suggested questions and study material), which would no longer match.
// It counts as a summary against the daily allowance.
func RewriteDocument(c *gin.Context) {
	id, ok := documentIDParam(c)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	var body rewriteRequest
	if !bindJSON(c, &body) {
		middleware.RefundQuota(c)
		return
	}
	if body.WordCount == 0 {
		body.WordCount = defaultWords
	}
	opts, apiErr := parseSummaryParams(strconv.Itoa(body.WordCount), "", body.Style, body.Language)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	opts.Instructions = instructionsOf(c)

	document, ok := ownedDocument(c, id, true)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	if !document.HasContent || document.Content == "" {
		middleware.RefundQuota(c)
		c.JSON(http.StatusConflict, gin.H{"error": "The original text of this document was not kept, so it cannot be summarized again."})
		return
	}
	if utf8.RuneCountInString(document.Content) > maxTextChars {
		middleware.RefundQuota(c)
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "This document is too long to summarize again in one piece."})
		return
	}

	raw, err := json.Marshal(TextPayload{Text: document.Content})
	if err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare the request."})
		return
	}
	q := url.Values{}
	for k, v := range opts.fields() {
		q.Set(k, v)
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, aiServiceURL("/summarize-text?"+q.Encode()), bytes.NewReader(raw))
	if err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare the request."})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	prepareAIRequest(c, req)

	result, apiErr := callForSummary(req)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}

	// Everything made from the old summary goes with it, except the study material of a document that had no summary:
	// that was made from the text itself, so it is still right.
	err = initializers.DB.Exec(
		"UPDATE documents SET summary = ?, podcast = NULL, suggestions = NULL, study = CASE WHEN summary = '' THEN study ELSE NULL END, updated_at = now() WHERE id = ?",
		result.Summary, document.ID,
	).Error
	if err != nil {
		// The new summary was paid for but cannot be kept: say so, rather than showing one that is lost on reload.
		middleware.RefundQuota(c)
		slog.Error("saving a rewritten summary failed", "document_id", document.ID, "error", err, "request_id", middleware.RequestIDFrom(c))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save the new summary."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ID": document.ID, "Summary": result.Summary})
}
