package auth

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// The secret every example in RFC 4226 and RFC 6238 uses: the ASCII text "12345678901234567890".
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

func TestTheCodesAreTheOnesTheStandardsGive(t *testing.T) {
	// RFC 4226 appendix D: the first ten codes of that secret, by counter
	hotp := []string{"755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"}
	for counter, want := range hotp {
		got, err := TOTPCode(rfcSecret, int64(counter))
		if err != nil || got != want {
			t.Errorf("counter %d: %q, %v, want %q", counter, got, err, want)
		}
	}
	// RFC 6238 appendix B (SHA-1): the codes at these times, written with the last six digits of the standard's eight
	for unix, want := range map[int64]string{59: "287082", 1111111109: "081804", 1111111111: "050471", 1234567890: "005924", 2000000000: "279037"} {
		got, err := TOTPCode(rfcSecret, TOTPStep(time.Unix(unix, 0)))
		if err != nil || got != want {
			t.Errorf("time %d: %q, %v, want %q", unix, got, err, want)
		}
	}
}

func TestACodeIsGoodForItsStepAndOneEitherSide(t *testing.T) {
	now := time.Unix(1234567890, 0)
	step := TOTPStep(now)
	for offset, ok := range map[int64]bool{-2: false, -1: true, 0: true, 1: true, 2: false} {
		code, _ := TOTPCode(rfcSecret, step+offset)
		got, accepted := VerifyTOTP(rfcSecret, code, now, 0)
		if accepted != ok || (ok && got != step+offset) {
			t.Errorf("offset %d: accepted=%v step=%d, want accepted=%v", offset, accepted, got, ok)
		}
	}
}

func TestACodeWorksOnce(t *testing.T) {
	now := time.Unix(1234567890, 0)
	code, _ := TOTPCode(rfcSecret, TOTPStep(now))
	step, ok := VerifyTOTP(rfcSecret, code, now, 0)
	if !ok {
		t.Fatal("the first use is accepted")
	}
	if _, again := VerifyTOTP(rfcSecret, code, now, step); again {
		t.Error("the same code was accepted a second time")
	}
	// an older code than the last one used is refused too, even though it is inside the window
	older, _ := TOTPCode(rfcSecret, step-1)
	if _, ok := VerifyTOTP(rfcSecret, older, now, step); ok {
		t.Error("a code from before the last one used was accepted")
	}
	newer, _ := TOTPCode(rfcSecret, step+1)
	if _, ok := VerifyTOTP(rfcSecret, newer, now, step); !ok {
		t.Error("the next code is accepted")
	}
}

func TestOnlySixDigitsAreACode(t *testing.T) {
	for input, ok := range map[string]bool{
		"287082": true, " 287 082 ": true, "287-082": true, "287 082": true,
		"28708": false, "2870822": false, "28708a": false, "": false, "２８７０８２": false, "287 08": false,
	} {
		_, got := CleanCode(input)
		if got != ok {
			t.Errorf("%q: %v, want %v", input, got, ok)
		}
	}
	if _, ok := VerifyTOTP(rfcSecret, "abcdef", time.Now(), 0); ok {
		t.Error("letters are not a code")
	}
	if _, ok := VerifyTOTP("not base32 !!", "123456", time.Now(), 0); ok {
		t.Error("a broken secret accepts nothing")
	}
}

func TestANewSecretIsRandomAndTheRightSize(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		secret, err := NewTOTPSecret()
		if err != nil || len(secret) != 32 || strings.ToUpper(secret) != secret || strings.Contains(secret, "=") {
			t.Fatalf("secret %q, %v", secret, err)
		}
		if _, err := TOTPCode(secret, 1); err != nil {
			t.Fatalf("a new secret cannot make a code: %v", err)
		}
		seen[secret] = true
	}
	if len(seen) != 50 {
		t.Errorf("repeated secrets: %d different of 50", len(seen))
	}
}

func TestTheQRCodeHoldsWhatAnAppNeeds(t *testing.T) {
	got := OtpauthURL("Inkling", "me+x@example.com", rfcSecret)
	for _, want := range []string{"otpauth://totp/Inkling:me+x@example.com?", "secret=" + rfcSecret, "issuer=Inkling", "algorithm=SHA1", "digits=6", "period=30"} {
		if !strings.Contains(got, want) {
			t.Errorf("%q lacks %q", got, want)
		}
	}
	if strings.Contains(OtpauthURL("A B", "a b@example.com", rfcSecret), " ") {
		t.Error("spaces must be escaped")
	}
}

