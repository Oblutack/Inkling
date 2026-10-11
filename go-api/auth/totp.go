package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // HMAC-SHA1 is what RFC 6238 and every authenticator app use; it is not used as a hash for anything else
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Authenticator apps (Google Authenticator, Authy, 1Password, Aegis...) all speak the same standard: a shared secret and the
// time give a six-digit code that changes every 30 seconds (RFC 6238, built on RFC 4226). Nothing here needs a library.
const (
	totpPeriod = 30 // seconds a code is shown for
	totpDigits = 6
	// totpSkew is how many steps either side of the current one are accepted, for a phone whose clock is a little off (and
	// for a code that was typed as the step changed).
	totpSkew = 1
	// TOTPSecretBytes is the length of a new secret: 160 bits, what RFC 4226 recommends.
	TOTPSecretBytes = 20
)

var base32NoPadding = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewTOTPSecret returns a new random secret, written the way authenticator apps want it (base32).
func NewTOTPSecret() (string, error) {
	raw := make([]byte, TOTPSecretBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base32NoPadding.EncodeToString(raw), nil
}

// TOTPStep is the 30-second step a moment falls in.
func TOTPStep(t time.Time) int64 { return t.Unix() / totpPeriod }

// TOTPCode is the code for a secret at a step.
func TOTPCode(secret string, step int64) (string, error) {
	key, err := base32NoPadding.DecodeString(strings.ToUpper(strings.ReplaceAll(secret, " ", "")))
	if err != nil {
		return "", fmt.Errorf("the secret is not base32: %w", err)
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step)) //nolint:gosec // a step is a positive number of 30-second periods
	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)
	// dynamic truncation, RFC 4226 section 5.3
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	code := value % 1_000_000
	return fmt.Sprintf("%0*d", totpDigits, code), nil
}

// CleanCode tidies what a person typed (spaces and dashes are how apps and people group digits) and says whether it is
// a six-digit code at all.
func CleanCode(input string) (string, bool) {
	code := strings.NewReplacer(" ", "", "-", "", " ", "").Replace(strings.TrimSpace(input))
	if len(code) != totpDigits {
		return "", false
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return "", false
		}
	}
	return code, true
}

// VerifyTOTP checks a typed code against the secret at a moment. It returns the step the code belongs to, and false when
// the code is wrong or its step is not newer than lastStep: a code is good once, so one that was seen (over a shoulder, or
// in a recording) cannot be used again.
func VerifyTOTP(secret, input string, now time.Time, lastStep int64) (int64, bool) {
	code, ok := CleanCode(input)
	if !ok {
		return 0, false
	}
	current := TOTPStep(now)
	matched := int64(-1)
	// every step is compared whether or not an earlier one matched, so the time taken does not say which step it was
	for step := current - totpSkew; step <= current+totpSkew; step++ {
		want, err := TOTPCode(secret, step)
		if err != nil {
			return 0, false
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 && step > lastStep {
			matched = step
		}
	}
	if matched < 0 {
		return 0, false
	}
	return matched, true
}

// OtpauthURL is what the QR code holds: it tells the app the secret, the issuer and the account it belongs to.
func OtpauthURL(issuer, account, secret string) string {
	label := url.PathEscape(issuer) + ":" + url.PathEscape(account)
	query := url.Values{}
	query.Set("secret", secret)
	query.Set("issuer", issuer)
	query.Set("algorithm", "SHA1")
	query.Set("digits", fmt.Sprint(totpDigits))
	query.Set("period", fmt.Sprint(totpPeriod))
	return "otpauth://totp/" + label + "?" + query.Encode()
}
