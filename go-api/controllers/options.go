package controllers

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// Keep these in sync with python-ai-service/prompts.py.
const (
	defaultStyle    = "default"
	defaultLanguage = "English"
)

var summaryStyles = []string{"default", "bullets", "brief", "simple", "takeaways", "glance"}

var summaryLanguages = []string{
	"English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Polish",
	"Turkish", "Russian", "Serbian", "Croatian", "Bosnian", "Chinese", "Japanese",
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// Options lists the summary styles and languages the UI can offer.
func Options(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"styles": summaryStyles, "languages": summaryLanguages})
}
