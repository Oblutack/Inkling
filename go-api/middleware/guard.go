package middleware

import (
	"ai-summarizer/go-api/alerts"
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/metrics"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"log/slog"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"strconv"

	"github.com/gin-gonic/gin"
)

// The spending guard. The language model is paid for by use, so two limits sit in front of every route that starts
// AI work, on top of the per-minute rate limits and each person's daily quota:
//
//   - AnonymousDaily: how many summaries one visitor without an account can make in a day. Rate limits alone allow
//     thousands a day from one address.
//   - DailyBudget: how many pieces of AI work the whole site starts in a day. When it is used up, the work is paused
//     until midnight UTC. This is the backstop against many addresses or many accounts used together, or a bug.
//
// A limit of 0 means unlimited. Work that fails through no fault of the caller is given back (RefundQuota).
const (
	// DefaultAnonymousPerDay: enough to try Inkling properly, and a reason to sign in.
	DefaultAnonymousPerDay = 10
	// DefaultDailyBudget is generous for one person's use and still a hard ceiling: at about a twentieth of a cent a
	// summary it is a few dollars a day at most.
	DefaultDailyBudget = 5000
)

const (
	anonymousClaimKey = "anonymous_claim"
	budgetClaimKey    = "budget_claim"
	apiKeyClaimKey    = "api_key_claim"
)

func limitFromEnv(name string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v >= 0 {
		return v
	}
	return fallback
}

// AnonymousLimit is ANON_SUMMARIES_PER_DAY, 10 unless set.
func AnonymousLimit() int { return limitFromEnv("ANON_SUMMARIES_PER_DAY", DefaultAnonymousPerDay) }

// DailyBudgetLimit is AI_REQUESTS_PER_DAY, 5000 unless set.
func DailyBudgetLimit() int { return limitFromEnv("AI_REQUESTS_PER_DAY", DefaultDailyBudget) }

// guardClaim is what a request claimed, so it can be given back: the table, the visitor (empty for the site) and the
// UTC day it was counted on.
type guardClaim struct {
	table, key, day string
}

// The statements are fixed strings, so no input is ever put into them. Like the user quota, the conditional upsert is
// atomic: requests arriving together cannot all squeeze under the limit, and no row comes back once it is reached.
const (
	claimAnonymousSQL = `INSERT INTO anonymous_usage (ip_hash, day, summaries) VALUES (?, CURRENT_DATE, 1)
		ON CONFLICT (ip_hash, day) DO UPDATE SET summaries = anonymous_usage.summaries + 1
		WHERE anonymous_usage.summaries < ? RETURNING summaries, day::text`
	claimBudgetSQL = `INSERT INTO global_usage (day, requests) VALUES (CURRENT_DATE, 1)
		ON CONFLICT (day) DO UPDATE SET requests = global_usage.requests + 1
		WHERE global_usage.requests < ? RETURNING requests, day::text`
	claimAPIKeySQL = `INSERT INTO api_key_usage (key_id, day, requests) VALUES (?, CURRENT_DATE, 1)
		ON CONFLICT (key_id, day) DO UPDATE SET requests = api_key_usage.requests + 1
		WHERE api_key_usage.requests < ? RETURNING requests, day::text`
	refundAPIKeySQL    = `UPDATE api_key_usage SET requests = GREATEST(requests - 1, 0) WHERE key_id = ? AND day = ?::date`
	refundAnonymousSQL = `UPDATE anonymous_usage SET summaries = GREATEST(summaries - 1, 0) WHERE ip_hash = ? AND day = ?::date`
	refundBudgetSQL    = `UPDATE global_usage SET requests = GREATEST(requests - 1, 0) WHERE day = ?::date`
	// Old rows are of no use: visitors are counted per day.
	purgeAnonymousSQL = `DELETE FROM anonymous_usage WHERE day < CURRENT_DATE - 2`
)

// visitorKey identifies a visitor for the day's count without keeping their address: a keyed hash, so the stored value
// cannot be turned back into an address by trying them all. An IPv6 visitor is the whole /64 they are given, since a
// single home or phone connection holds billions of addresses.
func visitorKey(address string) string {
	id := address
	if ip := net.ParseIP(address); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			id = v4.String()
		} else {
			id = ip.Mask(net.CIDRMask(64, 128)).String()
		}
	}
	key := os.Getenv("IP_HASH_KEY")
	if key == "" {
		key = os.Getenv("AI_SERVICE_TOKEN")
	}
	mac := hmac.New(sha256.New, []byte("inkling-visitor:"+key))
	mac.Write([]byte(id))
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

