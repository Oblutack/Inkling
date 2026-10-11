package server

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// API keys: a program calls the /v1 routes with "Authorization: Bearer ink_...". A key can do the summarizing and
// nothing else; the owner's quota, the rate limits and the spending guard apply to it.

// call is a request as a program makes it: no cookie, no Origin, only the key (when there is one).
func (a *app) call(method, path, key string, body any, headers ...string) reply {
	a.t.Helper()
	anon := a.newClient()
	anon.origin = ""
	if key != "" {
		headers = append([]string{"Authorization", "Bearer " + key}, headers...)
	}
	return anon.req(method, path, body, headers...)
}

func (a *app) callUpload(path, key, field string, files map[string][]byte) reply {
	a.t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for name, data := range files {
		part, err := w.CreateFormFile(field, name)
		if err != nil {
			a.t.Fatal(err)
		}
		_, _ = part.Write(data)
	}
	_ = w.Close()
	req, _ := http.NewRequest(http.MethodPost, a.srv.URL+path, &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, _ := io.ReadAll(resp.Body)
	return reply{resp.StatusCode, resp.Header, data}
}

func makeKey(t *testing.T, cl *client, name string) (id uint, key string) {
	t.Helper()
	r := cl.post("/account/api-keys", map[string]string{"name": name})
	if r.Status != http.StatusCreated {
		t.Fatalf("creating a key: %d %s", r.Status, r.Body)
	}
	return uint(r.JSON()["id"].(float64)), r.Str("key")
}

func textBody() map[string]string {
	return map[string]string{"text": "Heat pumps are efficient. Sales rose in 2024."}
}

// ---- making and listing keys --------------------------------------------------------------------

func TestAKeyIsShownOnceAndOnlyItsHashIsKept(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()

	r := cl.post("/account/api-keys", map[string]string{"name": "  nightly   job "})
	if r.Status != http.StatusCreated {
		t.Fatalf("create: %d %s", r.Status, r.Body)
	}
	key := r.Str("key")
	if !regexp.MustCompile(`^ink_[A-Za-z0-9_-]{43}$`).MatchString(key) {
		t.Fatalf("a key looks like ink_ and 43 random characters: %q", key)
	}
	if r.Str("name") != "nightly job" || r.Str("prefix") != key[:8] {
		t.Errorf("name and prefix: %s", r.Body)
	}

	// listed without the key, and nothing in the database can be used as the key
	list := cl.get("/account/api-keys")
	if list.Status != http.StatusOK || strings.Contains(string(list.Body), key) || strings.Contains(string(list.Body), "key_hash") {
		t.Fatalf("the list must never show a key: %d %s", list.Status, list.Body)
	}
	if !strings.Contains(string(list.Body), `"prefix":"`+key[:8]+`"`) || !strings.Contains(string(list.Body), "nightly job") {
		t.Errorf("the list shows what tells keys apart: %s", list.Body)
	}
	var stored string
	a.db.Raw("SELECT key_hash FROM api_keys LIMIT 1").Scan(&stored)
	if len(stored) != 64 || stored == key || strings.Contains(stored, key[4:]) {
		t.Errorf("only a SHA-256 hash may be stored, found %q", stored)
	}
}

func TestAKeyHasADefaultNameAndNamesAreChecked(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	if r := cl.post("/account/api-keys", map[string]string{"name": "   "}); r.Status != http.StatusCreated || r.Str("name") != "API key" {
		t.Errorf("an empty name becomes the default: %d %s", r.Status, r.Body)
	}
	if r := cl.post("/account/api-keys", map[string]string{"name": strings.Repeat("x", 41)}); r.Status != http.StatusBadRequest {
		t.Errorf("a name over 40 characters: %d", r.Status)
	}
	if r := cl.post("/account/api-keys", map[string]string{"name": strings.Repeat("é", 40)}); r.Status != http.StatusCreated {
		t.Errorf("40 characters are counted as characters, not bytes: %d %s", r.Status, r.Body)
	}
}

func TestSomeoneHoldsAtMostFiveLiveKeys(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	var first uint
	for i := 0; i < 5; i++ {
		id, _ := makeKey(t, cl, "key")
		if i == 0 {
			first = id
		}
	}
	r := cl.post("/account/api-keys", map[string]string{"name": "sixth"})
	if r.Status != http.StatusConflict || r.Str("code") != "too_many_api_keys" {
		t.Fatalf("a sixth key: %d %s", r.Status, r.Body)
	}
	// ending one makes room, and other people have their own five
	if r := cl.delete("/account/api-keys/"+itoa(int(first)), nil); r.Status != http.StatusOK {
		t.Fatalf("revoke: %d %s", r.Status, r.Body)
	}
	if r := cl.post("/account/api-keys", map[string]string{"name": "sixth"}); r.Status != http.StatusCreated {
		t.Errorf("after revoking one: %d %s", r.Status, r.Body)
	}
	other, _ := a.newUser()
	if r := other.post("/account/api-keys", map[string]string{"name": "mine"}); r.Status != http.StatusCreated {
		t.Errorf("another person: %d", r.Status)
	}
}

func TestKeysMadeAtTheSameTimeCannotGoPastTheLimit(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	var wg sync.WaitGroup
	var mu sync.Mutex
	made, refused := 0, 0
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := cl.post("/account/api-keys", map[string]string{"name": "race"})
			mu.Lock()
			defer mu.Unlock()
			switch r.Status {
			case http.StatusCreated:
				made++
			case http.StatusConflict:
				refused++
			}
		}()
	}
	wg.Wait()
	if made != 5 || refused != 7 {
		t.Errorf("exactly 5 may be made: %d made, %d refused", made, refused)
	}
}

