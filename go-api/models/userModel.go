package models

import (
	"time"

	"gorm.io/gorm"
)

type User struct {
	gorm.Model
	Email    string `gorm:"unique"`
	Password string

	// EmailVerifiedAt is nil until the user proves they own the address (or signs in with Google,
	// which has already verified it).
	EmailVerifiedAt *time.Time
	// HasPassword is false for accounts created through Google sign-in, which never chose one.
	// No gorm default tag on purpose: GORM would turn a deliberate false into the default.
	HasPassword bool
	// CustomInstructions are standing preferences added to every summary prompt.
	CustomInstructions string

	// TotpSecret is the authenticator app's shared secret, encrypted (see auth.SealSecret). It is set while two-step
	// sign-in is being set up; it only counts once TotpEnabledAt is set.
	TotpSecret    string
	TotpEnabledAt *time.Time
	TotpLastStep  int64 // the last 30-second step whose code was accepted: a code works once
}

func (u User) EmailVerified() bool { return u.EmailVerifiedAt != nil }

// TwoFactorEnabled is whether signing in needs a code from the authenticator app as well as the password.
func (u User) TwoFactorEnabled() bool { return u.TotpEnabledAt != nil && u.TotpSecret != "" }
