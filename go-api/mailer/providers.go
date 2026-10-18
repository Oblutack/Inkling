package mailer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

var httpClient = &http.Client{Timeout: sendTimeout}

// Provider endpoints; variables so tests can point them at a fake server.
var (
	brevoURL  = "https://api.brevo.com/v3/smtp/email"
	resendURL = "https://api.resend.com/emails"
)

// postJSON sends the request and turns any non-2xx reply into an error that includes the
// provider's explanation (never the API key).
func postJSON(ctx context.Context, url string, headers map[string]string, body any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("provider returned %s: %s", resp.Status, bytes.TrimSpace(detail))
	}
	return nil
}

// ---- Brevo ---------------------------------------------------------------------------------

type brevoMailer struct {
	apiKey, fromName, fromAddress string
}

func newBrevo(apiKey, from string) (Mailer, error) {
	if apiKey == "" {
		return nil, errors.New("BREVO_API_KEY is required when MAIL_PROVIDER=brevo")
	}
	name, address, err := parseSender(from)
	if err != nil {
		return nil, err
	}
	return brevoMailer{apiKey, name, address}, nil
}

func (b brevoMailer) Send(ctx context.Context, msg Message) error {
	sender := map[string]string{"email": b.fromAddress}
	if b.fromName != "" {
		sender["name"] = b.fromName
	}
	body := map[string]any{
		"sender":      sender,
		"to":          []map[string]string{{"email": msg.To}},
		"subject":     msg.Subject,
		"textContent": msg.Text,
		"htmlContent": msg.HTML,
	}
	if len(msg.Headers) > 0 {
		body["headers"] = msg.Headers
	}
	return postJSON(ctx, brevoURL, map[string]string{"api-key": b.apiKey}, body)
}

// ---- Resend --------------------------------------------------------------------------------

type resendMailer struct {
	apiKey, from string
}

func newResend(apiKey, from string) (Mailer, error) {
	if apiKey == "" {
		return nil, errors.New("RESEND_API_KEY is required when MAIL_PROVIDER=resend")
	}
	if _, _, err := parseSender(from); err != nil {
		return nil, err
	}
	return resendMailer{apiKey, from}, nil
}

func (r resendMailer) Send(ctx context.Context, msg Message) error {
	body := map[string]any{
		"from":    r.from,
		"to":      []string{msg.To},
		"subject": msg.Subject,
		"text":    msg.Text,
		"html":    msg.HTML,
	}
	if len(msg.Headers) > 0 {
		body["headers"] = msg.Headers
	}
	return postJSON(ctx, resendURL, map[string]string{"Authorization": "Bearer " + r.apiKey}, body)
}
