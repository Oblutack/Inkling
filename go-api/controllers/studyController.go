package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/models"
	"bytes"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
)

// Questions to ask about a document, and study material (flashcards, a quiz) made from it. Each is
// written by the model once and stored with the document, so showing it again costs nothing. The
// source text is only given to the model when it is short; otherwise it works from the summary.
const (
	studyFullTextMax   = 12_000
	maxSuggestions     = 5
	minSuggestions     = 3
	maxSuggestionRunes = 140
	maxCards           = 12
	minCards           = 3
	maxCardRunes       = 400
	maxQuizQuestions   = 10
	minQuizQuestions   = 3
	quizOptionCount    = 4
	maxQuizRunes       = 300
	kindFlashcards     = "flashcards"
	kindQuiz           = "quiz"
)

type studyCard struct {
	Front string `json:"front"`
	Back  string `json:"back"`
}

type quizQuestion struct {
	Question    string   `json:"question"`
	Options     []string `json:"options"`
	Answer      int      `json:"answer"`
	Explanation string   `json:"explanation"`
}

// studyMaterial is what is stored (as JSON) for a document: whichever kinds have been made.
type studyMaterial struct {
	Flashcards []studyCard    `json:"flashcards,omitempty"`
	Quiz       []quizQuestion `json:"quiz,omitempty"`
}

// postToAI sends a JSON payload to the AI service and returns the body of a successful reply.
func postToAI(c *gin.Context, path string, payload any) ([]byte, *apiError) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, &apiError{http.StatusInternalServerError, "Failed to prepare the request."}
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, aiServiceURL(path), bytes.NewReader(raw))
	if err != nil {
		return nil, &apiError{http.StatusInternalServerError, "Failed to prepare the request."}
	}
	req.Header.Set("Content-Type", "application/json")
	prepareAIRequest(c, req)
	return callAIService(req)
}

// materialFor is what the model is told about a document.
func materialFor(document models.Document) gin.H {
	text := ""
	if document.HasContent && utf8.RuneCountInString(document.Content) <= studyFullTextMax {
		text = document.Content
	}
	return gin.H{"summary": document.Summary, "text": text}
}

// hasStudySource says whether the model has something to work from: the summary or, when a document has none (one
// read only to be studied), its text, provided that is short enough to be given whole.
func hasStudySource(document models.Document) bool {
	if strings.TrimSpace(document.Summary) != "" {
		return true
	}
	return document.HasContent && strings.TrimSpace(document.Content) != "" && utf8.RuneCountInString(document.Content) <= studyFullTextMax
}

// makeStudyMaterial asks the AI service for flashcards or a quiz about a document. It returns what to keep (as JSON) and
// what to answer with. The reply is cleaned first, so only well-formed cards and questions are ever kept or shown.
func makeStudyMaterial(c *gin.Context, document models.Document, kind string) ([]byte, gin.H, *apiError) {
	payload := materialFor(document)
	payload["kind"] = kind
	respBody, apiErr := postToAI(c, "/study", payload)
	if apiErr != nil {
		return nil, nil, apiErr
	}
	switch kind {
	case kindFlashcards:
		var out struct {
			Cards []studyCard `json:"cards"`
		}
		if err := json.Unmarshal(respBody, &out); err != nil {
			return nil, nil, &apiError{http.StatusBadGateway, "The AI service returned unreadable flashcards."}
		}
		cards := cleanCards(out.Cards)
		if len(cards) < minCards {
			return nil, nil, &apiError{http.StatusBadGateway, "The AI service returned too few flashcards."}
		}
		stored, _ := json.Marshal(cards)
		return stored, gin.H{"kind": kindFlashcards, "cards": cards}, nil
	case kindQuiz:
		var out struct {
			Questions []quizQuestion `json:"questions"`
		}
		if err := json.Unmarshal(respBody, &out); err != nil {
			return nil, nil, &apiError{http.StatusBadGateway, "The AI service returned an unreadable quiz."}
		}
		questions := cleanQuiz(out.Questions)
		if len(questions) < minQuizQuestions {
			return nil, nil, &apiError{http.StatusBadGateway, "The AI service returned too few quiz questions."}
		}
		stored, _ := json.Marshal(questions)
		return stored, gin.H{"kind": kindQuiz, "questions": questions}, nil
	}
	return nil, nil, &apiError{http.StatusBadRequest, "Choose flashcards or quiz."}
}

