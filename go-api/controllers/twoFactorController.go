package controllers

import (
	"ai-summarizer/go-api/auth"
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/models"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// Two-step sign-in: after a correct password a code from an authenticator app is needed as well. See migration 000013.

const (
	// challengeLifetime is how long a person has to give the second factor after the password.
	challengeLifetime = 5 * time.Minute
	// challengeAttempts is how many wrong codes a challenge puts up with before it is thrown away (the password has to be
	// given again). Six digits are a million guesses; five tries a minute is a long way from that.
	challengeAttempts = 5
	// twoFactorIssuer is what the authenticator app shows beside the account.
	twoFactorIssuer = "Inkling"
)

// twoFactorAttempts limits how fast the settings (switching on and off, new recovery codes) can be tried, per account.
var twoFactorAttempts = middleware.NewRateLimiter(2, 12) // a burst of 12, then 2 a minute

var errSecondFactor = errors.New("second factor refused")

// startSessionOrChallenge is the end of every way of signing in (password, Google). Without two-step sign-in it starts the
// session. With it, it starts nothing and says that a code is needed, handing back the token of a short-lived challenge.
func startSessionOrChallenge(c *gin.Context, user models.User, event string) {
	if user.TwoFactorEnabled() {
		token, err := newChallenge(user.ID)
		if err != nil {
			slog.Error("creating a second-step challenge failed", "user_id", user.ID, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to start a session"})
			return
		}
		securityEvent(c, "second_step_required", user.ID)
		c.JSON(http.StatusOK, gin.H{"twoFactorRequired": true, "challenge": token})
		return
	}
	if err := startSession(c, user.ID); err != nil {
		slog.Error("creating session failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to start a session"})
		return
	}
	securityEvent(c, event, user.ID)
	c.JSON(http.StatusOK, gin.H{"user": userView(user)})
}

func newChallenge(userID uint) (string, error) {
	token, err := auth.NewToken()
	if err != nil {
		return "", err
	}
	now := time.Now()
	// one person has a handful of open challenges at most, and the old ones are tidied away as new ones are made
	_ = initializers.DB.Where("user_id = ? AND expires_at < ?", userID, now).Delete(&models.MFAChallenge{}).Error
	_ = initializers.DB.Exec(`DELETE FROM mfa_challenges WHERE user_id = ? AND id NOT IN
		(SELECT id FROM mfa_challenges WHERE user_id = ? ORDER BY id DESC LIMIT 4)`, userID, userID).Error
	err = initializers.DB.Create(&models.MFAChallenge{UserID: userID, TokenHash: auth.HashToken(token), ExpiresAt: now.Add(challengeLifetime)}).Error
	return token, err
}

// checkSecondFactor decides whether a typed code (an app code or a recovery code) is good for a user, and uses it up. It
// returns whether a recovery code was the one used.
func checkSecondFactor(user *models.User, code, recoveryCode string) (usedRecovery bool, err error) {
	if recoveryCode != "" {
		if !auth.LooksLikeRecoveryCode(recoveryCode) {
			return false, errSecondFactor
		}
		now := time.Now()
		result := initializers.DB.Model(&models.RecoveryCode{}).
			Where("user_id = ? AND code_hash = ? AND used_at IS NULL", user.ID, auth.HashRecoveryCode(recoveryCode)).
			Update("used_at", now)
		if result.Error != nil {
			return false, result.Error
		}
		if result.RowsAffected != 1 {
			return false, errSecondFactor
		}
		return true, nil
	}
	secret, err := auth.OpenSecret(user.TotpSecret)
	if err != nil {
		return false, err
	}
	step, ok := auth.VerifyTOTP(secret, code, time.Now(), user.TotpLastStep)
	if !ok {
		return false, errSecondFactor
	}
	// The step is recorded only if no one else recorded it first, so two requests carrying the same code cannot both pass.
	result := initializers.DB.Model(&models.User{}).Where("id = ? AND totp_last_step < ?", user.ID, step).Update("totp_last_step", step)
	if result.Error != nil {
		return false, result.Error
	}
	if result.RowsAffected != 1 {
		return false, errSecondFactor
	}
	user.TotpLastStep = step
	return false, nil
}

func recoveryCodesLeft(userID uint) int64 {
	var n int64
	initializers.DB.Model(&models.RecoveryCode{}).Where("user_id = ? AND used_at IS NULL", userID).Count(&n)
	return n
}

// TwoFactorVerify is the second step of signing in: the token of the challenge and a code.
func TwoFactorVerify(c *gin.Context) {
	var body struct {
		Challenge    string `json:"challenge"`
		Code         string `json:"code"`
		RecoveryCode string `json:"recoveryCode"`
	}
	if !bindJSON(c, &body) {
		return
	}
	invalid := func() {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "That code was not accepted.", "code": "invalid_code"})
	}
	expired := func() {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "That sign-in took too long or was tried too often. Please sign in again.", "code": "challenge_expired"})
	}
	if body.Challenge == "" || (body.Code == "" && body.RecoveryCode == "") {
		invalid()
		return
	}

	var challenge models.MFAChallenge
	if err := initializers.DB.First(&challenge, "token_hash = ?", auth.HashToken(body.Challenge)).Error; err != nil || time.Now().After(challenge.ExpiresAt) {
		expired()
		return
	}
	// The attempt is counted first, in one statement, so a flood of simultaneous guesses cannot all slip in under the limit.
	counted := initializers.DB.Model(&models.MFAChallenge{}).Where("id = ? AND attempts < ?", challenge.ID, challengeAttempts).
		UpdateColumn("attempts", gorm.Expr("attempts + 1"))
	if counted.Error != nil || counted.RowsAffected != 1 {
		initializers.DB.Delete(&models.MFAChallenge{}, challenge.ID)
		expired()
		return
	}

	var user models.User
	if err := initializers.DB.First(&user, challenge.UserID).Error; err != nil || !user.TwoFactorEnabled() {
		initializers.DB.Delete(&models.MFAChallenge{}, challenge.ID)
		expired()
		return
	}
	usedRecovery, err := checkSecondFactor(&user, body.Code, body.RecoveryCode)
	if err != nil {
		if !errors.Is(err, errSecondFactor) {
			slog.Error("checking a second factor failed", "user_id", user.ID, "error", err)
		}
		securityEvent(c, "second_step_failed", user.ID)
		invalid()
		return
	}
	// the challenge is used up, and cannot be used again whatever happens next
	initializers.DB.Delete(&models.MFAChallenge{}, challenge.ID)

	if err := startSession(c, user.ID); err != nil {
		slog.Error("creating session failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to start a session"})
		return
	}
	if usedRecovery {
		securityEvent(c, "login_recovery_code", user.ID)
	} else {
		securityEvent(c, "login_second_step", user.ID)
	}
	reply := gin.H{"user": userView(user)}
	if usedRecovery {
		reply["recoveryCodesLeft"] = recoveryCodesLeft(user.ID)
	}
	c.JSON(http.StatusOK, reply)
}

