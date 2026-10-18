package controllers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/models"

	"github.com/gin-gonic/gin"
)

// What a comparison sends back. The AI service's reply is read into these and written out again, so only these fields
// ever reach a browser, whatever the reply held, and every value is in the range the interface expects.
type compareChange struct {
	ID         int        `json:"id"`
	Kind       string     `json:"kind"`
	Before     string     `json:"before"`
	After      string     `json:"after"`
	BeforePage *int       `json:"beforePage"`
	AfterPage  *int       `json:"afterPage"`
	Segments   [][]string `json:"segments"`
	Numbers    struct {
		Removed []string `json:"removed"`
		Added   []string `json:"added"`
	} `json:"numbers"`
	Importance string `json:"importance"`
	Summary    string `json:"summary"`
	Impact     string `json:"impact"`
	Explained  bool   `json:"explained"`
	// Suspicious: the text of this change reads like an instruction to an AI.
	Suspicious bool `json:"suspicious"`
}

type compareResult struct {
	Identical  bool            `json:"identical"`
	Counts     map[string]int  `json:"counts"`
	Changes    []compareChange `json:"changes"`
	BottomLine string          `json:"bottomLine"`
	Explained  bool            `json:"explained"`
	Omitted    int             `json:"omitted"`
	Suspicious bool            `json:"suspicious"`
}

const (
	maxCompareChanges = 300
	maxCompareText    = 3000
	maxCompareSayings = 400
	maxCompareNumbers = 10
	maxCompareSegment = 6000
)

var (
	compareKinds        = []string{"added", "removed", "changed", "moved"}
	compareImportances  = []string{"high", "medium", "low"}
	compareSegmentKinds = []string{"eq", "del", "ins"}
)

func clip(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max-1]) + "…"
}

func clipAll(items []string, max, each int) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if len(out) == max {
			break
		}
		out = append(out, clip(item, each))
	}
	return out
}

// tidyComparison makes whatever the AI service sent into a result that is safe and shaped as the interface expects.
func tidyComparison(raw compareResult) compareResult {
	out := compareResult{
		Identical:  raw.Identical,
		Counts:     map[string]int{},
		Changes:    []compareChange{},
		BottomLine: clip(strings.TrimSpace(raw.BottomLine), 1200),
		Explained:  raw.Explained,
		Omitted:    max(raw.Omitted, 0),
		Suspicious: raw.Suspicious,
	}
	for _, kind := range compareKinds {
		out.Counts[kind] = max(raw.Counts[kind], 0)
	}
	for _, c := range raw.Changes {
		if len(out.Changes) == maxCompareChanges {
			break
		}
		if !contains(compareKinds, c.Kind) {
			continue
		}
		if !contains(compareImportances, c.Importance) {
			c.Importance = "low"
		}
		c.Before, c.After = clip(c.Before, maxCompareText), clip(c.After, maxCompareText)
		c.Summary, c.Impact = clip(c.Summary, maxCompareSayings), clip(c.Impact, maxCompareSayings)
		c.Numbers.Removed = clipAll(c.Numbers.Removed, maxCompareNumbers, 24)
		c.Numbers.Added = clipAll(c.Numbers.Added, maxCompareNumbers, 24)
		var segments [][]string
		total := 0
		for _, s := range c.Segments {
			if len(s) != 2 || !contains(compareSegmentKinds, s[0]) {
				segments = nil
				break
			}
			total += utf8.RuneCountInString(s[1])
			segments = append(segments, []string{s[0], s[1]})
		}
		if total > maxCompareSegment {
			segments = nil
		}
		c.Segments = segments
		out.Changes = append(out.Changes, c)
	}
	return out
}

// CompareDocuments says what changed between two of the user's saved documents (an older and a newer version of the
// same thing), and how much it could matter. The differences themselves are found by a program in the AI service, so
// what is shown as "before" and "after" is exactly the text of the two documents; the model only explains them.
// Nothing is saved: a comparison is worked out when it is asked for.
func CompareDocuments(c *gin.Context) {
	var body struct {
		OldID    uint   `json:"oldId"`
		NewID    uint   `json:"newId"`
		Language string `json:"language"`
	}
	if !bindJSON(c, &body) {
		middleware.RefundQuota(c)
		return
	}
	if body.OldID == 0 || body.NewID == 0 {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Choose two documents to compare."})
		return
	}
	if body.OldID == body.NewID {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Choose two different documents to compare."})
		return
	}
	if body.Language != "" && !contains(summaryLanguages, body.Language) {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported language."})
		return
	}

	var sides [2]models.Document
	for i, id := range []uint{body.OldID, body.NewID} {
		document, ok := ownedDocument(c, id, true)
		if !ok {
			middleware.RefundQuota(c)
			return
		}
		if !document.HasContent || strings.TrimSpace(document.Content) == "" {
			middleware.RefundQuota(c)
			c.JSON(http.StatusConflict, gin.H{"error": "“" + clip(document.Filename, 80) + "” has no saved text to compare (it was saved before the text was kept)."})
			return
		}
		sides[i] = document
	}

	result, apiErr := postComparison(c, sides[0].Filename, sides[0].Content, sides[1].Filename, sides[1].Content, body.Language)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	c.JSON(http.StatusOK, result)
}

// postComparison asks the AI service to compare two texts and returns the result in the shape that may be sent on.
func postComparison(c *gin.Context, oldName, oldText, newName, newText, language string) (compareResult, *apiError) {
	return compareTexts(c.Request.Context(), middleware.RequestIDFrom(c), oldName, oldText, newName, newText, language)
}

// compareTexts is postComparison for callers that are not a request.
func compareTexts(ctx context.Context, requestID, oldName, oldText, newName, newText, language string) (compareResult, *apiError) {
	reply, apiErr := postToAIContext(ctx, requestID, "/compare", gin.H{
		"old":      gin.H{"name": oldName, "text": oldText},
		"new":      gin.H{"name": newName, "text": newText},
		"language": language,
	})
	if apiErr != nil {
		return compareResult{}, apiErr
	}
	var raw compareResult
	if err := json.Unmarshal(reply, &raw); err != nil {
		return compareResult{}, &apiError{http.StatusBadGateway, "The AI service returned an unreadable comparison."}
	}
	return tidyComparison(raw), nil
}
