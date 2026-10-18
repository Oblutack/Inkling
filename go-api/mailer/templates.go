package mailer

import (
	"fmt"
	"html"
	"net/url"
	"strings"
)

const appName = "Inkling"

// link builds an absolute URL to a frontend page carrying the token. The base URL comes from
// FRONTEND_URL; the token goes in the query string of our own page, which sends it to the API.
func link(frontendURL, path, token string) string {
	return strings.TrimRight(frontendURL, "/") + path + "?token=" + url.QueryEscape(token)
}

func wrap(heading, intro, button, href, outro string) (text, htmlBody string) {
	text = fmt.Sprintf("%s\n\n%s\n\n%s\n\n%s\n\n%s", heading, intro, href, outro, appName)
	htmlBody = fmt.Sprintf(`<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#222">
<h2>%s</h2>
<p>%s</p>
<p><a href="%s" style="display:inline-block;background:#222;color:#f5f0e6;padding:12px 22px;text-decoration:none;border-radius:6px">%s</a></p>
<p style="font-size:13px;color:#555">If the button doesn't work, copy this link into your browser:<br>%s</p>
<p style="font-size:13px;color:#555">%s</p>
</div>`, html.EscapeString(heading), html.EscapeString(intro), html.EscapeString(href), html.EscapeString(button), html.EscapeString(href), html.EscapeString(outro))
	return text, htmlBody
}

// VerifyEmail is sent after signup.
func VerifyEmail(to, frontendURL, token string) Message {
	href := link(frontendURL, "/verify-email", token)
	text, body := wrap("Confirm your email", "Thanks for signing up. Please confirm this email address to finish setting up your account.",
		"Confirm email", href, "This link expires in 24 hours. If you didn't create an account, you can ignore this email.")
	return Message{To: to, Subject: "Confirm your email address", Text: text, HTML: body}
}

// AccountExists is sent when someone signs up with an address that already has an account. It is the only way the
// owner hears of it: the signup page says the same thing whether the address is new or not.
func AccountExists(to, frontendURL string) Message {
	href := strings.TrimRight(frontendURL, "/") + "/login"
	text, body := wrap("You already have an account", "Someone, perhaps you, just tried to sign up to "+appName+" with this email address, which already has an account. Log in with your usual password, or reset it if you have forgotten it.",
		"Log in", href, "If it wasn't you, nothing has changed and you can ignore this email.")
	text += "\n\nForgotten your password? " + strings.TrimRight(frontendURL, "/") + "/forgot-password"
	return Message{To: to, Subject: "You already have an Inkling account", Text: text, HTML: body}
}

// ResetPassword is sent when someone asks to reset a password.
func ResetPassword(to, frontendURL, token string) Message {
	href := link(frontendURL, "/reset-password", token)
	text, body := wrap("Reset your password", "We received a request to reset the password for your account. Use the link below to choose a new one.",
		"Choose a new password", href, "This link expires in 1 hour and can be used once. If you didn't ask for this, ignore this email; your password hasn't changed.")
	return Message{To: to, Subject: "Reset your password", Text: text, HTML: body}
}

// PasswordChanged tells the account owner their password changed (so a hijacker can't do it silently).
func PasswordChanged(to string) Message {
	text := "Your password was just changed and all your other devices were signed out.\n\nIf this wasn't you, reset your password immediately and contact support.\n\n" + appName
	body := `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#222"><h2>Your password was changed</h2><p>All your other devices were signed out.</p><p style="font-size:13px;color:#555">If this wasn't you, reset your password immediately.</p></div>`
	return Message{To: to, Subject: "Your password was changed", Text: text, HTML: body}
}

// SummaryEmail sends a saved summary to its owner. The summary is Markdown; it is sent as it is, in a
// block that keeps its line breaks, rather than being rendered, so nothing in it can become markup.
func SummaryEmail(to, title, summary string) Message {
	title = strings.Join(strings.Fields(title), " ")
	text := fmt.Sprintf("%s\n\n%s\n\n%s", title, summary, appName)
	body := fmt.Sprintf(`<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#222">
<h2>%s</h2>
<div style="white-space:pre-wrap;line-height:1.5">%s</div>
<p style="font-size:13px;color:#555">Sent from %s because you asked for it.</p>
</div>`, html.EscapeString(title), html.EscapeString(summary), appName)
	return Message{To: to, Subject: "Summary: " + title, Text: text, HTML: body}
}

// Notice is an email the person chose to receive: a reminder, an alert, a digest. It says what it is, what it holds
// (lines, shown as a list) and where to go, and it always ends with the way to stop such emails (and a List-Unsubscribe
// header, which mail programs show as an "unsubscribe" button). Nothing from a person's documents goes in it beyond the
// short lines the caller passes.
func Notice(to, subject, heading, intro string, lines []string, button, href, why, unsubscribeURL string) Message {
	var text strings.Builder
	text.WriteString(heading + "\n\n" + intro + "\n")
	var items strings.Builder
	for _, line := range lines {
		text.WriteString("\n- " + line)
		items.WriteString("<li>" + html.EscapeString(line) + "</li>")
	}
	if len(lines) > 0 {
		text.WriteString("\n")
	}
	text.WriteString("\n" + button + ": " + href + "\n\n" + why + "\nStop these emails: " + unsubscribeURL + "\n\n" + appName)
	list := ""
	if items.Len() > 0 {
		list = "<ul style=\"line-height:1.5\">" + items.String() + "</ul>"
	}
	body := fmt.Sprintf(`<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#222">
<h2>%s</h2>
<p>%s</p>
%s<p><a href="%s" style="display:inline-block;background:#222;color:#f5f0e6;padding:12px 22px;text-decoration:none;border-radius:6px">%s</a></p>
<p style="font-size:13px;color:#555">%s <a href="%s">Stop these emails</a>.</p>
</div>`, html.EscapeString(heading), html.EscapeString(intro), list, html.EscapeString(href), html.EscapeString(button),
		html.EscapeString(why), html.EscapeString(unsubscribeURL))
	return Message{
		To: to, Subject: subject, Text: text.String(), HTML: body,
		Headers: map[string]string{"List-Unsubscribe": "<" + unsubscribeURL + ">"},
	}
}
