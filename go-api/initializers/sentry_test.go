package initializers

import (
	"io"
	"log/slog"
	"testing"

	"github.com/getsentry/sentry-go"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func TestSentryIsOffWithoutADSN(t *testing.T) {
	t.Setenv("SENTRY_DSN", "")
	flush := SetupSentry(quiet)
	flush() // must be safe to call
	// Newer versions of the library keep a default client that has no DSN and drops every event; what matters is that nothing
	// is configured to be sent.
	if client := sentry.CurrentHub().Client(); client != nil && client.Options().Dsn != "" {
		t.Errorf("no DSN was given, so no events should be sent anywhere, but the client has the DSN %q", client.Options().Dsn)
	}
}

func TestABadDSNDoesNotStopTheAPI(t *testing.T) {
	t.Setenv("SENTRY_DSN", "this is not a dsn")
	SetupSentry(quiet)() // reports the problem in the log and carries on
}

func TestSentryStartsWithAValidDSN(t *testing.T) {
	t.Setenv("SENTRY_DSN", "https://public@example.invalid/1")
	t.Setenv("SENTRY_ENVIRONMENT", "staging")
	flush := SetupSentry(quiet)
	t.Cleanup(func() { sentry.CurrentHub().BindClient(nil) })

	client := sentry.CurrentHub().Client()
	if client == nil {
		t.Fatal("a valid DSN should start the client")
	}
	if client.Options().Environment != "staging" || client.Options().BeforeSend == nil {
		t.Errorf("unexpected options: %+v", client.Options())
	}
	flush()
}

func TestEventsAreScrubbedOfUserData(t *testing.T) {
	event := &sentry.Event{
		Message:     "boom",
		Request:     &sentry.Request{URL: "https://api/login", Cookies: "session=secret", Data: "password=hunter2"},
		User:        sentry.User{Email: "person@example.com", IPAddress: "203.0.113.9"},
		Breadcrumbs: []*sentry.Breadcrumb{{Message: "typed text"}},
		Tags:        map[string]string{"request_id": "abc12345"},
	}
	got := ScrubEvent(event, nil)
	if got.Request != nil || got.User.Email != "" || got.User.IPAddress != "" || got.Breadcrumbs != nil {
		t.Errorf("user data survived scrubbing: %+v", got)
	}
	if got.Message != "boom" || got.Tags["request_id"] != "abc12345" {
		t.Error("the error itself and its request id must be kept")
	}
}
