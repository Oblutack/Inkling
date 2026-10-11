package models

import "time"

// RecoveryCode is a single-use way in when the authenticator app is lost. Only its hash is stored.
type RecoveryCode struct {
	ID        uint `gorm:"primaryKey"`
	UserID    uint
	CodeHash  string
	CreatedAt time.Time
	UsedAt    *time.Time
}

// MFAChallenge is the pending second step of a sign-in: a correct password has been given, the second factor has not.
// Only the hash of its token is stored.
type MFAChallenge struct {
	ID        uint `gorm:"primaryKey"`
	UserID    uint
	TokenHash string
	Attempts  int
	CreatedAt time.Time
	ExpiresAt time.Time
}

// TableName keeps GORM's naming in step with the migration (mfa_challenges).
func (MFAChallenge) TableName() string { return "mfa_challenges" }
