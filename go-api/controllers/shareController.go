package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/models"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// A summary can be shared by a link that anyone can open without an account. The link shows the
// summary and its title and nothing else: not the source text, the original files or the owner. It
// works until the owner removes it (or deletes the document).
const shareTokenBytes = 32

// shareTokenPattern is what a valid token looks like (32 random bytes, base64url, no padding), so
// anything else is refused without touching the database.
var shareTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func newShareToken() (string, error) {
	raw := make([]byte, shareTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// ShareDocument makes a public link for one of the user's documents, or returns the one it already has.
func ShareDocument(c *gin.Context) {
	id, ok := documentIDParam(c)
	if !ok {
		return
	}
	document, ok := ownedDocument(c, id, false)
	if !ok {
		return
	}
	// What is shared is the summary: a document read only to be studied has none yet.
	if strings.TrimSpace(document.Summary) == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "This document has no summary to share."})
		return
	}
	if document.ShareToken != nil {
		c.JSON(http.StatusOK, gin.H{"token": *document.ShareToken})
		return
	}
	token, err := newShareToken()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create the link"})
		return
	}
	// The token is only set where there is none yet, so two clicks at once cannot swap a link someone was just given.
	result := initializers.DB.Model(&models.Document{}).Where("id = ? AND share_token IS NULL", document.ID).Update("share_token", token)
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create the link"})
		return
	}
	if result.RowsAffected == 0 {
		var current models.Document
		if err := initializers.DB.Select("share_token").Where("id = ?", document.ID).First(&current).Error; err != nil || current.ShareToken == nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create the link"})
			return
		}
		token = *current.ShareToken
	}
	c.JSON(http.StatusOK, gin.H{"token": token})
}

// UnshareDocument removes the public link, so it stops working at once.
func UnshareDocument(c *gin.Context) {
	id, ok := documentIDParam(c)
	if !ok {
		return
	}
	document, ok := ownedDocument(c, id, false)
	if !ok {
		return
	}
	if err := initializers.DB.Model(&models.Document{}).Where("id = ?", document.ID).Update("share_token", gorm.Expr("NULL")).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to remove the link"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "The link no longer works."})
}

// SharedDocument shows a shared summary to anyone with the link.
func SharedDocument(c *gin.Context) {
	// A link can be revoked, so a copy of an answer must never be reused; and it is not for search engines.
	c.Header("Cache-Control", "no-store")
	c.Header("X-Robots-Tag", "noindex, nofollow")

	token := c.Param("token")
	if !shareTokenPattern.MatchString(token) {
		c.JSON(http.StatusNotFound, gin.H{"error": "This link does not exist or has been turned off."})
		return
	}
	var document models.Document
	if err := initializers.DB.Select("filename", "summary", "created_at").Where("share_token = ?", token).First(&document).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "This link does not exist or has been turned off."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"title": document.Filename, "summary": document.Summary, "createdAt": document.CreatedAt})
}
