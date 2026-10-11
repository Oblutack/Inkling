package middleware

import (
	"ai-summarizer/go-api/models"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

// CurrentUser returns the user set by RequireAuth. Only call it behind RequireAuth.
func CurrentUser(c *gin.Context) models.User {
	return c.MustGet(UserKey).(models.User)
}

// CurrentSessionID returns the id of the session making the request.
func CurrentSessionID(c *gin.Context) uint {
	return c.MustGet(SessionIDKey).(uint)
}

// AllowedOrigins parses CORS_ALLOWED_ORIGINS (comma separated). Credentials are only ever sent to
// these origins, so it must be an explicit list, never a wildcard.
func AllowedOrigins() []string {
	raw := os.Getenv("CORS_ALLOWED_ORIGINS")
	if strings.TrimSpace(raw) == "" {
		return []string{"http://localhost:3000", "https://ai-summarizer-ten-tan.vercel.app"}
	}
	var origins []string
	for _, o := range strings.Split(raw, ",") {
		if o = strings.TrimRight(strings.TrimSpace(o), "/"); o != "" {
			origins = append(origins, o)
		}
	}
	return origins
}

// OriginCheck is the CSRF defence for cookie authentication. Browsers attach the session cookie
// to requests made from any site, so a state-changing request is rejected unless the browser says
// it came from one of our own frontends. Browsers always send Origin on cross-origin and POST/
// DELETE requests, and a page cannot forge it. Requests without an Origin (curl, scripts, server to
// server) are not browser-driven, so they are left to normal authentication.
func OriginCheck(allowed []string) gin.HandlerFunc {
	set := make(map[string]bool, len(allowed))
	for _, o := range allowed {
		set[o] = true
	}
	return func(c *gin.Context) {
		switch c.Request.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			c.Next()
			return
		}
		if origin := c.GetHeader("Origin"); origin != "" && !set[origin] && !extensionCallingWithKey(c, origin) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Request blocked: unexpected origin."})
			return
		}
		c.Next()
	}
}

// ExtensionMayCallKeyRoutes is true for a request to the API for programs (/v1) from a browser extension. An extension
// is something the person installed themselves and keeps its key to itself, and a web page cannot pretend to be one:
// the browser sets the extension's origin, and no page can change it. Pages of other sites stay blocked, because a
// key has no place in a web page. (It is the browser's CORS check, and then OriginCheck, that this is allowed through;
// the key itself is still required.)
func ExtensionMayCallKeyRoutes(c *gin.Context, origin string) bool {
	if !strings.HasPrefix(origin, "chrome-extension://") && !strings.HasPrefix(origin, "moz-extension://") {
		return false
	}
	return c.Request.URL.Path == "/v1" || strings.HasPrefix(c.Request.URL.Path, "/v1/")
}

func extensionCallingWithKey(c *gin.Context, origin string) bool {
	return ExtensionMayCallKeyRoutes(c, origin) && strings.HasPrefix(c.GetHeader("Authorization"), "Bearer ")
}

// SecurityHeaders sets defensive headers on every API response. The API only ever returns JSON or
// an event stream, so the strictest CSP applies: nothing may be loaded or framed from it.
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		// Responses are per-user (and cookie-authenticated), so no shared cache may keep them.
		h.Set("Cache-Control", "no-store")
		if c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https") {
			h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		c.Next()
	}
}
