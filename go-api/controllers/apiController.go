package controllers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"ai-summarizer/go-api/auth"
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/models"

	"github.com/gin-gonic/gin"
)

// The routes of the API for programs (/v1). They are the summarizing routes of the website with an API key as the way
// in, and nothing saved unless the caller asks for it: ?save=true puts the result in the key owner's library, and the
// reply then has the id of the saved document.

func wantsSave(c *gin.Context) bool { return c.Query("save") == "true" }

func APISummarize(c *gin.Context)         { respond(c, buildFileRequest, wantsSave(c), "") }
func APISummarizeMultiple(c *gin.Context) { respond(c, buildFilesRequest, wantsSave(c), "") }
func APISummarizeText(c *gin.Context)     { respond(c, buildTextRequest, wantsSave(c), "Pasted Text") }
func APISummarizeURL(c *gin.Context)      { respond(c, buildURLRequest, wantsSave(c), "") }

// How much text a comparison or an extraction through the API may hold: keep in step with python-ai-service
// (MAX_COMPARE_CHARS, MAX_MULTI_TEXT_CHARS).
const (
	maxCompareChars = 300_000
	maxExtractChars = 400_000
	maxNameChars    = 200
)

// Request bodies a little larger than the text they may hold (a character can take four bytes).
const (
	CompareBodyBytes = 2*maxCompareChars*4 + 64<<10
	ExtractBodyBytes = maxExtractChars*4 + 64<<10
)

type textSide struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

// checkText says why a text cannot be used, or "" when it can.
func checkText(side textSide, max int) string {
	if strings.TrimSpace(side.Text) == "" {
		return "Both texts need some content."
	}
	if utf8.RuneCountInString(side.Text) > max {
		return "A text is too long."
	}
	return ""
}

// maxExplainChars is the most text "explain this" takes (a few sentences that were selected): keep in step with
// python-ai-service (MAX_EXPLAIN_CHARS).
const maxExplainChars = 2000

// APIExplain explains a few selected words or sentences in plain words ({"text", "simpler"?, "language"?}): what the browser
// extension's "Explain this" asks for. Nothing is saved. It counts as one chat question of the key owner's allowance.
func APIExplain(c *gin.Context) {
	var body struct {
		Text     string `json:"text"`
		Simpler  bool   `json:"simpler"`
		Language string `json:"language"`
	}
	if !bindJSON(c, &body) {
		middleware.RefundQuota(c)
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "There is nothing to explain."})
		return
	}
	if utf8.RuneCountInString(text) > maxExplainChars {
		middleware.RefundQuota(c)
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Select less text to explain (at most 2000 characters)."})
		return
	}
	if body.Language != "" && !contains(summaryLanguages, body.Language) {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported language."})
		return
	}
	payload := gin.H{"text": text, "simpler": body.Simpler}
	if body.Language != "" {
		payload["language"] = body.Language
	}
	reply, apiErr := postToAI(c, "/explain", payload)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	var out struct {
		Explanation string `json:"explanation"`
	}
	if json.Unmarshal(reply, &out) != nil || strings.TrimSpace(out.Explanation) == "" {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadGateway, gin.H{"error": "The AI service returned an empty explanation."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"explanation": clip(cleanLine(out.Explanation), 1500)})
}

// APICompare compares two texts sent in the request (nothing is looked up or saved): what was added, removed, changed
// or moved, with exact quotes and an explanation of each. The same work as comparing two saved documents.
func APICompare(c *gin.Context) {
	var body struct {
		Old      textSide `json:"old"`
		New      textSide `json:"new"`
		Language string   `json:"language"`
	}
	if !bindJSON(c, &body) {
		middleware.RefundQuota(c)
		return
	}
	for _, side := range []textSide{body.Old, body.New} {
		if msg := checkText(side, maxCompareChars); msg != "" {
			middleware.RefundQuota(c)
			status := http.StatusBadRequest
			if strings.Contains(msg, "long") {
				status = http.StatusRequestEntityTooLarge
			}
			c.JSON(status, gin.H{"error": msg})
			return
		}
	}
	if body.Language != "" && !contains(summaryLanguages, body.Language) {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported language."})
		return
	}
	result, apiErr := postComparison(c, clip(plainLine(body.Old.Name), maxNameChars), body.Old.Text, clip(plainLine(body.New.Name), maxNameChars), body.New.Text, body.Language)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	c.JSON(http.StatusOK, result)
}

// APIExtract reads named fields out of a text sent in the request, with the exact quote and the check for each. The
// same work as extracting from a saved document.
func APIExtract(c *gin.Context) {
	var body struct {
		Name     string         `json:"name"`
		Text     string         `json:"text"`
		Fields   []extractField `json:"fields"`
		Language string         `json:"language"`
	}
	if !bindJSON(c, &body) {
		middleware.RefundQuota(c)
		return
	}
	fields, err := cleanExtractFields(body.Fields)
	if err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(body.Text) == "" {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Text is required."})
		return
	}
	if utf8.RuneCountInString(body.Text) > maxExtractChars {
		middleware.RefundQuota(c)
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "The text is too long."})
		return
	}
	if body.Language != "" && !contains(summaryLanguages, body.Language) {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported language."})
		return
	}
	result, apiErr := postExtraction(c, clip(plainLine(body.Name), maxNameChars), body.Text, fields, body.Language)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	c.JSON(http.StatusOK, result)
}

// APIUsage is Usage with what the key making the request has done and what it is allowed.
func APIUsage(c *gin.Context) {
	user := middleware.CurrentUser(c)
	summaries, chats, err := middleware.UsageToday(user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load usage"})
		return
	}
	reply := gin.H{
		"summaries": gin.H{"used": summaries, "limit": middleware.QuotaLimit(middleware.QuotaSummaries)},
		"chats":     gin.H{"used": chats, "limit": middleware.QuotaLimit(middleware.QuotaChats)},
		"resetsAt":  nextMidnightUTC(),
	}
	if id, ok := c.Get(middleware.APIKeyIDKey); ok {
		var key models.APIKey
		if initializers.DB.First(&key, id).Error == nil {
			use, _ := apiKeyUse(key.ID)
			reply["key"] = gin.H{"id": key.ID, "name": key.Name, "usedToday": use.Today, "usedTotal": use.Total, "dailyLimit": key.DailyLimit, "expiresAt": key.ExpiresAt}
		}
	}
	c.JSON(http.StatusOK, reply)
}

func nextMidnightUTC() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
}

// apiKeyUse is what one key has done.
func apiKeyUse(id uint) (auth.KeyUse, error) {
	use, err := auth.APIKeyUse([]uint{id})
	return use[id], err
}
