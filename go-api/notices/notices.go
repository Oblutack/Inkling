// Package notices is what lets Inkling write to a person without being asked each time: which kinds of email they chose,
// the link that switches them off without a login, and the record that keeps an email of a kind from going out twice in
// a day. The emails themselves are made by whoever sends them (the study reminder, the page alert, the digest); this
// decides whether to send, and how the person can stop.
//
// Nothing here is on by default except what a person asked for by doing something: an alert for a page they chose to watch.
// Reminders and the digest stay off until they are switched on.
package notices

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
	"time"
	_ "time/tzdata" // zone names work in the production image, which has no zone files of its own

	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/mailer"
)

// The kinds of email a person can switch on and off.
const (
	KindWatch     = "watch"     // a page they watch has changed
	KindReminders = "reminders" // flashcards are due
	KindDigest    = "digest"    // the weekly reading list
	// KindAll is only for unsubscribing: every kind at once.
	KindAll = "all"
)

// Kinds lists every kind, in the order the account page shows them.
var Kinds = []string{KindWatch, KindReminders, KindDigest}

var defaults = map[string]bool{KindWatch: true, KindReminders: false, KindDigest: false}

// IsKind says whether name is a kind of email (or "all").
func IsKind(name string) bool {
	if name == KindAll {
		return true
	}
	_, ok := defaults[name]
	return ok
}

// Prefs is what a person has chosen, with the defaults filled in.
type Prefs struct {
	Watch     bool   `json:"watch"`
	Reminders bool   `json:"reminders"`
	Digest    bool   `json:"digest"`
	TimeZone  string `json:"timeZone"`
}

// Update is a change to the preferences: only what is set changes.
type Update struct {
	Watch, Reminders, Digest *bool
	TimeZone                 *string
}

// ErrBadTimeZone is returned for a zone name that is not an IANA name.
var ErrBadTimeZone = errors.New("that is not a time zone name")

// PrefsOf reads a person's choices.
func PrefsOf(userID uint) (Prefs, error) {
	var row struct {
		Prefs    string
		TimeZone string
	}
	if err := initializers.DB.Raw("SELECT email_prefs::text AS prefs, time_zone FROM users WHERE id = ?", userID).Scan(&row).Error; err != nil {
		return Prefs{}, err
	}
	return parsePrefs(row.Prefs, row.TimeZone), nil
}

func parsePrefs(raw, timeZone string) Prefs {
	chosen := map[string]bool{}
	_ = json.Unmarshal([]byte(raw), &chosen)
	pick := func(kind string) bool {
		if v, ok := chosen[kind]; ok {
			return v
		}
		return defaults[kind]
	}
	return Prefs{Watch: pick(KindWatch), Reminders: pick(KindReminders), Digest: pick(KindDigest), TimeZone: timeZone}
}

// Wants says whether the person has this kind of email switched on.
func Wants(userID uint, kind string) bool {
	p, err := PrefsOf(userID)
	if err != nil {
		return false
	}
	switch kind {
	case KindWatch:
		return p.Watch
	case KindReminders:
		return p.Reminders
	case KindDigest:
		return p.Digest
	}
	return false
}

// Set applies a change. A time zone has to be a real one: it is used to decide what "8 in the morning" is.
func Set(userID uint, u Update) error {
	chosen := map[string]bool{}
	if u.Watch != nil {
		chosen[KindWatch] = *u.Watch
	}
	if u.Reminders != nil {
		chosen[KindReminders] = *u.Reminders
	}
	if u.Digest != nil {
		chosen[KindDigest] = *u.Digest
	}
	if u.TimeZone != nil && *u.TimeZone != "" {
		if _, err := time.LoadLocation(*u.TimeZone); err != nil || strings.ContainsAny(*u.TimeZone, " \t\r\n") {
			return ErrBadTimeZone
		}
	}
	if len(chosen) > 0 {
		raw, _ := json.Marshal(chosen)
		if err := initializers.DB.Exec("UPDATE users SET email_prefs = email_prefs || ?::jsonb WHERE id = ?", string(raw), userID).Error; err != nil {
			return err
		}
	}
	if u.TimeZone != nil {
		if err := initializers.DB.Exec("UPDATE users SET time_zone = ? WHERE id = ?", *u.TimeZone, userID).Error; err != nil {
			return err
		}
	}
	return nil
}

