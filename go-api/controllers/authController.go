package controllers

import (
	"ai-summarizer/go-api/auth"
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/mailer"
	"ai-summarizer/go-api/metrics"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/models"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"google.golang.org/api/oauth2/v2"
	"google.golang.org/api/option"
	"gorm.io/gorm"
)

// Mail is how verification and reset emails are sent. main replaces it with the configured
// provider; the default just logs, so nothing is ever sent by accident.
var Mail mailer.Mailer = mailer.LogMailer{}

// FrontendURL is where emailed links point (the Next.js app).
func FrontendURL() string {
	if u := os.Getenv("FRONTEND_URL"); u != "" {
		return u
	}
	return "http://localhost:3000"
}

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// userView is the only shape in which a user is returned to clients.
func userView(u models.User) gin.H {
	return gin.H{
		"id": u.ID, "email": u.Email, "emailVerified": u.EmailVerified(), "hasPassword": u.HasPassword,
		"customInstructions": u.CustomInstructions,
		// whether signing in needs a code from an authenticator app too, and whether this server can offer that at all
		"twoFactorEnabled": u.TwoFactorEnabled(), "twoFactorAvailable": auth.TwoFactorAvailable(),
	}
}

// Per-account throttles, on top of the per-IP limits on the routes. Keyed by email, they stop a
// distributed guessing attack against one account, and cap how many emails one address can be sent.
var (
	loginAttempts   = middleware.NewRateLimiter(2, 8) // a burst of 8, then 2 a minute
	resetRequests   = middleware.NewRateLimiter(1, 3) // a burst of 3, then 1 a minute
	verifyResends   = 60 * time.Second
	genericResetMsg = "If an account exists for that email, we've sent a link to reset the password."
)

// A bcrypt hash of a random string, compared against when the account doesn't exist so that
// "no such user" takes as long as "wrong password" and can't be told apart by timing.
// It is made at the current cost, on first use.
var (
	dummyHashOnce  sync.Once
	dummyHashValue []byte
)

func dummyHash() []byte {
	dummyHashOnce.Do(func() { dummyHashValue, _ = auth.HashPassword(randomString()) })
	return dummyHashValue
}

func randomString() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func securityEvent(c *gin.Context, event string, userID uint) {
	metrics.AccountEvent(event)
	slog.Info("security event", "event", event, "user_id", userID, "request_id", middleware.RequestIDFrom(c))
}

// startSession creates a session and sets the cookie.
func startSession(c *gin.Context, userID uint) error {
	token, session, err := auth.CreateSession(userID, c.GetHeader("User-Agent"))
	if err != nil {
		return err
	}
	auth.SetSessionCookie(c, token, session.ExpiresAt)
	return nil
}

func bindJSON(c *gin.Context, dst any) bool {
	if err := c.ShouldBindJSON(dst); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to read body"})
		return false
	}
	return true
}

func sendVerification(user models.User) {
	token, err := auth.IssueEmailToken(user.ID, models.TokenVerifyEmail, auth.VerifyEmailTTL)
	if err != nil {
		slog.Error("issuing verification token failed", "user_id", user.ID, "error", err)
		return
	}
	mailer.SendAsync(Mail, mailer.VerifyEmail(user.Email, FrontendURL(), token))
}

// ---- signup / login / logout ---------------------------------------------------------------

func Signup(c *gin.Context) {
	var body credentials
	if !bindJSON(c, &body) {
		return
	}

	email, err := normalizeEmail(body.Email)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validatePassword(body.Password, email); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// The password is hashed first, whether or not the email is taken, so the two cases take the same time.
	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to hash password"})
		return
	}

	// The reply must not tell anyone whether an address has an account: it is the same either way, and the news goes
	// to the address itself. (Otherwise signup is a way to check lists of emails for who uses Inkling.)
	var existing models.User
	if err := initializers.DB.Select("id", "email").First(&existing, "lower(email) = ?", email).Error; err == nil {
		if accountNotices.allow(email) {
			mailer.SendAsync(Mail, mailer.AccountExists(existing.Email, FrontendURL()))
		}
		securityEvent(c, "signup_existing", existing.ID)
		c.JSON(http.StatusOK, gin.H{"message": signupMessage})
		return
	}

	user := models.User{Email: email, Password: string(hash), HasPassword: true}
	if err := initializers.DB.Create(&user).Error; err != nil {
		// Two signups for the same address at once: the database lets one in. The other looks like the case above.
		if initializers.DB.Model(&models.User{}).Where("lower(email) = ?", email).Select("id").Limit(1).Find(&existing).RowsAffected > 0 {
			c.JSON(http.StatusOK, gin.H{"message": signupMessage})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create user"})
		return
	}

	sendVerification(user)
	securityEvent(c, "signup", user.ID)
	c.JSON(http.StatusOK, gin.H{"message": signupMessage})
}

