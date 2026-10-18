package server

// Shared test harness: the real router served over real HTTP, a Postgres schema of its own, a fake
// mail provider that records what would have been sent, and a fake AI service.

import (
	"ai-summarizer/go-api/auth"
	"ai-summarizer/go-api/controllers"
	"ai-summarizer/go-api/mailer"
	"ai-summarizer/go-api/models"
	"ai-summarizer/go-api/testutil"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"hash/fnv"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const (
	appOrigin = "http://app.test"
	goodPass  = "Correct-horse-9"
)

// ---- fake mail ---------------------------------------------------------------------------

type sentMail struct{ To, Subject, Text string }

type fakeMailer struct {
	mu   sync.Mutex
	sent []sentMail
}

func (f *fakeMailer) Send(_ context.Context, m mailer.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, sentMail{m.To, m.Subject, m.Text})
	return nil
}

func (f *fakeMailer) all() []sentMail {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sentMail(nil), f.sent...)
}

// waitFor blocks until at least n emails were sent (emails go out in the background).
func (f *fakeMailer) waitFor(t *testing.T, n int) []sentMail {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if got := f.all(); len(got) >= n {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected %d email(s), got %d: %+v", n, len(f.all()), f.all())
	return nil
}

var tokenRE = regexp.MustCompile(`token=([A-Za-z0-9_%\-]+)`)

// tokenIn extracts the token from the link in an email.
func tokenIn(t *testing.T, m sentMail) string {
	t.Helper()
	match := tokenRE.FindStringSubmatch(m.Text)
	if match == nil {
		t.Fatalf("no token link in email %q:\n%s", m.Subject, m.Text)
	}
	tok, err := url.QueryUnescape(match[1])
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

// ---- fake AI service ---------------------------------------------------------------------

type fakeAI struct {
	calls atomic.Int32
	// indexCalls counts /passages calls, kept apart so tests can count the work that costs a model call.
	indexCalls atomic.Int32
	fail       atomic.Bool
	// lastAsk is the most recent /ask request body, to see which passages were sent.
	lastAsk atomic.Value
	// lastCompare is the most recent /compare request body; compareReply, when set, is what /compare answers instead
	// of a normal comparison (to see how the gateway treats a strange reply).
	lastCompare  atomic.Value
	compareReply atomic.Value
	// lastExtract is the most recent /extract request body; extractReply, when set, replaces the normal answer.
	lastExtract  atomic.Value
	extractReply atomic.Value
	// streamError makes streamed summaries end with an error event.
	streamError atomic.Bool
	// embedOn makes /embed work (off, it answers 503 like a service with embeddings switched off).
	// embedCalls counts /embed calls, and embedModel names the model it reports (default "fake-model").
	embedOn    atomic.Bool
	embedCalls atomic.Int32
	embedModel atomic.Value
	// lastSummary is the query string and body of the most recent /summarize* call, to see which options
	// reached the AI service. suggestCalls and studyCalls count the calls that make questions and study material.
	lastSummary  atomic.Value
	suggestCalls atomic.Int32
	studyCalls   atomic.Int32
	// lastStudy is the most recent /study request body, to see what the model was given to make cards from.
	lastStudy atomic.Value
	// The page a link opens (/read-url): readText is its text (a short default when empty), readFail makes it unreadable,
	// readCalls counts the opens and lastReadQuery is the query of the latest (to see that a watch asked for the robots check).
	// compareFail makes /compare fail, compareCalls counts its calls.
	readText      atomic.Value
	readFail      atomic.Bool
	readCalls     atomic.Int32
	lastReadQuery atomic.Value
	compareFail   atomic.Bool
	compareCalls  atomic.Int32
	// datesCalls counts /dates calls, datesReply (when set) replaces its answer, lastDates is the latest request body.
	datesCalls atomic.Int32
	// checklistCalls counts /checklist calls, checklistReply (when set) replaces its answer, lastChecklist is the latest request.
	checklistCalls atomic.Int32
	// voiceCalls counts /transcribe-voice calls.
	voiceCalls     atomic.Int32
	checklistReply atomic.Value
	lastChecklist  atomic.Value
	datesReply     atomic.Value
	lastDates      atomic.Value
}

// meaningOf stands in for an embedding model: words of the same group ("cat", "dog", "pet") share a
// bucket, so a question about pets is close to a passage about cats and dogs without sharing a word.
var meaningGroups = map[string]string{
	"cat": "pet", "cats": "pet", "dog": "pet", "dogs": "pet", "pet": "pet", "pets": "pet", "animal": "pet", "animals": "pet",
	"rent": "money", "pay": "money", "payment": "money", "cost": "money", "price": "money", "fee": "money", "euros": "money",
}

const fakeEmbedDim = 64

var fakeStopWords = map[string]bool{"can": true, "the": true, "and": true, "are": true, "not": true, "for": true, "how": true, "what": true, "with": true, "from": true, "this": true, "that": true, "does": true, "much": true}

func fakeEmbedding(text string) string {
	vec := make([]float32, fakeEmbedDim)
	for _, w := range regexp.MustCompile(`\p{L}+`).FindAllString(strings.ToLower(text), -1) {
		if len(w) <= 2 || fakeStopWords[w] {
			continue
		}
		if g, ok := meaningGroups[w]; ok {
			w = g
		}
		h := fnv.New32a()
		_, _ = h.Write([]byte(w))
		vec[h.Sum32()%fakeEmbedDim]++
	}
	var norm float64
	for _, v := range vec {
		norm += float64(v) * float64(v)
	}
	raw := make([]byte, 0, fakeEmbedDim*4)
	for _, v := range vec {
		if norm > 0 {
			v = float32(float64(v) / math.Sqrt(norm))
		}
		raw = binary.LittleEndian.AppendUint32(raw, math.Float32bits(v))
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func (f *fakeAI) embed(w http.ResponseWriter, r *http.Request) {
	f.embedCalls.Add(1)
	if !f.embedOn.Load() {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"detail":"Embeddings are turned off"}`))
		return
	}
	var in struct {
		Texts []string `json:"texts"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	vectors := make([]string, len(in.Texts))
	for i, t := range in.Texts {
		vectors[i] = fakeEmbedding(t)
	}
	model, _ := f.embedModel.Load().(string)
	if model == "" {
		model = "fake-model"
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"model": model, "dim": fakeEmbedDim, "minScore": 0.3, "vectors": vectors})
}

func (f *fakeAI) handler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/embed" {
		f.embed(w, r)
		return
	}
	if r.URL.Path == "/passages" {
		f.indexCalls.Add(1)
		var in struct {
			Text string `json:"text"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		// One passage per blank-line-separated paragraph; page numbers follow form feeds like the real service.
		var passages []map[string]any
		for i, para := range strings.Split(in.Text, "\n\n") {
			if strings.TrimSpace(para) != "" {
				passages = append(passages, map[string]any{"text": para, "page": i + 1, "pageEnd": i + 1, "document": nil})
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"passages": passages})
		return
	}
	f.calls.Add(1)
	if strings.HasPrefix(r.URL.Path, "/summarize") || r.URL.Path == "/overview" {
		raw, _ := io.ReadAll(r.Body)
		f.lastSummary.Store(r.URL.RawQuery + "\n" + string(raw))
	}
	switch r.URL.Path {
	case "/suggest":
		f.suggestCalls.Add(1)
	case "/study":
		f.studyCalls.Add(1)
	}
	if f.fail.Load() {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"detail":"internal traceback"}`))
		return
	}
	if r.URL.Query().Get("stream") == "true" {
		w.Header().Set("Content-Type", "text/event-stream")
		events := []string{`{"type":"status","stage":"preparing"}`, `{"type":"delta","text":"fake "}`}
		if f.streamError.Load() {
			events = append(events, `{"type":"error","status":502,"message":"The language model failed to produce a summary. Please try again."}`)
		} else {
			done := `{"type":"done","text":"the source text"}`
			if r.URL.Path == "/summarize-url" {
				done = `{"type":"done","filename":"Fake Page Title","text":"the page text"}`
			}
			events = append(events, `{"type":"delta","text":"summary"}`, done)
		}
		for _, e := range events {
			_, _ = w.Write([]byte("data: " + e + "\n\n"))
			w.(http.Flusher).Flush()
		}
		return
	}
	switch r.URL.Path {
	case "/chat":
		_, _ = w.Write([]byte(`{"answer":"fake answer [1]","sources":[{"id":1,"text":"the cited passage","page":2,"pageEnd":3,"document":"report.pdf"}]}`))
	case "/podcast":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"title": "Fake episode",
			"turns": []map[string]string{
				{"speaker": "A", "text": "So what is this about?"}, {"speaker": "B", "text": "It is a fake document."},
				{"speaker": "A", "text": "Anything else?"}, {"speaker": "B", "text": "Not really."},
			},
		})
	case "/ask":
		raw, _ := io.ReadAll(r.Body)
		f.lastAsk.Store(raw)
		var in struct {
			Passages []map[string]any `json:"passages"`
		}
		_ = json.Unmarshal(raw, &in)
		cited := []map[string]any{}
		if len(in.Passages) > 0 {
			cited = append(cited, in.Passages[0])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"answer": "library answer [1]", "sources": cited})
	case "/suggest":
		_, _ = w.Write([]byte(`{"questions":["What is this about?","Who wrote it?","When was it written?","Why does it matter?"]}`))
	case "/read":
		_, _ = w.Write([]byte(`{"filename":"notes.pdf","text":"the uploaded text"}`))
	case "/read-url":
		f.readCalls.Add(1)
		f.lastReadQuery.Store(r.URL.RawQuery)
		if f.readFail.Load() {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"detail":"That page was not found (it may have moved or been removed)."}`))
			return
		}
		text := "the page text"
		if v, _ := f.readText.Load().(string); v != "" {
			text = v
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"filename": "Fake Page Title", "text": text})
	case "/study":
		raw, _ := io.ReadAll(r.Body)
		f.lastStudy.Store(raw)
		var in struct {
			Kind string `json:"kind"`
		}
		_ = json.Unmarshal(raw, &in)
		if in.Kind == "quiz" {
			_, _ = w.Write([]byte(`{"kind":"quiz","questions":[` +
				`{"question":"One?","options":["a","b","c","d"],"answer":1,"explanation":"Because."},` +
				`{"question":"Two?","options":["e","f","g","h"],"answer":3,"explanation":"Since."},` +
				`{"question":"Three?","options":["i","j","k","l"],"answer":0,"explanation":"As."}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"kind":"flashcards","cards":[{"front":"Front one","back":"Back one"},{"front":"Front two","back":"Back two"},{"front":"Front three","back":"Back three"}]}`))
	case "/extract":
		raw, _ := io.ReadAll(r.Body)
		f.lastExtract.Store(raw)
		if override, _ := f.extractReply.Load().(string); override != "" {
			_, _ = w.Write([]byte(override))
			return
		}
		var in struct {
			Fields []struct{ Name, Type string } `json:"fields"`
		}
		_ = json.Unmarshal(raw, &in)
		results := []map[string]any{}
		for _, field := range in.Fields {
			results = append(results, map[string]any{
				"name": field.Name, "type": field.Type, "value": "Value of " + field.Name, "quote": "Quote of " + field.Name,
				"page": 1, "found": true, "verified": true, "reason": "",
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"name": "doc", "fields": results, "suspicious": false})
	case "/transcribe-voice":
		f.voiceCalls.Add(1)
		_, _ = w.Write([]byte(`{"text":"  What does the   lease say about the deposit? ","language":"en"}`))
	case "/checklist":
		f.checklistCalls.Add(1)
		raw, _ := io.ReadAll(r.Body)
		f.lastChecklist.Store(raw)
		if override, _ := f.checklistReply.Load().(string); override != "" {
			_, _ = w.Write([]byte(override))
			return
		}
		_, _ = w.Write([]byte(`{"kind":"lease","items":[` +
			`{"id":"rent","status":"found","value":"950 euros per month","quote":"The tenant pays 950 euros per month.","page":1,"reason":""},` +
			`{"id":"deposit","status":"unclear","value":"two months","quote":"a deposit","page":null,"reason":"The value was not found in the quote."},` +
			`{"id":"pets","status":"missing","value":"","quote":"","page":null,"reason":""}],` +
			`"counts":{"found":1,"unclear":1,"missing":1},` +
			`"unusual":[{"what":"The lease renews by itself.","quote":"renews automatically","page":1}],"unusualChecked":true,"suspicious":false}`))
	case "/dates":
		f.datesCalls.Add(1)
		raw, _ := io.ReadAll(r.Body)
		f.lastDates.Store(raw)
		if override, _ := f.datesReply.Load().(string); override != "" {
			_, _ = w.Write([]byte(override))
			return
		}
		_, _ = w.Write([]byte(`{"dates":[` +
			`{"what":"Lease ends","date":"2027-02-28","repeat":"none","relative":"","quote":"The lease ends on 28 February 2027.","page":null,"verified":true,"reason":""},` +
			`{"what":"Rent is due","date":null,"repeat":"monthly","relative":"the first day of each month","quote":"Rent is due on the first day of each month.","page":1,"verified":true,"reason":""}` +
			`],"suspicious":false,"sentences":2}`))
	case "/compare":
		f.compareCalls.Add(1)
		if f.compareFail.Load() {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"detail":"The language model is unavailable."}`))
			return
		}
		raw, _ := io.ReadAll(r.Body)
		f.lastCompare.Store(raw)
		if override, _ := f.compareReply.Load().(string); override != "" {
			_, _ = w.Write([]byte(override))
			return
		}
		_, _ = w.Write([]byte(`{"identical":false,"counts":{"added":1,"removed":0,"changed":1,"moved":0},"changes":[` +
			`{"id":1,"kind":"changed","before":"Payment is due within 30 days.","after":"Payment is due within 60 days.","beforePage":1,"afterPage":1,` +
			`"segments":[["eq","Payment is due within "],["del","30"],["ins","60"],["eq"," days."]],"numbers":{"removed":["30"],"added":["60"]},` +
			`"importance":"high","summary":"The payment window doubles.","impact":"Slower cash for the supplier.","explained":true},` +
			`{"id":2,"kind":"added","before":"","after":"Records are kept for seven years.","beforePage":null,"afterPage":2,"segments":null,` +
			`"numbers":{"removed":[],"added":["7"]},"importance":"medium","summary":"A record-keeping duty was added.","impact":"More admin.","explained":true}],` +
			`"bottomLine":"Payment terms changed and a duty was added.","explained":true,"omitted":0}`))
	case "/proof":
		_, _ = w.Write([]byte(`{"sentences":[{"text":"Overview","kind":"heading","support":null,"coverage":0,"missingNumbers":[],"passages":[]},{"text":"A claim that is backed.","kind":"claim","support":"strong","coverage":0.9,"missingNumbers":[],"passages":[{"id":1,"text":"The backing passage.","page":2,"pageEnd":2,"coverage":0.9}]}],"claims":1,"found":1,"partly":0,"notFound":0,"verifiable":true}`))
	case "/healthz":
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	case "/summarize-url":
		_, _ = w.Write([]byte(`{"filename":"Fake Page Title","summary":"fake url summary","text":"the page text"}`))
	default:
		_, _ = w.Write([]byte(`{"summary":"fake summary (` + r.URL.RawQuery + `)"}`))
	}
}