// ---- suggested questions -----------------------------------------------------------------------------

// SuggestQuestions returns questions worth asking about a document, writing them first if needed.
// Making them is a small model call that happens once per summary, so it is rate limited but does not
// use up the daily allowance. It does count against the site's daily budget, and only when the model is really asked:
// stored questions and failures give the count back.
func SuggestQuestions(c *gin.Context) {
	id, ok := documentIDParam(c)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	document, ok := ownedDocument(c, id, true)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	if stored := storedSuggestions(document.ID); len(stored) > 0 {
		middleware.RefundQuota(c)
		c.JSON(http.StatusOK, gin.H{"questions": stored})
		return
	}
	if !hasStudySource(document) {
		middleware.RefundQuota(c)
		c.JSON(http.StatusConflict, gin.H{"error": "This document has no summary to suggest questions from."})
		return
	}

	body, apiErr := postToAI(c, "/suggest", materialFor(document))
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	var out struct {
		Questions []string `json:"questions"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadGateway, gin.H{"error": "The AI service returned unreadable questions."})
		return
	}
	questions := cleanSuggestions(out.Questions)
	if len(questions) < minSuggestions {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadGateway, gin.H{"error": "The AI service returned no usable questions."})
		return
	}
	if stored, err := json.Marshal(questions); err == nil {
		if err := initializers.DB.Exec("UPDATE documents SET suggestions = ?::jsonb WHERE id = ?", string(stored), document.ID).Error; err != nil {
			slog.Error("saving suggested questions failed", "document_id", document.ID, "error", err, "request_id", middleware.RequestIDFrom(c))
		}
	}
	c.JSON(http.StatusOK, gin.H{"questions": questions})
}

func storedSuggestions(documentID uint) []string {
	var raw sql.NullString
	if err := initializers.DB.Raw("SELECT suggestions::text FROM documents WHERE id = ?", documentID).Scan(&raw).Error; err != nil || !raw.Valid {
		return nil
	}
	var questions []string
	if err := json.Unmarshal([]byte(raw.String), &questions); err != nil {
		return nil
	}
	return questions
}

// cleanSuggestions keeps short one-line questions, without duplicates.
func cleanSuggestions(in []string) []string {
	out := make([]string, 0, maxSuggestions)
	seen := map[string]bool{}
	for _, q := range in {
		q = cleanLine(q)
		key := strings.ToLower(q)
		if q == "" || seen[key] || utf8.RuneCountInString(q) > maxSuggestionRunes {
			continue
		}
		seen[key] = true
		out = append(out, q)
		if len(out) == maxSuggestions {
			break
		}
	}
	return out
}

// ---- flashcards and quiz -------------------------------------------------------------------------------

type studyRequest struct {
	Kind       string `json:"kind"`
	Regenerate bool   `json:"regenerate"`
}

func parseStudyRequest(c *gin.Context) (id uint, body studyRequest, ok bool) {
	id, ok = documentIDParam(c)
	if !ok {
		return 0, body, false
	}
	if err := c.ShouldBindBodyWith(&body, binding.JSON); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body."})
		return 0, body, false
	}
	if body.Kind != kindFlashcards && body.Kind != kindQuiz {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Choose flashcards or quiz."})
		return 0, body, false
	}
	return id, body, true
}

// ReplayStoredStudy answers from stored material before the daily allowance is touched: showing what
// was already made costs no model call, so it works even for someone who has used their allowance up.
func ReplayStoredStudy(c *gin.Context) {
	user := middleware.CurrentUser(c)
	id, body, ok := parseStudyRequest(c)
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
		if response, found := storedStudy(id, body.Kind); found {
			response["cached"] = true
			c.AbortWithStatusJSON(http.StatusOK, response)
			return
		}
	}
	c.Next()
}

// StudyDocument makes flashcards or a quiz for one of the user's documents. It runs after
// ReplayStoredStudy, so it only has new work to do, and it is what the allowance is charged for.
func StudyDocument(c *gin.Context) {
	id, body, ok := parseStudyRequest(c)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	document, ok := ownedDocument(c, id, true)
	if !ok {
		middleware.RefundQuota(c)
		return
	}
	if !hasStudySource(document) {
		middleware.RefundQuota(c)
		c.JSON(http.StatusConflict, gin.H{"error": "This document has no summary to study from."})
		return
	}

	stored, response, apiErr := makeStudyMaterial(c, document, body.Kind)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}

	// Keeping the material is a convenience: if it cannot be saved the user still gets it.
	err := initializers.DB.Exec(
		"UPDATE documents SET study = COALESCE(study, '{}'::jsonb) || jsonb_build_object(?::text, ?::jsonb) WHERE id = ?",
		body.Kind, string(stored), id,
	).Error
	if err != nil {
		slog.Error("saving study material failed", "document_id", id, "error", err, "request_id", middleware.RequestIDFrom(c))
	}
	response["cached"] = false
	c.JSON(http.StatusOK, response)
}

// storedStudy reads the saved material of one kind, shaped like the response that made it.
func storedStudy(documentID uint, kind string) (gin.H, bool) {
	var raw sql.NullString
	if err := initializers.DB.Raw("SELECT study::text FROM documents WHERE id = ?", documentID).Scan(&raw).Error; err != nil || !raw.Valid {
		return nil, false
	}
	var material studyMaterial
	if err := json.Unmarshal([]byte(raw.String), &material); err != nil {
		return nil, false
	}
	switch kind {
	case kindFlashcards:
		if len(material.Flashcards) >= minCards {
			return gin.H{"kind": kindFlashcards, "cards": material.Flashcards}, true
		}
	case kindQuiz:
		if len(material.Quiz) >= minQuizQuestions {
			return gin.H{"kind": kindQuiz, "questions": material.Quiz}, true
		}
	}
	return nil, false
}

// cleanCards bounds flashcards and drops incomplete ones and repeats.
func cleanCards(in []studyCard) []studyCard {
	out := make([]studyCard, 0, maxCards)
	seen := map[string]bool{}
	for _, card := range in {
		front := truncateRunes(cleanLine(card.Front), maxCardRunes)
		back := truncateRunes(cleanLine(card.Back), maxCardRunes)
		key := strings.ToLower(front)
		if front == "" || back == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, studyCard{Front: front, Back: back})
		if len(out) == maxCards {
			break
		}
	}
	return out
}

// cleanQuiz keeps only well-formed questions: four different non-empty options and an answer that
// points at one of them.
func cleanQuiz(in []quizQuestion) []quizQuestion {
	out := make([]quizQuestion, 0, maxQuizQuestions)
	seen := map[string]bool{}
	for _, q := range in {
		question := truncateRunes(cleanLine(q.Question), maxQuizRunes)
		if question == "" || seen[strings.ToLower(question)] || len(q.Options) != quizOptionCount || q.Answer < 0 || q.Answer >= quizOptionCount {
			continue
		}
		options := make([]string, quizOptionCount)
		distinct := map[string]bool{}
		valid := true
		for i, o := range q.Options {
			options[i] = truncateRunes(cleanLine(o), maxQuizRunes)
			if options[i] == "" || distinct[strings.ToLower(options[i])] {
				valid = false
				break
			}
			distinct[strings.ToLower(options[i])] = true
		}
		if !valid {
			continue
		}
		seen[strings.ToLower(question)] = true
		out = append(out, quizQuestion{
			Question: question, Options: options, Answer: q.Answer, Explanation: truncateRunes(cleanLine(q.Explanation), maxQuizRunes),
		})
		if len(out) == maxQuizQuestions {
			break
		}
	}
	return out
}
