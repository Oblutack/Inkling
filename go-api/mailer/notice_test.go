package mailer

import (
	"context"
	"strings"
	"testing"
)

func TestANoticeSaysWhatItIsAndAlwaysHasTheWayToStop(t *testing.T) {
	m := Notice("ana@example.com", "3 flashcards to review today", "Time to review", "3 flashcards are due.",
		[]string{"Cell biology", "<b>Lease</b>"}, "Start reviewing", "https://inkling.example/review",
		"You get this because you switched on study reminders.", "https://inkling.example/unsubscribe?token=abc&kind=reminders")

	if m.To != "ana@example.com" || m.Subject != "3 flashcards to review today" {
		t.Errorf("to %q subject %q", m.To, m.Subject)
	}
	for _, want := range []string{"Time to review", "3 flashcards are due.", "- Cell biology", "https://inkling.example/review", "switched on study reminders", "Stop these emails: https://inkling.example/unsubscribe?token=abc&kind=reminders"} {
		if !strings.Contains(m.Text, want) {
			t.Errorf("text is missing %q:\n%s", want, m.Text)
		}
	}
	if !strings.Contains(m.HTML, `href="https://inkling.example/review"`) || !strings.Contains(m.HTML, "Stop these emails") {
		t.Errorf("html: %s", m.HTML)
	}
	if strings.Contains(m.HTML, "<b>Lease</b>") || !strings.Contains(m.HTML, "&lt;b&gt;Lease&lt;/b&gt;") {
		t.Errorf("a title can never become markup: %s", m.HTML)
	}
	if m.Headers["List-Unsubscribe"] != "<https://inkling.example/unsubscribe?token=abc&kind=reminders>" {
		t.Errorf("headers: %v", m.Headers)
	}
}

func TestANoticeWithNoLinesHasNoEmptyList(t *testing.T) {
	m := Notice("a@b.example", "s", "h", "i", nil, "Go", "https://x.example/", "why", "https://x.example/u")
	if strings.Contains(m.HTML, "<ul") {
		t.Errorf("no list: %s", m.HTML)
	}
}

func TestHeadersReachBothProviders(t *testing.T) {
	headers := map[string]string{"List-Unsubscribe": "<https://x.example/u>"}

	srv, got := fakeProvider(t, 201, `{}`)
	oldBrevo := brevoURL
	brevoURL = srv.URL
	t.Cleanup(func() { brevoURL = oldBrevo })
	b, _ := newBrevo("k", "Inkling <noreply@example.com>")
	if err := b.Send(context.Background(), Message{To: "u@example.com", Subject: "s", Text: "t", HTML: "h", Headers: headers}); err != nil {
		t.Fatal(err)
	}
	if sent, _ := got.body["headers"].(map[string]any); sent["List-Unsubscribe"] != "<https://x.example/u>" {
		t.Errorf("brevo: %v", got.body)
	}

	srv2, got2 := fakeProvider(t, 200, `{}`)
	oldResend := resendURL
	resendURL = srv2.URL
	t.Cleanup(func() { resendURL = oldResend })
	r, _ := newResend("k", "Inkling <noreply@example.com>")
	if err := r.Send(context.Background(), Message{To: "u@example.com", Subject: "s", Text: "t", HTML: "h", Headers: headers}); err != nil {
		t.Fatal(err)
	}
	if sent, _ := got2.body["headers"].(map[string]any); sent["List-Unsubscribe"] != "<https://x.example/u>" {
		t.Errorf("resend: %v", got2.body)
	}

	// A plain message adds no headers field at all.
	srv3, got3 := fakeProvider(t, 201, `{}`)
	brevoURL = srv3.URL
	if err := b.Send(context.Background(), Message{To: "u@example.com", Subject: "s", Text: "t", HTML: "h"}); err != nil {
		t.Fatal(err)
	}
	if _, has := got3.body["headers"]; has {
		t.Errorf("no headers unless there are some: %v", got3.body)
	}
}
