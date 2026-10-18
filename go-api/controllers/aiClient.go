package controllers

import (
	"ai-summarizer/go-api/alerts"
	"ai-summarizer/go-api/metrics"
	"ai-summarizer/go-api/middleware"
	"ai-summarizer/go-api/models"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

const (
	MaxPDFBytes   = 10 << 20 // 10 MB per PDF
	MaxMultiBytes = 25 << 20 // 25 MB across all PDFs in one multi-document request
	MaxTextBytes  = 1 << 20  // 1 MB request body for pasted text
	maxFiles      = 5
	maxTextChars  = 200_000
	maxURLChars   = 2048
	defaultWords  = 150
	minWords      = 50
	maxWords      = 1000
	maxPageLimit  = 20
	aiCallTimeout = 5 * time.Minute // a long recording is transcribed before it is summarized
)

var aiHTTPClient = &http.Client{Timeout: aiCallTimeout}

type TextPayload struct {
	Text string `json:"text"`
}

// URLPayload is a request to summarize the web page at an address.
type URLPayload struct {
	URL string `json:"url"`
}

const unsupportedFileMessage = "Only PDF, Word (.docx), PowerPoint (.pptx), audio files and photos (JPG, PNG, WebP, HEIC) are supported."

// documentExtensions are the file types that can be summarized. Only PDFs are kept as originals: the
// viewer shows PDF pages.
var documentExtensions = []string{".pdf", ".docx", ".pptx"}

// audioExtensions are recordings (and videos, of which only the sound is used). They are transcribed first, then
// summarized like any text. Transcribing costs money, so recordings are for signed-in users.
var audioExtensions = []string{".mp3", ".mpga", ".mpeg", ".m4a", ".mp4", ".wav", ".ogg", ".flac", ".webm"}

func isAudio(name string) bool {
	return contains(audioExtensions, strings.ToLower(filepath.Ext(name)))
}

// imageExtensions are photos of pages. Their text is read with OCR, which is real work on the server, so photos are
// for signed-in people. Several photos in one upload become the pages of one document. They are not kept: the text
// is, and shows what was read.
var imageExtensions = []string{".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}

func isImage(name string) bool {
	return contains(imageExtensions, strings.ToLower(filepath.Ext(name)))
}

// contentTypeOf is what a stored file is sent as: the browser must be told what it is, since it is never allowed to guess.
func contentTypeOf(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".pdf":
		return "application/pdf"
	case ".mp3", ".mpga", ".mpeg":
		return "audio/mpeg"
	case ".m4a":
		return "audio/mp4"
	case ".mp4":
		return "video/mp4"
	case ".wav":
		return "audio/wav"
	case ".ogg":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	case ".webm":
		return "audio/webm"
	}
	return "application/octet-stream"
}

func isDocumentFile(name string) bool {
	return contains(documentExtensions, strings.ToLower(filepath.Ext(name))) || isAudio(name) || isImage(name)
}

// MaxAudioBytes is the largest recording accepted: MAX_AUDIO_MB megabytes, 25 unless set (what the speech-to-text
// provider takes on its free tier; its paid tier takes 100).
func MaxAudioBytes() int64 {
	mb := 25
	if v, err := strconv.Atoi(os.Getenv("MAX_AUDIO_MB")); err == nil && v > 0 {
		mb = v
	}
	return int64(mb) << 20
}

// MaxUploadBytes is the biggest request body a signed-in person's single upload may have.
func MaxUploadBytes() int64 { return max(MaxPDFBytes, MaxAudioBytes()) }

// MaxCombinedBytes is the same across several files.
func MaxCombinedBytes() int64 { return max(MaxMultiBytes, MaxAudioBytes()) }

// signedIn reports whether the request comes from a signed-in user (the public routes have none).
func signedIn(c *gin.Context) bool {
	_, ok := c.Get(middleware.UserKey)
	return ok
}

// checkUpload rejects a file that is too big for its kind, or a recording or photo from someone who is not signed in.
// readFields are the options for the AI service, plus permission to read scanned pages (OCR) when the person is
// signed in: it is real work on the server, so the public routes do not get it.
func readFields(c *gin.Context, opts summaryOptions) map[string]string {
	fields := opts.fields()
	if signedIn(c) {
		fields["ocr"] = "true"
	}
	return fields
}

func checkUpload(c *gin.Context, name string, size int64) *apiError {
	if isAudio(name) {
		if !signedIn(c) {
			return &apiError{http.StatusUnauthorized, "Sign in to summarize a recording."}
		}
		if size > MaxAudioBytes() {
			return &apiError{http.StatusRequestEntityTooLarge, fmt.Sprintf("%s is too large (max %d MB for a recording).", name, MaxAudioBytes()>>20)}
		}
		return nil
	}
	if isImage(name) && !signedIn(c) {
		return &apiError{http.StatusUnauthorized, "Sign in to summarize a photo."}
	}
	if size > MaxPDFBytes {
		return &apiError{http.StatusRequestEntityTooLarge, name + " is too large (max 10 MB per file)."}
	}
	return nil
}

func isPDF(name string) bool {
	return strings.EqualFold(filepath.Ext(name), ".pdf")
}

// summaryResponse is what clients receive.
type summaryResponse struct {
	Filename string `json:"filename,omitempty"`
	Summary  string `json:"summary"`
	// ID is the saved document's id, when the summary was saved to the library.
	ID uint `json:"id,omitempty"`
}

// aiSummary is the AI service's reply. Text is the extracted source text, kept server-side
// so the document can be chatted with later.
type aiSummary struct {
	Filename string `json:"filename"`
	Summary  string `json:"summary"`
	Text     string `json:"text"`

	// files are the uploaded PDFs behind this summary (set by the gateway, not the AI service).
	files []storedFile
}

func (s *aiSummary) response() summaryResponse {
	return summaryResponse{Filename: s.Filename, Summary: s.Summary}
}

type summaryOptions struct {
	Words    int
	Pages    int
	Style    string
	Language string
	// Instructions are the signed-in user's standing preferences; empty for anonymous summaries.
	Instructions string
}

// maxInstructionRunes is the longest set of standing preferences a user can keep.
const maxInstructionRunes = 500

// instructionsOf returns the signed-in user's standing summary preferences, if there is a signed-in user.
func instructionsOf(c *gin.Context) string {
	if v, ok := c.Get(middleware.UserKey); ok {
		if user, ok := v.(models.User); ok {
			return user.CustomInstructions
		}
	}
	return ""
}

// apiError is a failure that can be reported to the client as-is.
type apiError struct {
	Status  int
	Message string
}

func (e *apiError) send(c *gin.Context) {
	c.JSON(e.Status, gin.H{"error": e.Message})
}

// parseSummaryParams validates the summary options; empty values fall back to defaults.
func parseSummaryParams(wordCount, pageLimit, style, language string) (summaryOptions, *apiError) {
	opts := summaryOptions{Words: defaultWords, Style: defaultStyle, Language: defaultLanguage}

	if wordCount != "" {
		n, err := strconv.Atoi(wordCount)
		if err != nil || n < minWords || n > maxWords {
			return opts, &apiError{http.StatusBadRequest, fmt.Sprintf("Word count must be between %d and %d.", minWords, maxWords)}
		}
		opts.Words = n
	}
	if pageLimit != "" {
		n, err := strconv.Atoi(pageLimit)
		if err != nil || n < 0 || n > maxPageLimit {
			return opts, &apiError{http.StatusBadRequest, fmt.Sprintf("Page limit must be between 0 and %d.", maxPageLimit)}
		}
		opts.Pages = n
	}
	if style != "" {
		if !contains(summaryStyles, style) {
			return opts, &apiError{http.StatusBadRequest, "Unknown summary style."}
		}
		opts.Style = style
	}
	if language != "" {
		if !contains(summaryLanguages, language) {
			return opts, &apiError{http.StatusBadRequest, "Unsupported language."}
		}
		opts.Language = language
	}
	return opts, nil
}

func (o summaryOptions) fields() map[string]string {
	fields := map[string]string{
		"word_count": strconv.Itoa(o.Words),
		"page_limit": strconv.Itoa(o.Pages),
		"style":      o.Style,
		"language":   o.Language,
	}
	if o.Instructions != "" {
		fields["instructions"] = o.Instructions
	}
	return fields
}

// prepareAIRequest adds what the AI service expects on every call from the gateway: the request id,
// so its logs can be matched to ours, and the shared secret (AI_SERVICE_TOKEN) when one is set.
// The secret matters when the AI service is reachable from the internet, as on most hosting
// platforms' free tiers: without it anyone who found the URL could spend the model quota.
func prepareAIRequest(c *gin.Context, req *http.Request) {
	setAIHeaders(req, middleware.RequestIDFrom(c))
}

// setAIHeaders is prepareAIRequest for work that outlives a request (indexing a saved document),
// where only the request id is at hand.
func setAIHeaders(req *http.Request, requestID string) {
	if requestID != "" {
		req.Header.Set(middleware.RequestIDHeader, requestID)
	}
	if token := os.Getenv("AI_SERVICE_TOKEN"); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
}

// aiServiceURL is the full URL of an AI service path. AI_SERVICE_URL may omit the scheme (hosting
// platforms often hand out just "host:port" for private networking); http:// is assumed then.
func aiServiceURL(path string) string {
	base := strings.TrimRight(os.Getenv("AI_SERVICE_URL"), "/")
	if base != "" && !strings.Contains(base, "://") {
		base = "http://" + base
	}
	return base + path
}

// callAIService performs the request and returns the raw body of a successful reply.
// Failures from the AI service are mapped to client-safe errors.
func callAIService(req *http.Request) ([]byte, *apiError) {
	started := time.Now()
	resp, err := aiHTTPClient.Do(req)
	if err != nil {
		metrics.AIRequest(req.URL.Path, "unavailable", time.Since(started))
		alerts.Default.AIResult(true)
		return nil, &apiError{http.StatusGatewayTimeout, "The AI service is unavailable or took too long to respond."}
	}
	defer func() { _ = resp.Body.Close() }()
	metrics.AIRequest(req.URL.Path, aiOutcome(resp.StatusCode), time.Since(started))
	alerts.Default.AIResult(aiFailed(resp.StatusCode))

	// Summaries echo the source text back (to be stored for chat), so allow more than a summary needs.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, &apiError{http.StatusBadGateway, "Failed to read the AI service response."}
	}

	if resp.StatusCode != http.StatusOK {
		return nil, upstreamError(resp.StatusCode, body)
	}
	return body, nil
}

