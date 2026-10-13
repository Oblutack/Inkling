package middleware

import (
	"ai-summarizer/go-api/alerts"
	"ai-summarizer/go-api/models"
	"strconv"

	"github.com/gin-gonic/gin"
)

// Routes that say nothing about people using the site: monitors and scrapers call them all day.
var notActivity = map[string]bool{"/": true, "/healthz": true, "/readyz": true, "/metrics": true}

// Activity tells the alerts who is using the site: a signed-in person (or the owner of an API key) counts once, by user
// number, and anyone else by the keyed hash of their address that the daily allowance uses. It records after the
// request, when the sign-in has been looked up, and ignores health checks, metrics, pre-flight requests and routes
// that do not exist (a scanner is not a crowd).
func Activity() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()

		route := c.FullPath()
		if route == "" || notActivity[route] || c.Request.Method == "OPTIONS" {
			return
		}
		if v, ok := c.Get(UserKey); ok {
			if u, ok := v.(models.User); ok {
				alerts.Default.Touch("u:" + strconv.FormatUint(uint64(u.ID), 10))
				return
			}
		}
		alerts.Default.Touch("a:" + visitorKey(c.ClientIP()))
	}
}
