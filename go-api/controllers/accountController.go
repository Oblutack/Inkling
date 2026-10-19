package controllers

import (
	"ai-summarizer/go-api/auth"
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/models"
	"ai-summarizer/go-api/notices"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// Usage reports how much of today's allowance the signed-in user has used.
func Usage(c *gin.Context) {
	user := middleware.CurrentUser(c)
	summaries, chats, err := middleware.UsageToday(user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load usage"})
		return
	}

	now := time.Now().UTC()
	resets := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
	c.JSON(http.StatusOK, gin.H{
		"summaries": gin.H{"used": summaries, "limit": middleware.QuotaLimit(middleware.QuotaSummaries)},
		"chats":     gin.H{"used": chats, "limit": middleware.QuotaLimit(middleware.QuotaChats)},
		"resetsAt":  resets,
	})
}

// ExportAccount downloads everything we hold about the user as a JSON file: the account itself,
// every saved summary together with the source text kept for chat, and recent usage.
func ExportAccount(c *gin.Context) {
	user := middleware.CurrentUser(c)

	var documents []models.Document
	if err := initializers.DB.Where("user_id = ?", user.ID).Order("id ASC").Find(&documents).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to export your data"})
		return
	}
	if err := attachFiles(documents); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to export your data"})
		return
	}
	docs := make([]gin.H, 0, len(documents))
	for _, d := range documents {
		// The original PDFs themselves are not in the export (the user uploaded them and still has
		// them); their names and sizes are listed so nothing we keep goes unmentioned.
		docs = append(docs, gin.H{
			"id": d.ID, "filename": d.Filename, "createdAt": d.CreatedAt,
			"summary": d.Summary, "sourceText": d.Content, "originalFiles": d.Files, "tags": d.Tags,
		})
	}

	type usageRow struct {
		Day       string `json:"day"`
		Summaries int    `json:"summaries"`
		Chats     int    `json:"chats"`
	}
	var usage []usageRow
	initializers.DB.Raw(`SELECT day::text AS day, summaries, chats FROM daily_usage WHERE user_id = ? ORDER BY day`, user.ID).Scan(&usage)

	// Spaced repetition: how well each flashcard is known (a card is named by the start of the hash of its front), and the
	// days something was reviewed. And the emails the person chose to receive.
	type cardRow struct {
		DocumentID     uint      `json:"documentId"`
		CardKey        string    `json:"cardKey"`
		Box            int       `json:"box"`
		DueOn          string    `json:"dueOn"`
		Reviews        int       `json:"reviews"`
		Lapses         int       `json:"lapses"`
		LastReviewedAt time.Time `json:"lastReviewedAt"`
	}
	cardRows := []cardRow{}
	initializers.DB.Raw(`SELECT document_id, card_key, box, due_on::text AS due_on, reviews, lapses, last_reviewed_at
		FROM card_reviews WHERE user_id = ? ORDER BY document_id, card_key`, user.ID).Scan(&cardRows)
	type reviewDay struct {
		Day   string `json:"day"`
		Count int    `json:"count"`
	}
	reviewDays := []reviewDay{}
	initializers.DB.Raw(`SELECT day::text AS day, count FROM review_days WHERE user_id = ? ORDER BY day`, user.ID).Scan(&reviewDays)
	emailPrefs, _ := notices.PrefsOf(user.ID)
	// The pages the person watches (their text is not exported, only what identifies them and how they are checked).
	type watchExport struct {
		URL           string     `json:"url"`
		Title         string     `json:"title"`
		EveryHours    int        `json:"everyHours"`
		Paused        bool       `json:"paused"`
		LastCheckedAt *time.Time `json:"lastCheckedAt"`
		LastChangedAt *time.Time `json:"lastChangedAt"`
		CreatedAt     time.Time  `json:"createdAt"`
		Changes       int        `json:"changes"`
	}
	watchRows := []watchExport{}
	initializers.DB.Raw(`SELECT w.url, w.title, w.every_hours, w.paused, w.last_checked_at, w.last_changed_at, w.created_at,
		(SELECT count(*) FROM watch_changes c WHERE c.watch_id = w.id) AS changes
		FROM page_watches w WHERE w.user_id = ? ORDER BY w.id`, user.ID).Scan(&watchRows)

	// What was saved to read later, the highlights and notes, and the exams taken (the questions themselves live in the sets).
	type readingExport struct {
		DocumentID uint       `json:"documentId"`
		URL        string     `json:"url"`
		SavedAt    time.Time  `json:"savedAt"`
		ReadAt     *time.Time `json:"readAt"`
		ArchivedAt *time.Time `json:"archivedAt"`
	}
	readingRows := []readingExport{}
	initializers.DB.Raw(`SELECT document_id, url, saved_at, read_at, archived_at FROM reading_items WHERE user_id = ? ORDER BY saved_at`, user.ID).Scan(&readingRows)
	type highlightExport struct {
		DocumentID uint      `json:"documentId"`
		Page       int       `json:"page"`
		Quote      string    `json:"quote"`
		Note       string    `json:"note"`
		CreatedAt  time.Time `json:"createdAt"`
	}
	highlightRows := []highlightExport{}
	initializers.DB.Raw(`SELECT document_id, page, quote, note, created_at FROM document_highlights WHERE user_id = ? ORDER BY document_id, page, id`, user.ID).Scan(&highlightRows)
	type examExport struct {
		Tag        string    `json:"tag"`
		Questions  int       `json:"questions"`
		Correct    int       `json:"correct"`
		Seconds    int       `json:"seconds"`
		FinishedAt time.Time `json:"finishedAt"`
	}
	examRows := []examExport{}
	initializers.DB.Raw(`SELECT tag, questions, correct, seconds, finished_at FROM exam_results WHERE user_id = ? ORDER BY finished_at`, user.ID).Scan(&examRows)

	// The keys themselves are never kept, so the export lists what is: their names, when they were made and last used.
	keyRecords, _ := auth.APIKeysOf(user.ID)
	keys := apiKeysJSON(keyRecords)

	securityEvent(c, "account_exported", user.ID)
	c.Header("Content-Disposition", `attachment; filename="inkling-export.json"`)
	c.JSON(http.StatusOK, gin.H{
		"exportedAt": time.Now().UTC(),
		"account": gin.H{
			"email": user.Email, "createdAt": user.CreatedAt, "emailVerified": user.EmailVerified(),
			// whether two-step sign-in is on (its secret and recovery codes are never part of an export)
			"twoFactorEnabled": user.TwoFactorEnabled(),
		},
		"documents":        docs,
		"apiKeys":          keys,
		"usage":            usage,
		"studyProgress":    gin.H{"cards": cardRows, "days": reviewDays},
		"emailPreferences": emailPrefs,
		"watchedPages":     watchRows,
		"readingList":      readingRows,
		"highlights":       highlightRows,
		"examResults":      examRows,
	})
}