// aiOutcome is the metrics label for an AI service reply.
// aiFailed says whether a reply means the AI service is in trouble (a server error), as opposed to refusing what it was
// sent (a 4xx, which is the caller's doing) or the busy answer (503 with its own message, which the service gives on purpose).
func aiFailed(status int) bool {
	return status >= http.StatusInternalServerError && status != http.StatusServiceUnavailable
}

func aiOutcome(status int) string {
	if status == http.StatusOK {
		return "ok"
	}
	return "upstream_error"
}

// upstreamError maps a failed AI service reply to a client-safe error: its own 4xx messages are
// passed through, anything else becomes a generic 502 so internals never leak.
func upstreamError(status int, body []byte) *apiError {
	var detail struct {
		Detail string `json:"detail"`
	}
	_ = json.Unmarshal(body, &detail)
	// 4xx are the caller's problem and 503 is the AI service's own "busy" message; both are
	// written by us, so they are safe to show. Any other 5xx stays generic.
	if (status >= 400 && status < 500 || status == http.StatusServiceUnavailable) && detail.Detail != "" {
		return &apiError{status, detail.Detail}
	}
	return &apiError{http.StatusBadGateway, "The AI service failed to produce a response."}
}

func callForSummary(req *http.Request) (*aiSummary, *apiError) {
	body, apiErr := callAIService(req)
	if apiErr != nil {
		return nil, apiErr
	}
	var out aiSummary
	if err := json.Unmarshal(body, &out); err != nil || strings.TrimSpace(out.Summary) == "" {
		return nil, &apiError{http.StatusBadGateway, "The AI service returned an empty summary."}
	}
	return &out, nil
}