// ---- the account's settings --------------------------------------------------------------------------------

// confirmIdentity asks again for the password of an account that has one: the settings change how the account is guarded,
// so a session alone (a borrowed computer, a stolen cookie) is not enough.
func confirmIdentity(c *gin.Context, user models.User, password string) bool {
	if !twoFactorAttempts.Allow("2fa-settings:" + strings.ToLower(user.Email)) {
		c.Header("Retry-After", "60")
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many tries. Please wait a minute and try again."})
		return false
	}
	if user.HasPassword && bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(password)) != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Your password is incorrect.", "code": "wrong_password"})
		return false
	}
	return true
}

func twoFactorUnavailable(c *gin.Context) bool {
	if auth.TwoFactorAvailable() {
		return false
	}
	c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Two-step sign-in is not set up on this server.", "code": "two_factor_unavailable"})
	return true
}

// TwoFactorStatus tells the account page whether two-step sign-in is on and how many recovery codes are left.
func TwoFactorStatus(c *gin.Context) {
	user := middleware.CurrentUser(c)
	reply := gin.H{"available": auth.TwoFactorAvailable(), "enabled": user.TwoFactorEnabled()}
	if user.TwoFactorEnabled() {
		reply["recoveryCodesLeft"] = recoveryCodesLeft(user.ID)
	}
	c.JSON(http.StatusOK, reply)
}

