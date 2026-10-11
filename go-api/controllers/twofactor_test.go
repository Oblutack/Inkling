package controllers

import (
	"ai-summarizer/go-api/auth"
	"ai-summarizer/go-api/models"
	"encoding/base64"
	"errors"
	"testing"
	"time"
)

func TestACodeTwoRequestsBothSawAsNewOnlyCountsForOne(t *testing.T) {
	db := migrated(t)
	t.Setenv(auth.EncryptionKeyEnv, base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))

	secret, _ := auth.NewTOTPSecret()
	sealed, err := auth.SealSecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	enabled := time.Now()
	user := models.User{Email: "race@example.com", Password: "x", TotpSecret: sealed, TotpEnabledAt: &enabled}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	code, _ := auth.TOTPCode(secret, auth.TOTPStep(time.Now()))

	// two requests that each read the account before either has recorded the code: both see it as a code not used yet
	var first, second models.User
	db.First(&first, user.ID)
	db.First(&second, user.ID)
	if _, err := checkSecondFactor(&first, code, ""); err != nil {
		t.Fatalf("the first use: %v", err)
	}
	if _, err := checkSecondFactor(&second, code, ""); !errors.Is(err, errSecondFactor) {
		t.Errorf("the second use of the same code (from a copy of the account that had not seen the first): %v", err)
	}
}

func TestARecoveryCodeTwoRequestsBothSawAsNewOnlyCountsForOne(t *testing.T) {
	db := migrated(t)
	user := models.User{Email: "race2@example.com", Password: "x"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	db.Create(&models.RecoveryCode{UserID: user.ID, CodeHash: auth.HashRecoveryCode("k3m9x-h2q7a")})
	if used, err := checkSecondFactor(&user, "", "k3m9x-h2q7a"); err != nil || !used {
		t.Fatalf("the first use: %v %v", used, err)
	}
	if _, err := checkSecondFactor(&user, "", "k3m9x-h2q7a"); !errors.Is(err, errSecondFactor) {
		t.Errorf("the second use: %v", err)
	}
}