// DeleteAccount permanently deletes the account and everything attached to it. Because it can't be
// undone, it asks the user to type their email and, if they have a password, to enter it too: a
// stolen session alone isn't enough to destroy an account.
func DeleteAccount(c *gin.Context) {
	user := middleware.CurrentUser(c)
	var body struct {
		ConfirmEmail string `json:"confirmEmail"`
		Password     string `json:"password"`
	}
	if !bindJSON(c, &body) {
		return
	}

	if !strings.EqualFold(strings.TrimSpace(body.ConfirmEmail), user.Email) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Type your account email exactly to confirm."})
		return
	}
	if user.HasPassword && bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(body.Password)) != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Your password is incorrect.", "code": "wrong_password"})
		return
	}

	err := initializers.DB.Transaction(func(tx *gorm.DB) error {
		// Documents have no foreign key (they predate it), and are soft-deletable: remove them for real.
		if err := tx.Unscoped().Where("user_id = ?", user.ID).Delete(&models.Document{}).Error; err != nil {
			return err
		}
		// Sessions, email tokens and usage cascade from the user row.
		return tx.Unscoped().Delete(&models.User{}, user.ID).Error
	})
	if err != nil {
		slog.Error("deleting account failed", "user_id", user.ID, "error", err, "request_id", middleware.RequestIDFrom(c))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete your account. Nothing was changed."})
		return
	}

	auth.ClearSessionCookie(c)
	securityEvent(c, "account_deleted", user.ID)
	c.JSON(http.StatusOK, gin.H{"message": "Your account and all its data were deleted."})
}

// updateInstructions stores a user's standing summary preferences.
func updateInstructions(userID uint, instructions string) error {
	return initializers.DB.Model(&models.User{}).Where("id = ?", userID).Update("custom_instructions", instructions).Error
}