// TwoFactorSetup starts setting up: a new secret, shown once as text and as a QR code, which counts only after
// TwoFactorEnable has seen a code from it.
func TwoFactorSetup(c *gin.Context) {
	user := middleware.CurrentUser(c)
	var body struct {
		Password string `json:"password"`
	}
	if !bindJSON(c, &body) || twoFactorUnavailable(c) {
		return
	}
	if !confirmIdentity(c, user, body.Password) {
		return
	}
	if user.TwoFactorEnabled() {
		c.JSON(http.StatusConflict, gin.H{"error": "Two-step sign-in is already on.", "code": "two_factor_enabled"})
		return
	}
	secret, err := auth.NewTOTPSecret()
	if err == nil {
		var sealed string
		if sealed, err = auth.SealSecret(secret); err == nil {
			err = initializers.DB.Model(&models.User{}).Where("id = ?", user.ID).
				Updates(map[string]any{"totp_secret": sealed, "totp_enabled_at": nil, "totp_last_step": 0}).Error
		}
	}
	if err != nil {
		slog.Error("starting two-step setup failed", "user_id", user.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to start setting up two-step sign-in."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"secret": secret, "otpauthUrl": auth.OtpauthURL(twoFactorIssuer, user.Email, secret)})
}

// TwoFactorEnable finishes setting up: a code from the app proves it has the secret, and the recovery codes are made.
func TwoFactorEnable(c *gin.Context) {
	user := middleware.CurrentUser(c)
	var body struct {
		Code string `json:"code"`
	}
	if !bindJSON(c, &body) || twoFactorUnavailable(c) {
		return
	}
	if !twoFactorAttempts.Allow("2fa-settings:" + strings.ToLower(user.Email)) {
		c.Header("Retry-After", "60")
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many tries. Please wait a minute and try again."})
		return
	}
	if user.TwoFactorEnabled() {
		c.JSON(http.StatusConflict, gin.H{"error": "Two-step sign-in is already on.", "code": "two_factor_enabled"})
		return
	}
	if user.TotpSecret == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "Start setting up first.", "code": "two_factor_not_started"})
		return
	}
	secret, err := auth.OpenSecret(user.TotpSecret)
	if err != nil {
		slog.Error("opening the pending secret failed", "user_id", user.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to switch on two-step sign-in."})
		return
	}
	step, ok := auth.VerifyTOTP(secret, body.Code, time.Now(), 0)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "That code was not accepted. Check the code your app shows now.", "code": "invalid_code"})
		return
	}
	codes, err := replaceRecoveryCodes(user.ID, func(tx *gorm.DB) error {
		now := time.Now()
		return tx.Model(&models.User{}).Where("id = ?", user.ID).
			Updates(map[string]any{"totp_enabled_at": now, "totp_last_step": step}).Error
	})
	if err != nil {
		slog.Error("switching on two-step sign-in failed", "user_id", user.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to switch on two-step sign-in."})
		return
	}
	securityEvent(c, "two_factor_enabled", user.ID)
	c.JSON(http.StatusOK, gin.H{"recoveryCodes": codes})
}