// ---- the app ------------------------------------------------------------------------------

type app struct {
	t    *testing.T
	srv  *httptest.Server
	db   *gorm.DB
	ai   *fakeAI
	mail *fakeMailer
}

var generousRates = Rates{
	AuthPerMinute: 1000, AuthBurst: 1000,
	SummarizeIPPerMinute: 1000, SummarizeIPBurst: 1000,
	SummarizeUserPerMinute: 1000, SummarizeUserBurst: 1000,
	ChatPerMinute: 1000, ChatBurst: 1000,
	ExportPerMinute: 1000, ExportBurst: 1000,
	ReviewPerMinute: 1000, ReviewBurst: 1000,
}

func newApp(t *testing.T) *app { return newAppWithRates(t, generousRates) }

func newAppWithRates(t *testing.T, rates Rates) *app {
	t.Helper()
	db := testutil.DB(t, "srvtest")

	t.Setenv("CORS_ALLOWED_ORIGINS", appOrigin)
	t.Setenv("FRONTEND_URL", appOrigin)
	for _, k := range []string{"TURNSTILE_SECRET", "REQUIRE_EMAIL_VERIFICATION", "QUOTA_SUMMARIES_PER_DAY", "QUOTA_CHAT_PER_DAY"} {
		t.Setenv(k, "")
	}
	// The spending guard is off unless a test turns it on (guard_test.go).
	t.Setenv("ANON_SUMMARIES_PER_DAY", "0")
	t.Setenv("AI_REQUESTS_PER_DAY", "0")

	controllers.ResetEmbeddingBackoff()
	ai := &fakeAI{}
	aiSrv := httptest.NewServer(http.HandlerFunc(ai.handler))
	t.Cleanup(aiSrv.Close)
	t.Setenv("AI_SERVICE_URL", aiSrv.URL)

	oldCookie, oldMail := auth.Cookie, controllers.Mail
	auth.Cookie = auth.CookieConfig{Secure: false, SameSite: http.SameSiteLaxMode}
	mail := &fakeMailer{}
	controllers.Mail = mail
	t.Cleanup(func() { auth.Cookie, controllers.Mail = oldCookie, oldMail })

	gin.SetMode(gin.TestMode)
	router, err := NewRouter(slog.New(slog.NewTextHandler(io.Discard, nil)), rates)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)

	return &app{t: t, srv: srv, db: db, ai: ai, mail: mail}
}