// signupMessage is what signup says, for a new address and for one that already has an account.
const signupMessage = "Account created. Check your email for a confirmation link."

// accountNotices makes sure signing up with an existing address cannot be used to flood its owner with email: one
// notice an hour per address.
var accountNotices = &noticeLimiter{every: time.Hour, last: map[string]time.Time{}}

type noticeLimiter struct {
	mu    sync.Mutex
	every time.Duration
	last  map[string]time.Time
}

func (n *noticeLimiter) allow(key string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	now := time.Now()
	if len(n.last) > 10_000 { // forget the old ones
		for k, t := range n.last {
			if now.Sub(t) > n.every {
				delete(n.last, k)
			}
		}
	}
	if t, ok := n.last[key]; ok && now.Sub(t) < n.every {
		return false
	}
	n.last[key] = now
	return true
}

func Login(c *gin.Context) {
	var body credentials
	if !bindJSON(c, &body) {
		return
	}
	email := normalizeLoose(body.Email)

	if !loginAttempts.Allow(email) {
		c.Header("Retry-After", "60")
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many login attempts for this account. Please wait a minute and try again."})
		return
	}

	var user models.User
	err := initializers.DB.First(&user, "lower(email) = ?", email).Error
	hash := dummyHash()
	if err == nil {
		hash = []byte(user.Password)
	}
	passwordOK := bcrypt.CompareHashAndPassword(hash, []byte(body.Password)) == nil
	if err != nil || !passwordOK {
		metrics.AccountEvent("login_failed")
		slog.Info("security event", "event", "login_failed", "request_id", middleware.RequestIDFrom(c))
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid email or password"})
		return
	}

	// A hash made with less work than is used now is remade, now that the password is known to be right.
	if auth.NeedsRehash(user.Password) {
		if err := setPassword(&user, body.Password); err != nil {
			slog.Error("upgrading a password hash failed", "user_id", user.ID, "error", err)
		}
	}

	startSessionOrChallenge(c, user, "login")
}

// Logout ends the current session. It is idempotent and works without a valid session, so a
// browser holding a stale cookie can always clear it.
func Logout(c *gin.Context) {
	if token := auth.TokenFromRequest(c); token != "" {
		if _, user, err := auth.LookupSession(token); err == nil {
			securityEvent(c, "logout", user.ID)
		}
		auth.RevokeByToken(token)
	}
	auth.ClearSessionCookie(c)
	c.JSON(http.StatusOK, gin.H{})
}

// LogoutAll ends every session of the user, on every device.
func LogoutAll(c *gin.Context) {
	user := middleware.CurrentUser(c)
	if err := auth.RevokeAllSessions(user.ID, 0); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to sign out"})
		return
	}
	auth.ClearSessionCookie(c)
	securityEvent(c, "logout_all", user.ID)
	c.JSON(http.StatusOK, gin.H{})
}

// Me returns the signed-in user. The frontend calls it on load to learn whether the cookie is
// still a valid session.
func Me(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"user": userView(middleware.CurrentUser(c))})
}

// ---- Google ---------------------------------------------------------------------------------