// replaceRecoveryCodes makes a new set of codes and throws the old ones away, together with `also` in one transaction.
func replaceRecoveryCodes(userID uint, also func(tx *gorm.DB) error) ([]string, error) {
	codes, err := auth.NewRecoveryCodes(auth.RecoveryCodeCount)
	if err != nil {
		return nil, err
	}
	err = initializers.DB.Transaction(func(tx *gorm.DB) error {
		if also != nil {
			if err := also(tx); err != nil {
				return err
			}
		}
		if err := tx.Where("user_id = ?", userID).Delete(&models.RecoveryCode{}).Error; err != nil {
			return err
		}
		for _, code := range codes {
			if err := tx.Create(&models.RecoveryCode{UserID: userID, CodeHash: auth.HashRecoveryCode(code)}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	return codes, err
}

// confirmSecondFactor is the check that guards the settings once two-step sign-in is on: the password, and a code (or a
// recovery code), so that someone with only a stolen session cannot weaken the account.
func confirmSecondFactor(c *gin.Context, user *models.User, password, code, recoveryCode string) bool {
	if !confirmIdentity(c, *user, password) {
		return false
	}
	if code == "" && recoveryCode == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Enter a code from your app (or a recovery code).", "code": "invalid_code"})
		return false
	}
	if _, err := checkSecondFactor(user, code, recoveryCode); err != nil {
		if !errors.Is(err, errSecondFactor) {
			slog.Error("checking a second factor failed", "user_id", user.ID, "error", err)
		}
		securityEvent(c, "second_step_failed", user.ID)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "That code was not accepted.", "code": "invalid_code"})
		return false
	}
	return true
}

// TwoFactorDisable switches two-step sign-in off again.
func TwoFactorDisable(c *gin.Context) {
	user := middleware.CurrentUser(c)
	var body struct {
		Password     string `json:"password"`
		Code         string `json:"code"`
		RecoveryCode string `json:"recoveryCode"`
	}
	if !bindJSON(c, &body) {
		return
	}
	if !user.TwoFactorEnabled() {
		c.JSON(http.StatusConflict, gin.H{"error": "Two-step sign-in is not on.", "code": "two_factor_disabled"})
		return
	}
	if !confirmSecondFactor(c, &user, body.Password, body.Code, body.RecoveryCode) {
		return
	}
	err := initializers.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&models.User{}).Where("id = ?", user.ID).
			Updates(map[string]any{"totp_secret": "", "totp_enabled_at": nil, "totp_last_step": 0}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", user.ID).Delete(&models.RecoveryCode{}).Error; err != nil {
			return err
		}
		return tx.Where("user_id = ?", user.ID).Delete(&models.MFAChallenge{}).Error
	})
	if err != nil {
		slog.Error("switching off two-step sign-in failed", "user_id", user.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to switch off two-step sign-in."})
		return
	}
	securityEvent(c, "two_factor_disabled", user.ID)
	c.JSON(http.StatusOK, gin.H{"message": "Two-step sign-in is off."})
}

// TwoFactorRecoveryCodes makes a new set of recovery codes (and ends the old ones).
func TwoFactorRecoveryCodes(c *gin.Context) {
	user := middleware.CurrentUser(c)
	var body struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if !bindJSON(c, &body) {
		return
	}
	if !user.TwoFactorEnabled() {
		c.JSON(http.StatusConflict, gin.H{"error": "Two-step sign-in is not on.", "code": "two_factor_disabled"})
		return
	}
	// only an app code here: a recovery code would be spent on making the next ones
	if !confirmSecondFactor(c, &user, body.Password, body.Code, "") {
		return
	}
	codes, err := replaceRecoveryCodes(user.ID, nil)
	if err != nil {
		slog.Error("making new recovery codes failed", "user_id", user.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to make new recovery codes."})
		return
	}
	securityEvent(c, "recovery_codes_renewed", user.ID)
	c.JSON(http.StatusOK, gin.H{"recoveryCodes": codes})
}
