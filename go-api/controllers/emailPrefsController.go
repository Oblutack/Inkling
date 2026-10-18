package controllers

import (
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/notices"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

// The emails a person chose to receive from Inkling (study reminders, alerts for pages they watch, a weekly digest), and
// the time zone that decides when "morning" is.

// EmailPreferences returns what the person chose.
func EmailPreferences(c *gin.Context) {
	user := middleware.CurrentUser(c)
	prefs, err := notices.PrefsOf(user.ID)
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not load your email settings."})
		return
	}
	c.JSON(http.StatusOK, prefs)
}

type emailPrefsRequest struct {
	Watch     *bool   `json:"watch"`
	Reminders *bool   `json:"reminders"`
	Digest    *bool   `json:"digest"`
	TimeZone  *string `json:"timeZone"`
}

// SetEmailPreferences changes what is sent: only what the request names changes.
func SetEmailPreferences(c *gin.Context) {
	var body emailPrefsRequest
	if !bindJSON(c, &body) {
		return
	}
	user := middleware.CurrentUser(c)
	err := notices.Set(user.ID, notices.Update{Watch: body.Watch, Reminders: body.Reminders, Digest: body.Digest, TimeZone: body.TimeZone})
	if errors.Is(err, notices.ErrBadTimeZone) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "That is not a time zone name."})
		return
	}
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not save your email settings."})
		return
	}
	EmailPreferences(c)
}

type unsubscribeRequest struct {
	Token string `json:"token"`
	Kind  string `json:"kind"`
}

// Unsubscribe is what the link at the bottom of an email does (the website's page sends the token here). It needs no login,
// because the token is the proof, and it can only switch emails off. It answers the same whether or not the token matched
// anyone, so it cannot be used to find out who has an account.
func Unsubscribe(c *gin.Context) {
	var body unsubscribeRequest
	if !bindJSON(c, &body) {
		return
	}
	if !notices.IsKind(body.Kind) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unknown kind of email."})
		return
	}
	notices.Unsubscribe(body.Token, body.Kind)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
