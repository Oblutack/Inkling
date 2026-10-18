// Package mailer sends the transactional emails (verification, password reset). Providers are
// interchangeable; pick one with MAIL_PROVIDER:
//
//	log    (default) prints the email, including its link, to the server log. For local development
//	       only: it means no account or API key is needed to try the whole flow.
//	brevo  Brevo's transactional API.  Needs BREVO_API_KEY.
//	resend Resend's API.               Needs RESEND_API_KEY.
//
// MAIL_FROM is the sender, e.g. "Inkling <noreply@example.com>"; the address must be one the
// provider has verified for your account.
package mailer

import (
	"context"
	"fmt"
	"log/slog"
	"net/mail"
	"os"
	"strings"
	"time"
)

// Message is a single email.
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
	// Headers are extra email headers, such as List-Unsubscribe on an email the person chose to receive.
	Headers map[string]string
}

// Mailer delivers a message.
type Mailer interface {
	Send(ctx context.Context, msg Message) error
}

const sendTimeout = 15 * time.Second

// FromEnv builds the configured provider. An unknown provider or missing key is an error, so a
// misconfigured deployment fails at startup instead of silently dropping password resets.
func FromEnv() (Mailer, error) {
	provider := strings.ToLower(strings.TrimSpace(os.Getenv("MAIL_PROVIDER")))
	from := os.Getenv("MAIL_FROM")

	switch provider {
	case "", "log":
		return LogMailer{}, nil
	case "brevo":
		return newBrevo(os.Getenv("BREVO_API_KEY"), from)
	case "resend":
		return newResend(os.Getenv("RESEND_API_KEY"), from)
	default:
		return nil, fmt.Errorf("unknown MAIL_PROVIDER %q (use log, brevo or resend)", provider)
	}
}

// parseSender splits `Name <address>` (or a bare address) and validates it.
func parseSender(from string) (name, address string, err error) {
	if strings.TrimSpace(from) == "" {
		return "", "", fmt.Errorf("MAIL_FROM is required for this provider")
	}
	addr, err := mail.ParseAddress(from)
	if err != nil {
		return "", "", fmt.Errorf("MAIL_FROM %q is not a valid address: %w", from, err)
	}
	return addr.Name, addr.Address, nil
}

// SendAsync delivers in the background so a slow or failing provider never delays or changes the
// HTTP response (which matters: "forgot password" must answer identically whether or not the
// account exists). Failures are logged, with the recipient's domain only.
func SendAsync(m Mailer, msg Message) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
		defer cancel()
		if err := m.Send(ctx, msg); err != nil {
			slog.Error("sending email failed", "subject", msg.Subject, "to_domain", domainOf(msg.To), "error", err)
		}
	}()
}

func domainOf(address string) string {
	if i := strings.LastIndex(address, "@"); i >= 0 {
		return address[i+1:]
	}
	return ""
}

// LogMailer writes emails to the log instead of sending them.
type LogMailer struct{}

func (LogMailer) Send(_ context.Context, msg Message) error {
	slog.Info("email (MAIL_PROVIDER=log, not actually sent)", "to", msg.To, "subject", msg.Subject, "body", msg.Text)
	return nil
}