func TestKeysAreMadeAndListedOnlyWhenSignedIn(t *testing.T) {
	a := newApp(t)
	anon := a.newClient()
	if r := anon.post("/account/api-keys", map[string]string{"name": "x"}); r.Status != http.StatusUnauthorized {
		t.Errorf("create without signing in: %d", r.Status)
	}
	if r := anon.get("/account/api-keys"); r.Status != http.StatusUnauthorized {
		t.Errorf("list without signing in: %d", r.Status)
	}
}

// ---- using a key ----------------------------------------------------------------------------------

func TestAKeyOpensTheSummarizingRoutesAndNothingIsSaved(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "ci")

	r := a.call(http.MethodPost, "/v1/summarize-text", key, textBody())
	if r.Status != http.StatusOK || r.Str("summary") == "" {
		t.Fatalf("summarize-text: %d %s", r.Status, r.Body)
	}
	if strings.Contains(string(r.Body), "Heat pumps are efficient") {
		t.Errorf("the source text must not come back: %s", r.Body)
	}
	if r.Header.Get("X-Quota-Limit") == "" || r.Header.Get("X-Quota-Remaining") == "" {
		t.Errorf("the quota is reported: %v", r.Header)
	}
	if r := a.call(http.MethodPost, "/v1/summarize-url", key, map[string]string{"url": "https://news.example/post"}); r.Status != http.StatusOK {
		t.Errorf("summarize-url: %d %s", r.Status, r.Body)
	}
	if r := a.callUpload("/v1/summarize", key, "file", map[string][]byte{"report.pdf": pdfBytes}); r.Status != http.StatusOK {
		t.Errorf("summarize a file: %d %s", r.Status, r.Body)
	}
	if r := a.callUpload("/v1/summarize-multiple", key, "files", map[string][]byte{"a.pdf": pdfBytes, "b.pdf": pdfBytes}); r.Status != http.StatusOK {
		t.Errorf("summarize several files: %d %s", r.Status, r.Body)
	}
	if r := a.callUpload("/v1/summarize", key, "file", map[string][]byte{"page.jpg": jpegBytes}); r.Status != http.StatusOK {
		t.Errorf("a photo is for people with an account, and a key is that: %d %s", r.Status, r.Body)
	}

	// the owner's library is untouched
	if n := count(t, a.db, "SELECT count(*) FROM documents"); n != 0 {
		t.Errorf("nothing is saved, found %d documents", n)
	}
	if n := count(t, a.db, "SELECT count(*) FROM document_files"); n != 0 {
		t.Errorf("no files are kept, found %d", n)
	}
	if docs := listedDocuments(t, cl); len(docs) != 0 {
		t.Errorf("the library shows %d documents", len(docs))
	}
}

func TestResultsCanBeStreamed(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "stream")
	r := a.call(http.MethodPost, "/v1/summarize-text?stream=true", key, textBody())
	if r.Status != http.StatusOK || !strings.Contains(r.Header.Get("Content-Type"), "text/event-stream") || !strings.Contains(string(r.Body), `"type":"done"`) {
		t.Fatalf("streaming: %d %v %s", r.Status, r.Header, r.Body)
	}
}

