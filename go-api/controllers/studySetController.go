package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/models"
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// Study sets: a document read only to be studied. What was pasted, linked or uploaded is read (no summary is asked for),
// flashcards are made at once, and the document is saved with them, so the quiz, the chat and the other tools can be
// used on it later. A text too long to be given to the model whole gets a short summary first, because the cards are
// made from it; that summary is written in the text's own language and kept with the document like any other.

const (
	studySetFallbackTitle = "Study Set"
	// sameLanguage asks the AI service to write in the language of the text, not in a language chosen for it.
	sameLanguage = "Same as the text"
)

// aiRead is the AI service's reply to /read and /read-url: the text of a document, with no summary made.
type aiRead struct {
	Filename string `json:"filename"`
	Text     string `json:"text"`
}

// CreateStudySetText makes a study set from pasted text.
func CreateStudySetText(c *gin.Context) {
	var payload TextPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body."})
		return
	}
	if strings.TrimSpace(payload.Text) == "" {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Text is required."})
		return
	}
	if utf8.RuneCountInString(payload.Text) > maxTextChars {
		middleware.RefundQuota(c)
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": fmt.Sprintf("Text is too long (max %d characters).", maxTextChars)})
		return
	}
	createStudySet(c, titleFromText(payload.Text, studySetFallbackTitle), payload.Text, nil)
}

// CreateStudySetURL makes a study set from the page at a web address (the AI service opens it).
func CreateStudySetURL(c *gin.Context) {
	address, apiErr := webAddressOf(c)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	body, err := json.Marshal(URLPayload{URL: address})
	if err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare the request."})
		return
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, aiServiceURL("/read-url?ocr=true"), bytes.NewReader(body))
	if err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare the request."})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	prepareAIRequest(c, req)

	read, apiErr := callForRead(req)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	createStudySet(c, read.Filename, read.Text, nil)
}

// CreateStudySetFiles makes a study set from one or more uploaded files (PDF, Word, PowerPoint, photos or a
// recording), checked the same way as for a combined summary.
func CreateStudySetFiles(c *gin.Context) {
	files, apiErr := checkedUploads(c)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	ar, apiErr := multipartRequest(c, "/read", map[string]string{"ocr": "true"}, "files", files)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	read, apiErr := callForRead(ar.req)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	createStudySet(c, read.Filename, read.Text, ar.files)
}

func callForRead(req *http.Request) (*aiRead, *apiError) {
	body, apiErr := callAIService(req)
	if apiErr != nil {
		return nil, apiErr
	}
	var out aiRead
	if err := json.Unmarshal(body, &out); err != nil || strings.TrimSpace(out.Text) == "" {
		return nil, &apiError{http.StatusBadGateway, "The AI service returned no text."}
	}
	return &out, nil
}

// createStudySet reads nothing itself: it makes the flashcards for text that has been read, saves the document with
// them and answers with the cards and the new document's id. Whatever fails gives the daily allowance back.
func createStudySet(c *gin.Context, title, text string, kept []storedFile) {
	user := middleware.CurrentUser(c)
	if strings.TrimSpace(title) == "" {
		title = studySetFallbackTitle
	}
	document := models.Document{Filename: title, UserID: user.ID, Content: text, HasContent: true}

	if utf8.RuneCountInString(text) > studyFullTextMax {
		summary, apiErr := summaryToStudyFrom(c, text)
		if apiErr != nil {
			middleware.RefundQuota(c)
			apiErr.send(c)
			return
		}
		document.Summary = summary
	}

	stored, response, apiErr := makeStudyMaterial(c, document, kindFlashcards)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	if err := initializers.DB.Create(&document).Error; err != nil {
		middleware.RefundQuota(c)
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save the study set."})
		return
	}
	// Keeping the cards is a convenience: if that fails the person still gets them, and can ask for them again.
	err := initializers.DB.Exec(
		"UPDATE documents SET study = jsonb_build_object(?::text, ?::jsonb) WHERE id = ?",
		kindFlashcards, string(stored), document.ID,
	).Error
	if err != nil {
		slog.Error("saving study material failed", "document_id", document.ID, "error", err, "request_id", middleware.RequestIDFrom(c))
	}
	storeFiles(user.ID, document.ID, kept)
	indexAfterSave(middleware.RequestIDFrom(c), document)

	response["id"] = document.ID
	response["title"] = title
	response["cached"] = false
	c.JSON(http.StatusCreated, response)
}

// summaryToStudyFrom writes the short summary a long text is studied through, in the language the text is in.
func summaryToStudyFrom(c *gin.Context, text string) (string, *apiError) {
	raw, err := json.Marshal(TextPayload{Text: text})
	if err != nil {
		return "", &apiError{http.StatusInternalServerError, "Failed to prepare the request."}
	}
	q := url.Values{}
	q.Set("word_count", strconv.Itoa(defaultWords))
	q.Set("page_limit", "0")
	q.Set("style", defaultStyle)
	q.Set("language", sameLanguage)
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, aiServiceURL("/summarize-text?"+q.Encode()), bytes.NewReader(raw))
	if err != nil {
		return "", &apiError{http.StatusInternalServerError, "Failed to prepare the request."}
	}
	req.Header.Set("Content-Type", "application/json")
	prepareAIRequest(c, req)
	result, apiErr := callForSummary(req)
	if apiErr != nil {
		return "", apiErr
	}
	return result.Summary, nil
}