func GoogleLogin(c *gin.Context) {
	var body struct {
		Token string `json:"token"`
	}
	if !bindJSON(c, &body) || body.Token == "" {
		if body.Token == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to read body"})
		}
		return
	}

	oauth2Service, err := oauth2.NewService(context.Background(), option.WithoutAuthentication())
	if err != nil {
		slog.Error("google login: init service", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to init Google service"})
		return
	}

	tokenInfo, err := oauth2Service.Tokeninfo().IdToken(body.Token).Do()
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid Google token"})
		return
	}
	if tokenInfo.Audience != os.Getenv("GOOGLE_CLIENT_ID") {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Token is not for this app"})
		return
	}
	if !tokenInfo.VerifiedEmail {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Google account email is not verified"})
		return
	}

	email, err := normalizeEmail(tokenInfo.Email)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	user, err := FindOrCreateGoogleUser(email)
	if err != nil {
		slog.Error("google login: find or create user", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to sign in"})
		return
	}

	startSessionOrChallenge(c, *user, "login_google")
}

// FindOrCreateGoogleUser returns the account for a Google-verified email. A new account has no
// password the user knows; an existing unverified one is marked verified, since Google has just
// confirmed the address.
func FindOrCreateGoogleUser(email string) (*models.User, error) {
	email = normalizeLoose(email) // never create a second account that differs only in case
	var user models.User
	err := initializers.DB.First(&user, "lower(email) = ?", email).Error
	now := time.Now()

	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		hash, herr := auth.HashPassword(randomString())
		if herr != nil {
			return nil, herr
		}
		user = models.User{Email: email, Password: string(hash), HasPassword: false, EmailVerifiedAt: &now}
		return &user, initializers.DB.Create(&user).Error
	case err != nil:
		return nil, err
	}

	if !user.EmailVerified() {
		user.EmailVerifiedAt = &now
		if err := initializers.DB.Model(&user).Update("email_verified_at", now).Error; err != nil {
			return nil, err
		}
	}
	return &user, nil
}

// ---- email verification ---------------------------------------------------------------------

// VerifyEmail redeems an emailed token. It is a POST, not a GET, so link scanners and prefetchers
// that fetch every URL in an email can't use the token up before the user clicks it.
func VerifyEmail(c *gin.Context) {
	var body struct {
		Token string `json:"token"`
	}
	if !bindJSON(c, &body) {
		return
	}

	userID, err := auth.ConsumeEmailToken(body.Token, models.TokenVerifyEmail)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "This confirmation link is invalid or has expired."})
		return
	}
	if err := initializers.DB.Model(&models.User{}).Where("id = ? AND email_verified_at IS NULL", userID).
		Update("email_verified_at", time.Now()).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to confirm your email"})
		return
	}
	securityEvent(c, "email_verified", userID)
	c.JSON(http.StatusOK, gin.H{"message": "Your email is confirmed."})
}

// ResendVerification sends a fresh confirmation link to the signed-in user.
func ResendVerification(c *gin.Context) {
	user := middleware.CurrentUser(c)
	if user.EmailVerified() {
		c.JSON(http.StatusOK, gin.H{"message": "Your email is already confirmed."})
		return
	}

	var recent int64
	initializers.DB.Model(&models.EmailToken{}).
		Where("user_id = ? AND purpose = ? AND created_at > ?", user.ID, models.TokenVerifyEmail, time.Now().Add(-verifyResends)).
		Count(&recent)
	if recent > 0 {
		c.Header("Retry-After", strconv.Itoa(int(verifyResends.Seconds())))
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "A confirmation email was just sent. Please wait a minute before asking for another."})
		return
	}

	sendVerification(user)
	c.JSON(http.StatusOK, gin.H{"message": "Confirmation email sent."})
}

// ---- password reset / change ----------------------------------------------------------------