func TestUsageShowsTheOwnersAllowance(t *testing.T) {
	a := newApp(t)
	t.Setenv("QUOTA_SUMMARIES_PER_DAY", "7")
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "usage")
	a.call(http.MethodPost, "/v1/summarize-text", key, textBody())
	r := a.call(http.MethodGet, "/v1/usage", key, nil)
	summaries, _ := r.JSON()["summaries"].(map[string]any)
	if r.Status != http.StatusOK || summaries["used"] != float64(1) || summaries["limit"] != float64(7) {
		t.Errorf("usage: %d %s", r.Status, r.Body)
	}
}

func TestTheKeyOwnersDailyQuotaAndTheSitesBudgetApplyToKeys(t *testing.T) {
	a := newApp(t)
	t.Setenv("QUOTA_SUMMARIES_PER_DAY", "2")
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "quota")

	// the website and the API draw on the same allowance
	if r := summarize(cl); r.Status != http.StatusOK {
		t.Fatalf("on the website: %d %s", r.Status, r.Body)
	}
	if r := a.call(http.MethodPost, "/v1/summarize-text", key, textBody()); r.Status != http.StatusOK || r.Header.Get("X-Quota-Remaining") != "0" {
		t.Fatalf("through the API: %d %s %v", r.Status, r.Body, r.Header)
	}
	r := a.call(http.MethodPost, "/v1/summarize-text", key, textBody())
	if r.Status != http.StatusTooManyRequests || r.Str("code") != "quota_exceeded" {
		t.Errorf("past the allowance: %d %s", r.Status, r.Body)
	}

	// and the site's budget holds every key
	t.Setenv("QUOTA_SUMMARIES_PER_DAY", "0")
	t.Setenv("AI_REQUESTS_PER_DAY", "1")
	if r := a.call(http.MethodPost, "/v1/summarize-text", key, textBody()); r.Status != http.StatusOK {
		t.Fatalf("the one piece of work the budget allows: %d %s", r.Status, r.Body)
	}
	if r := a.call(http.MethodPost, "/v1/summarize-text", key, textBody()); r.Status != http.StatusServiceUnavailable || r.Str("code") != "daily_budget" {
		t.Errorf("past the site's budget: %d %s", r.Status, r.Body)
	}
}

func TestAFailedCallIsGivenBackToTheOwner(t *testing.T) {
	a := newApp(t)
	t.Setenv("QUOTA_SUMMARIES_PER_DAY", "1")
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "refund")
	a.ai.fail.Store(true)
	if r := a.call(http.MethodPost, "/v1/summarize-text", key, textBody()); r.Status != http.StatusBadGateway {
		t.Fatalf("a failing AI service: %d", r.Status)
	}
	a.ai.fail.Store(false)
	if r := a.call(http.MethodPost, "/v1/summarize-text", key, textBody()); r.Status != http.StatusOK {
		t.Errorf("the allowance is still there: %d %s", r.Status, r.Body)
	}
}

func TestUsingAKeyNotesWhenItWasLastUsed(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, key := makeKey(t, cl, "noted")
	if n := count(t, a.db, "SELECT count(*) FROM api_keys WHERE id = ? AND last_used_at IS NOT NULL", id); n != 0 {
		t.Fatal("a new key has not been used")
	}
	a.call(http.MethodGet, "/v1/usage", key, nil)
	if n := count(t, a.db, "SELECT count(*) FROM api_keys WHERE id = ? AND last_used_at IS NOT NULL", id); n != 1 {
		t.Error("the use is noted")
	}
	if !strings.Contains(string(cl.get("/account/api-keys").Body), `"lastUsedAt":"20`) {
		t.Errorf("and shown in the list: %s", cl.get("/account/api-keys").Body)
	}
}

// ---- who gets in -------------------------------------------------------------------------------

func TestWithoutAValidKeyNothingGetsIn(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "real")
	session := cl.sessionToken()

	cases := map[string]reply{
		"no key":                    a.call(http.MethodPost, "/v1/summarize-text", "", textBody()),
		"a made-up key":             a.call(http.MethodPost, "/v1/summarize-text", "ink_"+strings.Repeat("a", 43), textBody()),
		"a key with a letter wrong": a.call(http.MethodPost, "/v1/summarize-text", key[:len(key)-1]+"x", textBody()),
		"a truncated key":           a.call(http.MethodPost, "/v1/summarize-text", key[:20], textBody()),
		"just the prefix":           a.call(http.MethodPost, "/v1/summarize-text", "ink_", textBody()),
		"a session token":           a.call(http.MethodPost, "/v1/summarize-text", session, textBody()),
		"the wrong scheme":          a.call(http.MethodPost, "/v1/summarize-text", "", textBody(), "Authorization", "Basic "+key),
		"the key without Bearer":    a.call(http.MethodPost, "/v1/summarize-text", "", textBody(), "Authorization", key),
		"usage with no key":         a.call(http.MethodGet, "/v1/usage", "", nil),
	}
	for name, r := range cases {
		if r.Status != http.StatusUnauthorized || r.Str("code") != "invalid_api_key" || r.Header.Get("WWW-Authenticate") == "" {
			t.Errorf("%s: %d %s", name, r.Status, r.Body)
		}
	}
	// the browser session is not a key either
	if r := cl.post("/v1/summarize-text", textBody()); r.Status != http.StatusUnauthorized {
		t.Errorf("a signed-in browser without a key: %d %s", r.Status, r.Body)
	}
	if n := a.ai.calls.Load(); n != 0 {
		t.Errorf("a refused request must not reach the AI service (%d calls)", n)
	}
}

