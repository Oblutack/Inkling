package middleware

import (
	"database/sql"
	"errors"
	"log/slog"

	"ai-summarizer/go-api/alerts"
	"ai-summarizer/go-api/initializers"
)

// Work the server starts by itself (checking a page someone watches) is counted exactly like work a request starts: against
// the person's daily allowance of summaries and the site's daily budget of AI work. This is Quota and DailyBudget for a
// caller that is not a request.

// Why background work was not started.
const (
	// NoAllowance: the person has used today's summaries.
	NoAllowance = "allowance"
	// NoBudget: the site has used up its AI work for today.
	NoBudget = "budget"
)

// BackgroundClaim is what a piece of background AI work has used, so it can be given back if the work fails.
type BackgroundClaim struct {
	userID       uint
	summaryDay   string
	budgetDay    string
	claimedUser  bool
	claimedSite  bool
	alreadyGiven bool
}

// ClaimBackgroundWork counts one piece of AI work for a person. When it cannot (their allowance is used up, or the site's
// budget is), it returns the reason, and nothing stays counted. A limit of 0 means no limit, as for requests.
func ClaimBackgroundWork(userID uint) (*BackgroundClaim, string, error) {
	claim := &BackgroundClaim{userID: userID}

	if limit := QuotaLimit(QuotaSummaries); limit > 0 {
		var used int
		var day string
		err := initializers.DB.Raw(claimSummarySQL, userID, limit).Row().Scan(&used, &day)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, NoAllowance, nil
		}
		if err != nil {
			return nil, "", err
		}
		claim.summaryDay, claim.claimedUser = day, true
	}

	if limit := DailyBudgetLimit(); limit > 0 {
		var used int
		var day string
		err := initializers.DB.Raw(claimBudgetSQL, limit).Row().Scan(&used, &day)
		if errors.Is(err, sql.ErrNoRows) {
			claim.Release()
			alerts.Default.BudgetUsedUp(limit)
			return nil, NoBudget, nil
		}
		if err != nil {
			claim.Release()
			return nil, "", err
		}
		if used == limit {
			slog.Warn("daily AI budget used up: further AI work is paused until midnight UTC", "limit", limit)
			alerts.Default.BudgetUsedUp(limit)
		}
		claim.budgetDay, claim.claimedSite = day, true
	}
	return claim, "", nil
}

// Release gives back what was counted, once. Call it when the work failed through no fault of the person.
func (b *BackgroundClaim) Release() {
	if b == nil || b.alreadyGiven {
		return
	}
	b.alreadyGiven = true
	if b.claimedUser {
		if err := initializers.DB.Exec(refundSummarySQL, b.userID, b.summaryDay).Error; err != nil {
			slog.Error("giving back a background allowance failed", "user_id", b.userID, "error", err)
		}
	}
	if b.claimedSite {
		if err := initializers.DB.Exec(refundBudgetSQL, b.budgetDay).Error; err != nil {
			slog.Error("giving back the site budget failed", "error", err)
		}
	}
}
