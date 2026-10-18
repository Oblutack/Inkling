package controllers

import (
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/reviews"
	"errors"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// Spaced repetition: after seeing a flashcard a person says whether they knew it, and the card comes back sooner or later
// (see package reviews). None of this calls a model, so none of it uses the daily allowance.

// dueListSize is how many cards one review session is given at a time.
const dueListSize = 50

// todayOf is the person's calendar day, in the time zone their browser told us.
func todayOf(userID uint) string {
	return reviews.Today(time.Now(), reviews.LocationOf(userID))
}

type rateRequest struct {
	Front string `json:"front"`
	Knew  *bool  `json:"knew"`
}

// RateCard records that the person knew a card of one of their sets, or did not. The card is named by its front text, so
// a card that has been replaced since the page was opened is refused instead of rated by mistake.
func RateCard(c *gin.Context) {
	id, ok := documentIDParam(c)
	if !ok {
		return
	}
	if _, ok := ownedDocument(c, id, false); !ok {
		return
	}
	var body rateRequest
	if !bindJSON(c, &body) {
		return
	}
	if body.Knew == nil || body.Front == "" || utf8.RuneCountInString(body.Front) > maxCardRunes*2 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Say which card, and whether you knew it."})
		return
	}
	user := middleware.CurrentUser(c)
	result, err := reviews.Rate(user.ID, id, body.Front, *body.Knew, todayOf(user.ID))
	if errors.Is(err, reviews.ErrNoSuchCard) {
		c.JSON(http.StatusNotFound, gin.H{"error": "That card is no longer in this set."})
		return
	}
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not save that."})
		return
	}
	c.JSON(http.StatusOK, result)
}

// CardProgress says how well each reviewed card of a set is known, and which are due.
func CardProgress(c *gin.Context) {
	id, ok := documentIDParam(c)
	if !ok {
		return
	}
	if _, ok := ownedDocument(c, id, false); !ok {
		return
	}
	user := middleware.CurrentUser(c)
	items, err := reviews.Progress(id, todayOf(user.ID))
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not load the progress."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"cards": items})
}

// DueCards is the next review session: the cards due today across all of the person's sets, longest overdue first.
func DueCards(c *gin.Context) {
	user := middleware.CurrentUser(c)
	cards, total, err := reviews.Due(user.ID, todayOf(user.ID), dueListSize)
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not load the cards."})
		return
	}
	if cards == nil {
		cards = []reviews.DueCard{}
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"cards": cards, "total": total})
}

// StudyStats is the review record: cards due, cards reviewed today and the streak.
func StudyStats(c *gin.Context) {
	user := middleware.CurrentUser(c)
	stats, err := reviews.StatsOf(user.ID, todayOf(user.ID))
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not load your progress."})
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, stats)
}