// multipartRequest builds a POST to the AI service with form fields and PDF files
// (sent under fileField, once per file).
func multipartRequest(c *gin.Context, path string, fields map[string]string, fileField string, files []*multipart.FileHeader) (*aiRequest, *apiError) {
	prepErr := &apiError{http.StatusInternalServerError, "Failed to prepare the request."}
	var kept []storedFile

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			return nil, prepErr
		}
	}
	for _, fh := range files {
		src, err := fh.Open()
		if err != nil {
			return nil, &apiError{http.StatusBadRequest, "Could not read the uploaded file."}
		}
		data, err := io.ReadAll(src)
		_ = src.Close()
		if err != nil {
			return nil, prepErr
		}
		part, err := w.CreateFormFile(fileField, fh.Filename)
		if err == nil {
			_, err = part.Write(data)
		}
		if err != nil {
			return nil, prepErr
		}
		// PDFs (for the viewer) and recordings (to play back) are kept with the summary, if it is saved.
		if isPDF(fh.Filename) || isAudio(fh.Filename) {
			kept = append(kept, storedFile{Name: fh.Filename, Data: data})
		}
	}
	if err := w.Close(); err != nil {
		return nil, prepErr
	}

	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, aiServiceURL(path), &buf)
	if err != nil {
		return nil, prepErr
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	prepareAIRequest(c, req)
	return &aiRequest{req: req, files: kept}, nil
}

