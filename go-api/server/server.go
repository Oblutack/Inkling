// Package server builds the HTTP router: every route and the middleware in front of it. It is a
// package of its own so the tests exercise exactly what production runs.
package server

import (
	"ai-summarizer/go-api/auth"
	"ai-summarizer/go-api/controllers"
	"ai-summarizer/go-api/metrics"
	"ai-summarizer/go-api/middleware"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// Rates is how many requests each kind of caller may make: a burst, then a steady rate per minute.
type Rates struct {
	AuthPerMinute, AuthBurst                   int // account endpoints, per IP
	SummarizeIPPerMinute, SummarizeIPBurst     int // anonymous summaries, per IP
	SummarizeUserPerMinute, SummarizeUserBurst int // signed-in summaries, per user
	ChatPerMinute, ChatBurst                   int // chat, per user
	ExportPerMinute, ExportBurst               int // data export, per user
}

// DefaultRates are the production limits.
var DefaultRates = Rates{
	AuthPerMinute: 20, AuthBurst: 10,
	SummarizeIPPerMinute: 6, SummarizeIPBurst: 3,
	SummarizeUserPerMinute: 10, SummarizeUserBurst: 5,
	ChatPerMinute: 20, ChatBurst: 10,
	ExportPerMinute: 2, ExportBurst: 2,
}

// Scaled returns the limits multiplied by factor (RATE_LIMIT_MULTIPLIER), for deployments that need
// more headroom than the defaults, such as many users behind one corporate address. A factor
// below 1 leaves the limits unchanged.
func (r Rates) Scaled(factor int) Rates {
	if factor <= 1 {
		return r
	}
	return Rates{
		AuthPerMinute: r.AuthPerMinute * factor, AuthBurst: r.AuthBurst * factor,
		SummarizeIPPerMinute: r.SummarizeIPPerMinute * factor, SummarizeIPBurst: r.SummarizeIPBurst * factor,
		SummarizeUserPerMinute: r.SummarizeUserPerMinute * factor, SummarizeUserBurst: r.SummarizeUserBurst * factor,
		ChatPerMinute: r.ChatPerMinute * factor, ChatBurst: r.ChatBurst * factor,
		ExportPerMinute: r.ExportPerMinute * factor, ExportBurst: r.ExportBurst * factor,
	}
}

// NewRouter returns the configured router. Rate limiters are created fresh for each router, so
// every router (and every test) starts with full allowances.
func NewRouter(logger *slog.Logger, rates Rates) (*gin.Engine, error) {
	r := gin.New()
	r.Use(middleware.RequestID(), middleware.AccessLog(logger), metrics.HTTP(), middleware.Recover(logger), middleware.SecurityHeaders())

	// Client IPs drive the rate limits and the anonymous daily allowance. Behind a proxy such as Render, list its
	// addresses in TRUSTED_PROXIES (comma separated CIDRs) so X-Forwarded-For is only believed from it. Without it no
	// proxy is trusted: a client cannot choose its own address by sending the header. Behind a proxy that makes every
	// visitor look like the proxy (they then share the per-address limits), which is the visible way to get this
	// wrong, where believing the header from anyone would be a silent hole.
	if proxies := os.Getenv("TRUSTED_PROXIES"); proxies != "" {
		if err := r.SetTrustedProxies(strings.Split(proxies, ",")); err != nil {
			return nil, err
		}
	} else {
		if err := r.SetTrustedProxies(nil); err != nil {
			return nil, err
		}
		logger.Warn("TRUSTED_PROXIES is not set: forwarded addresses are ignored. That is safe, but behind a proxy all visitors look like the proxy and share the per-address limits (rate limits and the anonymous daily allowance). Set TRUSTED_PROXIES to the proxy's addresses when deployed")
	}

	// Two-step sign-in keeps its secrets encrypted with a key that is not in the database: without it, it is not offered.
	if os.Getenv(auth.EncryptionKeyEnv) == "" {
		logger.Info("TOTP_ENCRYPTION_KEY is not set: two-step sign-in is not offered. Make a key with `openssl rand -base64 32` to turn it on")
	} else if !auth.TwoFactorAvailable() {
		logger.Warn("TOTP_ENCRYPTION_KEY is set but is not 32 random bytes written in base64: two-step sign-in is not offered (`openssl rand -base64 32` makes one)")
	}

	origins := middleware.AllowedOrigins()
	config := cors.DefaultConfig()
	config.AllowOrigins = origins
	config.AllowCredentials = true                                           // the session cookie; only sent to the explicit origins above
	config.AllowOriginWithContextFunc = middleware.ExtensionMayCallKeyRoutes // browser extensions, for the routes that take a key
	config.AllowMethods = []string{"GET", "POST", "PUT", "DELETE"}
	config.AllowHeaders = []string{"Origin", "Content-Type", "Authorization", middleware.TurnstileHeader}
	config.ExposeHeaders = []string{controllers.NextCursorHeader, middleware.RequestIDHeader, "X-Quota-Limit", "X-Quota-Remaining", "Retry-After"}
	r.Use(cors.New(config))
	r.Use(middleware.OriginCheck(origins)) // CSRF: cookie auth must only act for our own frontends

	// Per-IP limits protect the unauthenticated endpoints; signed-in users are limited per user, and
	// by their daily quota (summaries and chat are the expensive LLM calls).
	summarizeIPLimit := middleware.RateLimit(middleware.NewRateLimiter(rates.SummarizeIPPerMinute, rates.SummarizeIPBurst))
	authLimit := middleware.RateLimit(middleware.NewRateLimiter(rates.AuthPerMinute, rates.AuthBurst))
	summarizeUserLimit := middleware.RateLimitUser(middleware.NewRateLimiter(rates.SummarizeUserPerMinute, rates.SummarizeUserBurst))
	chatUserLimit := middleware.RateLimitUser(middleware.NewRateLimiter(rates.ChatPerMinute, rates.ChatBurst))
	// Checking a summary against its document costs no model call, but it is real work: its own bucket.
	proofUserLimit := middleware.RateLimitUser(middleware.NewRateLimiter(rates.ChatPerMinute, rates.ChatBurst))
	anonymousDaily := middleware.AnonymousDaily()
	dailyBudget := middleware.DailyBudget()
	exportLimit := middleware.RateLimitUser(middleware.NewRateLimiter(rates.ExportPerMinute, rates.ExportBurst))
	// Mailing a summary to yourself sends a real email, so it gets the same small allowance as an export.
	emailLimit := middleware.RateLimitUser(middleware.NewRateLimiter(rates.ExportPerMinute, rates.ExportBurst))
	turnstile := middleware.Turnstile()

	fileBody := middleware.MaxBody(controllers.MaxPDFBytes + 1<<20)
	multiBody := middleware.MaxBody(controllers.MaxMultiBytes + 1<<20)
	// Signed-in people may also upload recordings, which are bigger than documents.
	uploadBody := middleware.MaxBody(controllers.MaxUploadBytes() + 1<<20)
	combinedBody := middleware.MaxBody(controllers.MaxCombinedBytes() + 1<<20)
	textBody := middleware.MaxBody(controllers.MaxTextBytes)
	chatBody := middleware.MaxBody(controllers.MaxTextBytes)
	smallBody := middleware.MaxBody(16 << 10) // auth and account requests are tiny JSON

	r.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"message": "Hello from Go API Gateway"})
	})
	r.GET("/healthz", controllers.Healthz)
	r.GET("/readyz", controllers.Readyz(controllers.DatabaseCheck(), controllers.AIServiceCheck()))
	r.GET("/options", controllers.Options)

	// Prometheus metrics, only when a token is configured, and only for callers presenting it.
	if token := os.Getenv("METRICS_TOKEN"); token != "" {
		r.GET("/metrics", metrics.Handler(token))
	}

	// Public: account access.
	r.POST("/signup", authLimit, smallBody, turnstile, controllers.Signup)
	r.POST("/login", authLimit, smallBody, controllers.Login)
	r.POST("/auth/google", authLimit, smallBody, controllers.GoogleLogin)
	r.POST("/auth/two-factor", authLimit, smallBody, controllers.TwoFactorVerify) // the second step of signing in
	r.POST("/auth/logout", authLimit, controllers.Logout)
	r.POST("/auth/forgot-password", authLimit, smallBody, turnstile, controllers.ForgotPassword)
	r.POST("/auth/reset-password", authLimit, smallBody, controllers.ResetPassword)
	r.POST("/auth/verify-email", authLimit, smallBody, controllers.VerifyEmail)

	// The API for programs: the summarizing routes, with an API key instead of a session. Nothing is saved to the
	// owner's library. It is for servers: a browser from another site is turned away by the origin check, and a
	// key must never be put in a web page. The owner's daily quota, the rate limits and the spending guard apply.
	// The order matters: the owner's allowance is claimed first, then the key's own count and limit (which gives the
	// allowance back when the key is out), then the site's budget (which gives both back when it is out).
	v1 := r.Group("/v1", middleware.RequireAPIKey, middleware.RequireVerifiedEmail)
	{
		keyDaily := middleware.APIKeyDaily()
		summaries := middleware.Quota(middleware.QuotaSummaries)
		compareBody := middleware.MaxBody(controllers.CompareBodyBytes)
		extractBody := middleware.MaxBody(controllers.ExtractBodyBytes)
		v1.POST("/summarize", summarizeUserLimit, uploadBody, summaries, keyDaily, dailyBudget, controllers.APISummarize)
		v1.POST("/summarize-multiple", summarizeUserLimit, combinedBody, summaries, keyDaily, dailyBudget, controllers.APISummarizeMultiple)
		v1.POST("/summarize-text", summarizeUserLimit, textBody, summaries, keyDaily, dailyBudget, controllers.APISummarizeText)
		v1.POST("/summarize-url", summarizeUserLimit, smallBody, summaries, keyDaily, dailyBudget, controllers.APISummarizeURL)
		v1.POST("/compare", summarizeUserLimit, compareBody, summaries, keyDaily, dailyBudget, controllers.APICompare)
		v1.POST("/extract", summarizeUserLimit, extractBody, summaries, keyDaily, dailyBudget, controllers.APIExtract)
		v1.GET("/usage", controllers.APIUsage)
	}

	// Public: a summary its owner chose to share. Anyone with the link can read it.
	r.GET("/shared/:token", authLimit, controllers.SharedDocument)

	// Public: anonymous summaries (nothing is saved).
	// After the rate limit and the human check, so refused requests cost nothing: the visitor's daily allowance, then the
	// site's daily budget (the spending guard).
	r.POST("/public/summarize", summarizeIPLimit, fileBody, turnstile, anonymousDaily, dailyBudget, controllers.PublicSummarize)
	r.POST("/public/summarize-multiple", summarizeIPLimit, multiBody, turnstile, anonymousDaily, dailyBudget, controllers.PublicSummarizeMultiple)
	r.POST("/public/summarize-text", summarizeIPLimit, textBody, turnstile, anonymousDaily, dailyBudget, controllers.PublicSummarizeText)
	r.POST("/public/summarize-url", summarizeIPLimit, smallBody, turnstile, anonymousDaily, dailyBudget, controllers.PublicSummarizeURL)

	authorized := r.Group("/")
	authorized.Use(middleware.RequireAuth)
	{
		// The account.
		authorized.GET("/auth/me", controllers.Me)
		authorized.POST("/auth/logout-all", controllers.LogoutAll)
		authorized.GET("/auth/sessions", controllers.ListSessions)
		authorized.DELETE("/auth/sessions/:id", controllers.RevokeSession)
		authorized.POST("/auth/change-password", authLimit, smallBody, controllers.ChangePassword)
		authorized.POST("/auth/resend-verification", authLimit, controllers.ResendVerification)
		authorized.GET("/account/two-factor", controllers.TwoFactorStatus)
		authorized.POST("/account/two-factor/setup", authLimit, smallBody, controllers.TwoFactorSetup)
		authorized.POST("/account/two-factor/enable", authLimit, smallBody, controllers.TwoFactorEnable)
		authorized.POST("/account/two-factor/disable", authLimit, smallBody, controllers.TwoFactorDisable)
		authorized.POST("/account/two-factor/recovery-codes", authLimit, smallBody, controllers.TwoFactorRecoveryCodes)
		authorized.GET("/usage", controllers.Usage)
		// API keys for programs (see /v1). Made and ended by a signed-in person; a key cannot make or end keys.
		authorized.GET("/account/api-keys", controllers.ListAPIKeys)
		authorized.POST("/account/api-keys", authLimit, smallBody, middleware.RequireVerifiedEmail, controllers.CreateAPIKey)
		authorized.DELETE("/account/api-keys/:id", authLimit, controllers.RevokeAPIKey)
		authorized.GET("/account/export", exportLimit, controllers.ExportAccount)
		authorized.DELETE("/account", authLimit, smallBody, controllers.DeleteAccount)
		authorized.PUT("/account/instructions", smallBody, controllers.SetInstructions)

		// Saved documents.
		authorized.GET("/documents", controllers.ListDocuments)
		authorized.GET("/documents/tags", controllers.ListTags)
		authorized.PUT("/documents/:id", smallBody, controllers.UpdateDocument)
		authorized.DELETE("/documents/:id", controllers.DeleteDocument)
		authorized.POST("/documents/:id/share", smallBody, controllers.ShareDocument)
		authorized.DELETE("/documents/:id/share", controllers.UnshareDocument)
		authorized.GET("/documents/:id/files/:fileId", controllers.DocumentFile)
		authorized.GET("/documents/:id/text", controllers.DocumentText)
		authorized.POST("/documents/:id/proof", proofUserLimit, controllers.CheckDocumentSummary)

		// Work that costs an LLM call: signed in (and verified, when required), rate limited, then
		// charged against the daily quota and then the site's daily budget, last, so rejected requests don't use them up.
		verified := authorized.Group("/", middleware.RequireVerifiedEmail)
		verified.POST("/summarize", summarizeUserLimit, uploadBody, middleware.Quota(middleware.QuotaSummaries), dailyBudget, controllers.CreateSummary)
		verified.POST("/summarize-multiple", summarizeUserLimit, combinedBody, middleware.Quota(middleware.QuotaSummaries), dailyBudget, controllers.CreateSummaryMultiple)
		verified.POST("/summarize-text", summarizeUserLimit, textBody, middleware.Quota(middleware.QuotaSummaries), dailyBudget, controllers.CreateSummaryText)
		verified.POST("/summarize-url", summarizeUserLimit, smallBody, middleware.Quota(middleware.QuotaSummaries), dailyBudget, controllers.CreateSummaryURL)
		verified.POST("/documents/compare", summarizeUserLimit, smallBody, middleware.Quota(middleware.QuotaSummaries), dailyBudget, controllers.CompareDocuments)
		verified.POST("/documents/:id/extract", summarizeUserLimit, smallBody, middleware.Quota(middleware.QuotaSummaries), dailyBudget, controllers.ExtractFromDocument)
		verified.POST("/library/overview", summarizeUserLimit, smallBody, middleware.Quota(middleware.QuotaSummaries), dailyBudget, controllers.CollectionOverview)
		verified.POST("/documents/:id/chat", chatUserLimit, chatBody, middleware.Quota(middleware.QuotaChats), dailyBudget, controllers.ChatWithDocument)
		verified.POST("/documents/:id/podcast", chatUserLimit, smallBody, controllers.ReplayStoredPodcast, middleware.Quota(middleware.QuotaChats), dailyBudget, controllers.PodcastDocument)
		verified.POST("/documents/:id/rewrite", summarizeUserLimit, smallBody, middleware.Quota(middleware.QuotaSummaries), dailyBudget, controllers.RewriteDocument)
		verified.POST("/documents/:id/suggestions", chatUserLimit, dailyBudget, controllers.SuggestQuestions)
		verified.POST("/documents/:id/study", chatUserLimit, smallBody, controllers.ReplayStoredStudy, middleware.Quota(middleware.QuotaChats), dailyBudget, controllers.StudyDocument)
		verified.POST("/documents/:id/email", emailLimit, controllers.EmailDocument)
		verified.POST("/library/ask", chatUserLimit, chatBody, middleware.Quota(middleware.QuotaChats), dailyBudget, controllers.AskLibrary)
	}

	return r, nil
}