// AnonymousDaily counts a summary against the visitor's allowance for the day and refuses it once that is used up.
// For the routes that work without an account.
func AnonymousDaily() gin.HandlerFunc {
	return func(c *gin.Context) {
		limit := AnonymousLimit()
		if limit == 0 {
			c.Next()
			return
		}
		visitor := visitorKey(c.ClientIP())
		used, day, ok := claim(c, claimAnonymousSQL, visitor, limit)
		if !ok {
			return
		}
		if used == -1 {
			metrics.QuotaRejected("anonymous")
			c.Header("Retry-After", strconv.Itoa(secondsUntilUTCMidnight()))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "You've used today's " + strconv.Itoa(limit) + " free summaries without an account. Sign in to keep going, or come back after midnight UTC.",
				"code":  "anonymous_limit",
			})
			return
		}
		c.Set(anonymousClaimKey, guardClaim{table: "anonymous_usage", key: visitor, day: day})
		if rand.IntN(50) == 0 {
			_ = initializers.DB.Exec(purgeAnonymousSQL).Error
		}
		c.Header("X-Anonymous-Remaining", strconv.Itoa(max(limit-used, 0)))
		c.Next()
	}
}

// DailyBudget counts a piece of AI work against the site's budget for the day and pauses it once that is used up.
func DailyBudget() gin.HandlerFunc {
	return func(c *gin.Context) {
		limit := DailyBudgetLimit()
		if limit == 0 {
			c.Next()
			return
		}
		used, day, ok := claim(c, claimBudgetSQL, nil, limit)
		if !ok {
			return
		}
		if used == -1 {
			metrics.QuotaRejected("budget")
			alerts.Default.BudgetUsedUp(limit)
			RefundQuota(c) // what this request claimed before reaching the budget (the person's allowance, a key's count)
			c.Header("Retry-After", strconv.Itoa(secondsUntilUTCMidnight()))
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
				"error": "Inkling has reached its limit for AI work today and will be back after midnight UTC. Thank you for your patience.",
				"code":  "daily_budget",
			})
			return
		}
		if used == limit {
			slog.Warn("daily AI budget used up: further AI work is paused until midnight UTC", "limit", limit)
			alerts.Default.BudgetUsedUp(limit)
		}
		c.Set(budgetClaimKey, guardClaim{table: "global_usage", day: day})
		c.Next()
	}
}

// APIKeyDaily counts a request against the API key making it, and refuses it once the key has used the daily limit it
// was given (a key without one is only counted). It runs after the owner's allowance has been claimed, and gives that
// back when it refuses, so a key that is out of requests costs its owner nothing.
func APIKeyDaily() gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := c.Get(APIKeyIDKey)
		if !ok {
			c.Next()
			return
		}
		keyID, _ := id.(uint)
		limit := math.MaxInt32
		if v, ok := c.Get(apiKeyLimitKey); ok {
			limit, _ = v.(int)
		}
		used, day, ok := claim(c, claimAPIKeySQL, keyID, limit)
		if !ok {
			return
		}
		if used == -1 {
			metrics.QuotaRejected("api_key")
			RefundQuota(c)
			c.Header("Retry-After", strconv.Itoa(secondsUntilUTCMidnight()))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "This API key has used its daily limit of " + strconv.Itoa(limit) + " requests. It resets at midnight UTC.",
				"code":  "api_key_limit",
			})
			return
		}
		c.Set(apiKeyClaimKey, guardClaim{table: "api_key_usage", key: strconv.FormatUint(uint64(keyID), 10), day: day})
		c.Next()
	}
}

// claim runs one of the conditional upserts. used is -1 when the limit had been reached; ok is false when the check
// itself failed (the request is then already answered).
func claim(c *gin.Context, query string, visitor any, limit int) (used int, day string, ok bool) {
	args := []any{limit}
	if visitor != nil {
		args = []any{visitor, limit}
	}
	row := initializers.DB.Raw(query, args...).Row()
	if err := row.Scan(&used, &day); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return -1, "", true
		}
		slog.Error("spending guard check failed", "request_id", RequestIDFrom(c), "error", err)
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "Could not check usage right now. Please try again."})
		return 0, "", false
	}
	return used, day, true
}

// refundGuards gives back what AnonymousDaily and DailyBudget claimed for this request, at most once.
func refundGuards(c *gin.Context) {
	for _, name := range []string{anonymousClaimKey, budgetClaimKey, apiKeyClaimKey} {
		v, _ := c.Get(name)
		g, ok := v.(guardClaim)
		if !ok {
			continue
		}
		c.Set(name, nil)
		var err error
		switch g.table {
		case "anonymous_usage":
			err = initializers.DB.Exec(refundAnonymousSQL, g.key, g.day).Error
		case "api_key_usage":
			err = initializers.DB.Exec(refundAPIKeySQL, g.key, g.day).Error
		default:
			err = initializers.DB.Exec(refundBudgetSQL, g.day).Error
		}
		if err != nil {
			slog.Error("spending guard refund failed", "request_id", RequestIDFrom(c), "error", err)
		}
	}
}