// aiRequest is a prepared call to the AI service. sourceText is set when the caller already
// holds the source text (pasted text); for PDFs the AI service returns it.
type aiRequest struct {
	req        *http.Request
	sourceText string
	// files are the uploaded PDFs, kept so they can be stored with the summary.
	files []storedFile
}

// summaryBuilder validates a client request and prepares the matching AI service call.
// With stream set, the AI service replies with server-sent events instead of one JSON body.
type summaryBuilder func(c *gin.Context, stream bool) (*aiRequest, *apiError)

func withStream(path string, stream bool) string {
	if stream {
		return path + "?stream=true"
	}
	return path
}

// buffered runs a builder and waits for the complete summary.
func buffered(build summaryBuilder) func(*gin.Context) (*aiSummary, *apiError) {
	return func(c *gin.Context) (*aiSummary, *apiError) {
		ar, apiErr := build(c, false)
		if apiErr != nil {
			return nil, apiErr
		}
		result, apiErr := callForSummary(ar.req)
		if apiErr != nil {
			return nil, apiErr
		}
		if ar.sourceText != "" {
			result.Text = ar.sourceText
		}
		result.files = ar.files
		return result, nil
	}
}

func buildFileRequest(c *gin.Context, stream bool) (*aiRequest, *apiError) {
	opts, perr := parseSummaryParams(c.PostForm("wordCount"), c.PostForm("pageLimit"), c.PostForm("style"), c.PostForm("language"))
	if perr != nil {
		return nil, perr
	}
	opts.Instructions = instructionsOf(c)

	file, err := c.FormFile("file")
	if err != nil {
		return nil, &apiError{http.StatusBadRequest, "A PDF, Word, PowerPoint, audio or photo file is required."}
	}
	if !isDocumentFile(file.Filename) {
		return nil, &apiError{http.StatusBadRequest, unsupportedFileMessage}
	}
	if apiErr := checkUpload(c, file.Filename, file.Size); apiErr != nil {
		return nil, apiErr
	}

	return multipartRequest(c, withStream("/summarize", stream), readFields(c, opts), "file", []*multipart.FileHeader{file})
}

func buildFilesRequest(c *gin.Context, stream bool) (*aiRequest, *apiError) {
	opts, perr := parseSummaryParams(c.PostForm("wordCount"), c.PostForm("pageLimit"), c.PostForm("style"), c.PostForm("language"))
	if perr != nil {
		return nil, perr
	}
	opts.Instructions = instructionsOf(c)

	files, apiErr := checkedUploads(c)
	if apiErr != nil {
		return nil, apiErr
	}
	return multipartRequest(c, withStream("/summarize-multiple", stream), readFields(c, opts), "files", files)
}

// checkedUploads is the "files" part of a multipart request, once it has been checked: how many, what kind, how big.
func checkedUploads(c *gin.Context) ([]*multipart.FileHeader, *apiError) {
	form, err := c.MultipartForm()
	if err != nil {
		return nil, &apiError{http.StatusBadRequest, "Invalid upload."}
	}
	files := form.File["files"]
	if len(files) == 0 || len(files) > maxFiles {
		return nil, &apiError{http.StatusBadRequest, fmt.Sprintf("Upload between 1 and %d files.", maxFiles)}
	}
	var total int64
	for _, f := range files {
		if !isDocumentFile(f.Filename) {
			return nil, &apiError{http.StatusBadRequest, unsupportedFileMessage}
		}
		if apiErr := checkUpload(c, f.Filename, f.Size); apiErr != nil {
			return nil, apiErr
		}
		total += f.Size
	}
	if total > MaxCombinedBytes() {
		return nil, &apiError{http.StatusRequestEntityTooLarge, fmt.Sprintf("The files are too large together (max %d MB).", MaxCombinedBytes()>>20)}
	}
	return files, nil
}