func TestAKeyCannotDoAnythingButSummarize(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "narrow")
	saveText(t, cl, "A document in the library.")

	for name, r := range map[string]reply{
		"read the library":   a.call(http.MethodGet, "/documents", key, nil),
		"who am I":           a.call(http.MethodGet, "/auth/me", key, nil),
		"make another key":   a.call(http.MethodPost, "/account/api-keys", key, map[string]string{"name": "x"}),
		"list the keys":      a.call(http.MethodGet, "/account/api-keys", key, nil),
		"export the account": a.call(http.MethodGet, "/account/export", key, nil),
		"delete the account": a.call(http.MethodDelete, "/account", key, map[string]string{"confirmEmail": "x"}),
		"the old usage":      a.call(http.MethodGet, "/usage", key, nil),
		"chat with a doc":    a.call(http.MethodPost, "/documents/1/chat", key, map[string]string{"question": "hi"}),
	} {
		if r.Status != http.StatusUnauthorized {
			t.Errorf("%s with a key: %d %s", name, r.Status, r.Body)
		}
	}
}

func TestAKeyIsEndedAtOnce(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id, key := makeKey(t, cl, "short lived")
	if r := a.call(http.MethodGet, "/v1/usage", key, nil); r.Status != http.StatusOK {
		t.Fatalf("before: %d", r.Status)
	}
	if r := cl.delete("/account/api-keys/"+itoa(int(id)), nil); r.Status != http.StatusOK {
		t.Fatalf("revoke: %d %s", r.Status, r.Body)
	}
	if r := a.call(http.MethodGet, "/v1/usage", key, nil); r.Status != http.StatusUnauthorized {
		t.Errorf("after revoking: %d", r.Status)
	}
	if r := cl.delete("/account/api-keys/"+itoa(int(id)), nil); r.Status != http.StatusNotFound {
		t.Errorf("revoking twice: %d", r.Status)
	}
	// still listed, as ended
	if list := string(cl.get("/account/api-keys").Body); !strings.Contains(list, `"revokedAt":"20`) || !strings.Contains(list, "short lived") {
		t.Errorf("a revoked key stays in the list: %s", list)
	}
	if r := cl.delete("/account/api-keys/abc", nil); r.Status != http.StatusBadRequest {
		t.Errorf("a bad id: %d", r.Status)
	}
}

func TestNobodyCanSeeOrEndSomeoneElsesKeys(t *testing.T) {
	a := newApp(t)
	alice, aliceEmail := a.newUser()
	bob, _ := a.newUser()
	id, key := makeKey(t, alice, "alice's")

	if r := bob.delete("/account/api-keys/"+itoa(int(id)), nil); r.Status != http.StatusNotFound {
		t.Errorf("Bob ending Alice's key: %d", r.Status)
	}
	if r := a.call(http.MethodGet, "/v1/usage", key, nil); r.Status != http.StatusOK {
		t.Errorf("Alice's key still works: %d", r.Status)
	}
	if list := string(bob.get("/account/api-keys").Body); strings.Contains(list, "alice") || strings.Contains(list, key[:8]) {
		t.Errorf("Bob sees Alice's keys: %s", list)
	}
	// each key is charged to its own owner
	_, bobKey := makeKey(t, bob, "bob's")
	a.call(http.MethodPost, "/v1/summarize-text", bobKey, textBody())
	if n := count(t, a.db, "SELECT COALESCE(SUM(summaries),0) FROM daily_usage WHERE user_id = ?", a.userByEmail(aliceEmail).ID); n != 0 {
		t.Errorf("Bob's call was charged to Alice: %d", n)
	}
}