// ForgotPassword always answers the same way, whether or not the account exists, so it can't be
// used to find out who has an account. The email is sent in the background for the same reason:
// the response time must not depend on the answer.
func ForgotPassword(c *gin.Context) {
	var body struct {
		Email string `json:"email"`
	}
	if !bindJSON(c, &body) {
		return
	}
	email := normalizeLoose(body.Email)

	if email != "" && resetRequests.Allow(email) {
		var user models.User
		if err := initializers.DB.First(&user, "lower(email) = ?", email).Error; err == nil {
			if token, err := auth.IssueEmailToken(user.ID, models.TokenResetPassword, auth.ResetPasswordTTL); err != nil {
				slog.Error("issuing reset token failed", "user_id", user.ID, "error", err)
			} else {
				mailer.SendAsync(Mail, mailer.ResetPassword(user.Email, FrontendURL(), token))
				securityEvent(c, "password_reset_requested", user.ID)
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"message": genericResetMsg})
}

// ResetPassword sets a new password from an emailed token. It signs the account out everywhere:
// whoever might have had access before (that is often why people reset) loses it.
func ResetPassword(c *gin.Context) {
	var body struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !bindJSON(c, &body) {
		return
	}

	// Check the password before spending the token, so a typo doesn't burn the link.
	if err := validatePasswordShape(body.Password); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	userID, err := auth.ConsumeEmailToken(body.Token, models.TokenResetPassword)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "This reset link is invalid or has expired. Please request a new one."})
		return
	}

	var user models.User
	if err := initializers.DB.First(&user, userID).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "This reset link is invalid or has expired. Please request a new one."})
		return
	}
	if err := validatePassword(body.Password, user.Email); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := setPassword(&user, body.Password); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to set the new password"})
		return
	}
	// Clicking the emailed link also proves they own the address.
	if !user.EmailVerified() {
		initializers.DB.Model(&user).Update("email_verified_at", time.Now())
	}
	if err := auth.RevokeAllSessions(user.ID, 0); err != nil {
		slog.Error("revoking sessions after reset failed", "user_id", user.ID, "error", err)
	}
	mailer.SendAsync(Mail, mailer.PasswordChanged(user.Email))
	securityEvent(c, "password_reset", user.ID)
	c.JSON(http.StatusOK, gin.H{"message": "Your password has been changed. Please log in."})
}

func setPassword(user *models.User, password string) error {
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	return initializers.DB.Model(user).Updates(map[string]any{"password": string(hash), "has_password": true}).Error
}

// ChangePassword changes the password of a signed-in user who knows the current one, and signs out
// every other device.
func ChangePassword(c *gin.Context) {
	user := middleware.CurrentUser(c)
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if !bindJSON(c, &body) {
		return
	}

	if !user.HasPassword {
		c.JSON(http.StatusBadRequest, gin.H{"error": "This account signs in with Google and has no password yet. Use \"Forgot password\" to set one."})
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(body.CurrentPassword)) != nil {
		// 403, not 401: the user is signed in; they just failed this extra check. (A 401 tells
		// clients their session is gone.)
		c.JSON(http.StatusForbidden, gin.H{"error": "Your current password is incorrect.", "code": "wrong_password"})
		return
	}
	if err := validatePassword(body.NewPassword, user.Email); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.NewPassword == body.CurrentPassword {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Choose a password different from the current one."})
		return
	}

	if err := setPassword(&user, body.NewPassword); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to change the password"})
		return
	}
	if err := auth.RevokeAllSessions(user.ID, middleware.CurrentSessionID(c)); err != nil {
		slog.Error("revoking other sessions failed", "user_id", user.ID, "error", err)
	}
	mailer.SendAsync(Mail, mailer.PasswordChanged(user.Email))
	securityEvent(c, "password_changed", user.ID)
	c.JSON(http.StatusOK, gin.H{"message": "Password changed. Your other devices were signed out."})
}

// ---- sessions -------------------------------------------------------------------------------

// ListSessions shows the devices signed in to the account.
func ListSessions(c *gin.Context) {
	user := middleware.CurrentUser(c)
	current := middleware.CurrentSessionID(c)

	sessions, err := auth.ActiveSessions(user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load sessions"})
		return
	}
	out := make([]gin.H, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, gin.H{
			"id": s.ID, "current": s.ID == current, "userAgent": s.UserAgent,
			"createdAt": s.CreatedAt, "lastUsedAt": s.LastUsedAt,
		})
	}
	c.JSON(http.StatusOK, out)
}

// RevokeSession signs one device out.
func RevokeSession(c *gin.Context) {
	user := middleware.CurrentUser(c)
	id, err := strconv.ParseUint(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid session id"})
		return
	}
	revoked, err := auth.RevokeSession(user.ID, uint(id))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to sign that device out"})
		return
	}
	if !revoked {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}
	if uint(id) == middleware.CurrentSessionID(c) {
		auth.ClearSessionCookie(c)
	}
	c.JSON(http.StatusOK, gin.H{})
}