// buildURLRequest sends a web address to the AI service, which fetches and reads the page itself (it is
// the one place that checks the address is on the public internet).
func buildURLRequest(c *gin.Context, stream bool) (*aiRequest, *apiError) {
	opts, perr := parseSummaryParams(c.Query("wordCount"), c.Query("pageLimit"), c.Query("style"), c.Query("language"))
	if perr != nil {
		return nil, perr
	}
	opts.Instructions = instructionsOf(c)

	address, apiErr := webAddressOf(c)
	if apiErr != nil {
		return nil, apiErr
	}

	body, err := json.Marshal(URLPayload{URL: address})
	if err != nil {
		return nil, &apiError{http.StatusInternalServerError, "Failed to prepare the request."}
	}
	q := url.Values{}
	for k, v := range readFields(c, opts) {
		q.Set(k, v)
	}
	if stream {
		q.Set("stream", "true")
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, aiServiceURL("/summarize-url?"+q.Encode()), bytes.NewReader(body))
	if err != nil {
		return nil, &apiError{http.StatusInternalServerError, "Failed to prepare the request."}
	}
	req.Header.Set("Content-Type", "application/json")
	prepareAIRequest(c, req)
	return &aiRequest{req: req}, nil
}

// webAddressOf reads the web address from a JSON request body and checks that it looks like one. Whether it may be
// opened at all (that it is on the public internet) is for the AI service to decide, since it is the one that opens it.
func webAddressOf(c *gin.Context) (string, *apiError) {
	var payload URLPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		return "", &apiError{http.StatusBadRequest, "Invalid request body."}
	}
	return cleanWebAddress(payload.URL)
}

// cleanWebAddress checks that text looks like an http or https address, and returns it trimmed.
func cleanWebAddress(raw string) (string, *apiError) {
	address := strings.TrimSpace(raw)
	if address == "" {
		return "", &apiError{http.StatusBadRequest, "A web address is required."}
	}
	if utf8.RuneCountInString(address) > maxURLChars || strings.ContainsAny(address, " \t\r\n") {
		return "", &apiError{http.StatusBadRequest, "That does not look like a web address."}
	}
	if scheme, _, found := strings.Cut(address, "://"); found && !strings.EqualFold(scheme, "http") && !strings.EqualFold(scheme, "https") {
		return "", &apiError{http.StatusBadRequest, "Only http and https web addresses are supported."}
	}
	return address, nil
}

func buildTextRequest(c *gin.Context, stream bool) (*aiRequest, *apiError) {
	opts, perr := parseSummaryParams(c.Query("wordCount"), c.Query("pageLimit"), c.Query("style"), c.Query("language"))
	if perr != nil {
		return nil, perr
	}
	opts.Instructions = instructionsOf(c)

	var payload TextPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		return nil, &apiError{http.StatusBadRequest, "Invalid request body."}
	}
	if strings.TrimSpace(payload.Text) == "" {
		return nil, &apiError{http.StatusBadRequest, "Text is required."}
	}
	if utf8.RuneCountInString(payload.Text) > maxTextChars {
		return nil, &apiError{http.StatusRequestEntityTooLarge, fmt.Sprintf("Text is too long (max %d characters).", maxTextChars)}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, &apiError{http.StatusInternalServerError, "Failed to prepare the request."}
	}
	q := url.Values{}
	for k, v := range opts.fields() {
		q.Set(k, v)
	}
	if stream {
		q.Set("stream", "true")
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, aiServiceURL("/summarize-text?"+q.Encode()), bytes.NewReader(body))
	if err != nil {
		return nil, &apiError{http.StatusInternalServerError, "Failed to prepare the request."}
	}
	req.Header.Set("Content-Type", "application/json")
	prepareAIRequest(c, req)
	return &aiRequest{req: req, sourceText: payload.Text}, nil
}