func TestABrowserFromAnotherSiteCannotUseAKey(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "server side")
	r := a.call(http.MethodPost, "/v1/summarize-text", key, textBody(), "Origin", "https://evil.example")
	if r.Status != http.StatusForbidden {
		t.Errorf("a web page of another site: %d %s", r.Status, r.Body)
	}
	if n := a.ai.calls.Load(); n != 0 {
		t.Errorf("no AI work for a blocked origin (%d calls)", n)
	}
}

func TestABrowserExtensionMayUseAKeyButOnlyForTheKeyRoutes(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "extension")
	extension := "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

	for _, origin := range []string{extension, "moz-extension://1234-5678"} {
		if r := a.call(http.MethodPost, "/v1/summarize-text", key, textBody(), "Origin", origin); r.Status != http.StatusOK {
			t.Errorf("%s with a key: %d %s", origin, r.Status, r.Body)
		}
	}
	// it still needs the key itself ...
	if r := a.call(http.MethodPost, "/v1/summarize-text", "", textBody(), "Origin", extension); r.Status != http.StatusForbidden {
		t.Errorf("an extension without a key: %d", r.Status)
	}
	if r := a.call(http.MethodPost, "/v1/summarize-text", "ink_notarealkey", textBody(), "Origin", extension); r.Status != http.StatusUnauthorized {
		t.Errorf("an extension with a wrong key: %d", r.Status)
	}
	// ... the other routes are for the website only ...
	if r := a.call(http.MethodPost, "/account/api-keys", key, map[string]string{"name": "x"}, "Origin", extension); r.Status != http.StatusForbidden {
		t.Errorf("an extension on an account route: %d %s", r.Status, r.Body)
	}
	if r := cl.req(http.MethodPost, "/summarize-text", textBody(), "Origin", extension); r.Status != http.StatusForbidden {
		t.Errorf("an extension with the website's cookie: %d %s", r.Status, r.Body)
	}
	// ... and an address that only looks like an extension is another site
	for _, origin := range []string{"https://chrome-extension.evil.example", "http://chrome-extension://x", "https://evil.example"} {
		if r := a.call(http.MethodPost, "/v1/summarize-text", key, textBody(), "Origin", origin); r.Status != http.StatusForbidden {
			t.Errorf("%s: %d", origin, r.Status)
		}
	}
}

func TestKeysNeedAVerifiedEmailWhenThatIsRequired(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "before")

	t.Setenv("REQUIRE_EMAIL_VERIFICATION", "true")
	if r := cl.post("/account/api-keys", map[string]string{"name": "after"}); r.Status != http.StatusForbidden || r.Str("code") != "email_not_verified" {
		t.Errorf("making a key without a verified email: %d %s", r.Status, r.Body)
	}
	if r := a.call(http.MethodPost, "/v1/summarize-text", key, textBody()); r.Status != http.StatusForbidden || r.Str("code") != "email_not_verified" {
		t.Errorf("an existing key of someone not verified: %d %s", r.Status, r.Body)
	}
	if n := a.ai.calls.Load(); n != 0 {
		t.Errorf("no AI work (%d calls)", n)
	}
}

// ---- the account --------------------------------------------------------------------------------

func TestKeysAreListedInTheExportWithoutTheKeys(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	_, key := makeKey(t, cl, "for export")
	r := cl.get("/account/export")
	if r.Status != http.StatusOK || strings.Contains(string(r.Body), key) || strings.Contains(string(r.Body), "key_hash") {
		t.Fatalf("export: %d (the key must not be in it)", r.Status)
	}
	if !strings.Contains(string(r.Body), `"apiKeys"`) || !strings.Contains(string(r.Body), "for export") || !strings.Contains(string(r.Body), key[:8]) {
		t.Errorf("the export lists the keys: %s", r.Body)
	}
}

func TestDeletingTheAccountEndsItsKeys(t *testing.T) {
	a := newApp(t)
	cl, email := a.newUser()
	_, key := makeKey(t, cl, "doomed")
	if r := cl.delete("/account", map[string]string{"confirmEmail": email, "password": goodPass}); r.Status != http.StatusOK {
		t.Fatalf("delete account: %d %s", r.Status, r.Body)
	}
	if n := count(t, a.db, "SELECT count(*) FROM api_keys"); n != 0 {
		t.Errorf("%d keys are left", n)
	}
	if r := a.call(http.MethodGet, "/v1/usage", key, nil); r.Status != http.StatusUnauthorized {
		t.Errorf("the key after the account is gone: %d", r.Status)
	}
}
