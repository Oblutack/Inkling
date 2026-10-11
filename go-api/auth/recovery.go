package auth

import (
	"crypto/rand"
	"strings"
)

// A recovery code is for the day the phone is lost or broken: ten are made when two-step sign-in is switched on, each works
// once, and only their hashes are kept (like a session token, a stolen database does not give out working codes).
const (
	// RecoveryCodeCount is how many codes a person gets.
	RecoveryCodeCount = 10
	// A code is ten characters from an alphabet without the ones that are mistaken for each other (0 and o, 1 and l),
	// about 49 bits: more than a password a person would choose, and the limit on attempts makes guessing pointless.
	recoveryAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"
	recoveryLength   = 10
)

// NewRecoveryCodes returns n new codes, written in two groups of five ("k3m9x-h2q7a").
func NewRecoveryCodes(n int) ([]string, error) {
	codes := make([]string, 0, n)
	for len(codes) < n {
		code, err := newRecoveryCode()
		if err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	return codes, nil
}

func newRecoveryCode() (string, error) {
	// 31 letters do not divide 256 evenly: bytes past the last whole multiple are skipped, so no letter is likelier
	limit := 256 - 256%len(recoveryAlphabet)
	var b strings.Builder
	for count := 0; count < recoveryLength; {
		raw := make([]byte, recoveryLength)
		if _, err := rand.Read(raw); err != nil {
			return "", err
		}
		for _, v := range raw {
			if int(v) >= limit {
				continue
			}
			if count == recoveryLength/2 {
				b.WriteByte('-')
			}
			b.WriteByte(recoveryAlphabet[int(v)%len(recoveryAlphabet)])
			count++
			if count == recoveryLength {
				break
			}
		}
	}
	return b.String(), nil
}

// CleanRecoveryCode is what is compared and hashed: lower case, without the dash or any spaces.
func CleanRecoveryCode(input string) string {
	return strings.NewReplacer("-", "", " ", "", " ", "").Replace(strings.ToLower(strings.TrimSpace(input)))
}

// HashRecoveryCode is what is stored for a code.
func HashRecoveryCode(input string) string { return HashToken(CleanRecoveryCode(input)) }

// LooksLikeRecoveryCode says whether a typed value could be a recovery code at all (the right length, the right letters).
func LooksLikeRecoveryCode(input string) bool {
	clean := CleanRecoveryCode(input)
	if len(clean) != recoveryLength {
		return false
	}
	for _, r := range clean {
		if !strings.ContainsRune(recoveryAlphabet, r) {
			return false
		}
	}
	return true
}