// Location is the person's time zone, or UTC when they have not set one (or it is not one this server knows).
func Location(zone string) *time.Location {
	if zone == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return time.UTC
	}
	return loc
}

// Token returns the person's unsubscribe token, making one the first time.
func Token(userID uint) (string, error) {
	var token string
	if err := initializers.DB.Raw("SELECT unsubscribe_token FROM users WHERE id = ?", userID).Scan(&token).Error; err != nil {
		return "", err
	}
	if token != "" {
		return token, nil
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	// Only where there is none yet, so two emails made at the same moment end up with the same link.
	if err := initializers.DB.Exec("UPDATE users SET unsubscribe_token = ? WHERE id = ? AND unsubscribe_token = ''", token, userID).Error; err != nil {
		return "", err
	}
	if err := initializers.DB.Raw("SELECT unsubscribe_token FROM users WHERE id = ?", userID).Scan(&token).Error; err != nil {
		return "", err
	}
	return token, nil
}

// frontendURL is where the links in emails point (the website).
func frontendURL() string {
	if u := os.Getenv("FRONTEND_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	return "http://localhost:3000"
}

// PageURL is a link to a page of the website.
func PageURL(path string) string { return frontendURL() + path }

// UnsubscribeURL is the link that switches a kind of email off (the website page asks the API to do it).
func UnsubscribeURL(token, kind string) string {
	return frontendURL() + "/unsubscribe?token=" + url.QueryEscape(token) + "&kind=" + url.QueryEscape(kind)
}

// Unsubscribe switches a kind of email off for the person the token belongs to. It reports nothing about whether the token
// matched anyone, so the link cannot be used to find out who has an account.
func Unsubscribe(token, kind string) {
	if len(token) < 32 || !IsKind(kind) {
		return
	}
	off := `{"` + KindWatch + `":false,"` + KindReminders + `":false,"` + KindDigest + `":false}`
	if kind != KindAll {
		off = `{"` + kind + `":false}`
	}
	_ = initializers.DB.Exec("UPDATE users SET email_prefs = email_prefs || ?::jsonb WHERE unsubscribe_token = ?", off, token).Error
}

// FirstToday records that an email of this kind goes to this person on this day (a calendar day in their own zone,
// "2026-10-18") and reports whether it was the first: a job that runs several times a day sends it once.
func FirstToday(userID uint, kind, day string) bool {
	res := initializers.DB.Exec("INSERT INTO notice_log (user_id, kind, day) VALUES (?, ?, ?::date) ON CONFLICT DO NOTHING", userID, kind, day)
	return res.Error == nil && res.RowsAffected == 1
}

// Forget takes back FirstToday, for when the email could not be made after all.
func Forget(userID uint, kind, day string) {
	_ = initializers.DB.Exec("DELETE FROM notice_log WHERE user_id = ? AND kind = ? AND day = ?::date", userID, kind, day).Error
}

// Send emails a person a kind of notice if they want it. build makes the message from the link that stops such emails.
// It reports whether an email was sent (handed to the mail provider, in the background).
func Send(m mailer.Mailer, userID uint, address, kind string, build func(unsubscribeURL string) mailer.Message) bool {
	if m == nil || address == "" || !Wants(userID, kind) {
		return false
	}
	token, err := Token(userID)
	if err != nil {
		return false
	}
	msg := build(UnsubscribeURL(token, kind))
	msg.To = address
	mailer.SendAsync(m, msg)
	return true
}