// ---- a browser-like client ---------------------------------------------------------------

type client struct {
	a      *app
	http   *http.Client
	origin string // sent as the Origin header on state-changing requests, like a browser does
}

func (a *app) newClient() *client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		a.t.Fatal(err)
	}
	return &client{
		a:      a,
		origin: appOrigin,
		http: &http.Client{
			Jar:           jar,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

type reply struct {
	Status int
	Header http.Header
	Body   []byte
}

func (r reply) JSON() map[string]any {
	var out map[string]any
	_ = json.Unmarshal(r.Body, &out)
	return out
}

func (r reply) Str(key string) string {
	s, _ := r.JSON()[key].(string)
	return s
}

func (r reply) cookies() []*http.Cookie { return (&http.Response{Header: r.Header}).Cookies() }

func (r reply) cookie(name string) *http.Cookie {
	for _, c := range r.cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// req performs a request. body may be nil, a string (sent as is) or anything JSON-encodable;
// headers are key, value pairs.
func (cl *client) req(method, path string, body any, headers ...string) reply {
	cl.a.t.Helper()
	var reader io.Reader
	contentType := ""
	switch b := body.(type) {
	case nil:
	case string:
		reader, contentType = bytes.NewBufferString(b), "application/json"
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			cl.a.t.Fatal(err)
		}
		reader, contentType = bytes.NewReader(raw), "application/json"
	}

	req, err := http.NewRequest(method, cl.a.srv.URL+path, reader)
	if err != nil {
		cl.a.t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if cl.origin != "" && method != http.MethodGet && method != http.MethodHead {
		req.Header.Set("Origin", cl.origin)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}

	resp, err := cl.http.Do(req)
	if err != nil {
		cl.a.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, _ := io.ReadAll(resp.Body)
	return reply{resp.StatusCode, resp.Header, data}
}

func (cl *client) get(path string) reply              { return cl.req(http.MethodGet, path, nil) }
func (cl *client) post(path string, body any) reply   { return cl.req(http.MethodPost, path, body) }
func (cl *client) put(path string, body any) reply    { return cl.req(http.MethodPut, path, body) }
func (cl *client) delete(path string, body any) reply { return cl.req(http.MethodDelete, path, body) }

// sessionToken returns the raw session token the client currently holds.
func (cl *client) sessionToken() string {
	u, _ := url.Parse(cl.a.srv.URL)
	for _, c := range cl.http.Jar.Cookies(u) {
		if c.Name == auth.CookieName {
			return c.Value
		}
	}
	return ""
}

// ---- account helpers ----------------------------------------------------------------------

var emailCounter atomic.Int32

func uniqueEmail() string {
	return "user" + time.Now().Format("150405") + "-" + string('a'+emailCounter.Add(1)%26) + string('a'+(emailCounter.Load()/26)%26) + "@example.com"
}

// signup creates an account (unverified) and returns its email.
func (a *app) signup(email string) {
	a.t.Helper()
	cl := a.newClient()
	if r := cl.post("/signup", map[string]string{"email": email, "password": goodPass}); r.Status != http.StatusOK {
		a.t.Fatalf("signup %s: %d %s", email, r.Status, r.Body)
	}
}

// login signs the client in and fails the test otherwise.
func (a *app) login(cl *client, email, password string) {
	a.t.Helper()
	if r := cl.post("/login", map[string]string{"email": email, "password": password}); r.Status != http.StatusOK {
		a.t.Fatalf("login %s: %d %s", email, r.Status, r.Body)
	}
}

// newUser signs up and logs in, returning a signed-in client and the account's email.
func (a *app) newUser() (*client, string) {
	a.t.Helper()
	email := uniqueEmail()
	a.signup(email)
	cl := a.newClient()
	a.login(cl, email, goodPass)
	return cl, email
}

func (a *app) userByEmail(email string) models.User {
	a.t.Helper()
	var u models.User
	if err := a.db.Unscoped().First(&u, "email = ?", email).Error; err != nil {
		a.t.Fatalf("user %s: %v", email, err)
	}
	return u
}

func count(t *testing.T, db *gorm.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.Raw(query, args...).Scan(&n).Error; err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

var itoa = strconv.Itoa