// ---- keeping the secret --------------------------------------------------------------------------------------

func setTestKey(t *testing.T) {
	t.Helper()
	t.Setenv(EncryptionKeyEnv, base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
}

func TestASecretIsKeptEncryptedAndReadBack(t *testing.T) {
	setTestKey(t)
	sealed, err := SealSecret(rfcSecret)
	if err != nil || strings.Contains(sealed, rfcSecret) || strings.Contains(sealed, "GEZDG") {
		t.Fatalf("sealed %q, %v", sealed, err)
	}
	if again, _ := SealSecret(rfcSecret); again == sealed {
		t.Error("the same secret sealed twice looks the same: the nonce is not random")
	}
	if got, err := OpenSecret(sealed); err != nil || got != rfcSecret {
		t.Errorf("opened %q, %v", got, err)
	}
}

func TestASecretThatWasChangedOrSealedWithAnotherKeyIsRefused(t *testing.T) {
	setTestKey(t)
	sealed, _ := SealSecret(rfcSecret)
	raw, _ := base64.StdEncoding.DecodeString(sealed)
	raw[len(raw)-1] ^= 1
	if _, err := OpenSecret(base64.StdEncoding.EncodeToString(raw)); err == nil {
		t.Error("a changed secret was opened")
	}
	for _, junk := range []string{"", "not base64 !", "AAAA"} {
		if _, err := OpenSecret(junk); err == nil {
			t.Errorf("%q was opened", junk)
		}
	}
	t.Setenv(EncryptionKeyEnv, base64.StdEncoding.EncodeToString([]byte("another-key-another-key-another!")))
	if _, err := OpenSecret(sealed); err == nil {
		t.Error("opened with another key")
	}
}

func TestWithoutAGoodKeyTwoStepSignInIsNotOffered(t *testing.T) {
	t.Setenv(EncryptionKeyEnv, "")
	if TwoFactorAvailable() {
		t.Error("available with no key")
	}
	if _, err := SealSecret("x"); err != ErrNoEncryptionKey {
		t.Errorf("sealing without a key: %v", err)
	}
	for _, bad := range []string{"short", base64.StdEncoding.EncodeToString([]byte("too short")), "!!!not base64!!!"} {
		t.Setenv(EncryptionKeyEnv, bad)
		if TwoFactorAvailable() {
			t.Errorf("%q counts as a key", bad)
		}
	}
	setTestKey(t)
	if !TwoFactorAvailable() {
		t.Error("a good key is not accepted")
	}
}

// ---- recovery codes ------------------------------------------------------------------------------------------

func TestRecoveryCodesAreDistinctAndWritten(t *testing.T) {
	codes, err := NewRecoveryCodes(RecoveryCodeCount)
	if err != nil || len(codes) != 10 {
		t.Fatalf("%v, %d codes", err, len(codes))
	}
	seen := map[string]bool{}
	for _, code := range codes {
		if len(code) != 11 || code[5] != '-' || !LooksLikeRecoveryCode(code) {
			t.Errorf("%q is not written as expected", code)
		}
		if strings.ContainsAny(code, "0o1li") {
			t.Errorf("%q has a letter that is mistaken for another", code)
		}
		seen[code] = true
	}
	if len(seen) != 10 {
		t.Errorf("repeated codes: %d different", len(seen))
	}
}

func TestARecoveryCodeIsRecognizedHoweverItIsTyped(t *testing.T) {
	want := HashRecoveryCode("k3m9x-h2q7a")
	for _, typed := range []string{"k3m9x-h2q7a", "K3M9X-H2Q7A", " k3m9xh2q7a ", "k3m9x h2q7a"} {
		if HashRecoveryCode(typed) != want || !LooksLikeRecoveryCode(typed) {
			t.Errorf("%q", typed)
		}
	}
	for _, not := range []string{"", "k3m9x-h2q7", "k3m9x-h2q7a1", "o0o0o-l1l1l", "123456"} {
		if LooksLikeRecoveryCode(not) {
			t.Errorf("%q looks like a recovery code", not)
		}
	}
	if HashRecoveryCode("k3m9x-h2q7a") == HashRecoveryCode("k3m9x-h2q7b") {
		t.Error("different codes hash the same")
	}
}
