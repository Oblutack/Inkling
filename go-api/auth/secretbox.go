package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"strings"
)

// The authenticator secret has to be read back to check a code, so unlike a password it cannot be stored as a hash. It is
// encrypted instead (AES-256-GCM) with a key that lives outside the database, so a copy of the database alone, a backup
// or a stolen dump, does not give out working codes.

// EncryptionKeyEnv names the setting that holds the key: 32 random bytes, written in base64 (`openssl rand -base64 32`).
const EncryptionKeyEnv = "TOTP_ENCRYPTION_KEY"

// ErrNoEncryptionKey means two-step sign-in cannot be offered, because there is no key to protect its secrets with.
var ErrNoEncryptionKey = errors.New("TOTP_ENCRYPTION_KEY is not set")

func encryptionKey() ([]byte, error) {
	value := strings.TrimSpace(os.Getenv(EncryptionKeyEnv))
	if value == "" {
		return nil, ErrNoEncryptionKey
	}
	key, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		key, err = base64.RawStdEncoding.DecodeString(value)
	}
	if err != nil || len(key) != 32 {
		return nil, errors.New(EncryptionKeyEnv + " must be 32 random bytes written in base64 (openssl rand -base64 32)")
	}
	return key, nil
}

// TwoFactorAvailable is whether a key is set and good: without one, nobody can switch two-step sign-in on.
func TwoFactorAvailable() bool {
	_, err := encryptionKey()
	return err == nil
}

// SealSecret encrypts a secret. What comes back is base64 of a random nonce followed by the ciphertext.
func SealSecret(plain string) (string, error) {
	key, err := encryptionKey()
	if err != nil {
		return "", err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plain), nil)), nil
}

// OpenSecret decrypts what SealSecret made. A value that was changed, or made with another key, is refused.
func OpenSecret(sealed string) (string, error) {
	key, err := encryptionKey()
	if err != nil {
		return "", err
	}
	raw, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil {
		return "", errors.New("the stored secret is not readable")
	}
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("the stored secret is not readable")
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return "", errors.New("the stored secret could not be decrypted (a different key, or it was changed)")
	}
	return string(plain), nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
