package controllers

import (
	"ai-summarizer/go-api/middleware"
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// Talking to a document: a question spoken into the microphone is turned into text here, and the page then asks it of the
// document or the library like any typed question (so it is that question that counts against the daily chat allowance, with
// the same sources). The clip is short, is forwarded to the speech-to-text service and is not kept.
const (
	// MaxVoiceBytes is the biggest clip taken: a minute of speech is about a fifth of this.
	MaxVoiceBytes = 1 << 20
	// VoiceBodyBytes is a little more than the clip, for the rest of the multipart request.
	VoiceBodyBytes = MaxVoiceBytes + 64<<10
	maxVoiceChars  = 1000
)

// TranscribeVoice answers with what was said in a short recording ({"audio": file}): {"text"}. It uses the site's AI budget
// (it is real work) and the chat rate limit, but not the person's daily allowance.
func TranscribeVoice(c *gin.Context) {
	header, err := c.FormFile("audio")
	if err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Send a short recording as \"audio\"."})
		return
	}
	name := header.Filename
	if !isAudio(name) {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "That is not an audio file."})
		return
	}
	if header.Size > MaxVoiceBytes {
		middleware.RefundQuota(c)
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "That question is too long to listen to. Keep it under a minute."})
		return
	}
	file, err := header.Open()
	if err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Could not read that recording."})
		return
	}
	defer func() { _ = file.Close() }()

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreatePart(textproto.MIMEHeader{
		"Content-Disposition": {`form-data; name="file"; filename="` + safeVoiceName(name) + `"`},
		"Content-Type":        {contentTypeOf(name)},
	})
	if err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare the request."})
		return
	}
	if _, err := io.Copy(part, io.LimitReader(file, MaxVoiceBytes+1)); err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Could not read that recording."})
		return
	}
	_ = form.Close()

	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, aiServiceURL("/transcribe-voice"), &body)
	if err != nil {
		middleware.RefundQuota(c)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare the request."})
		return
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	prepareAIRequest(c, req)
	reply, apiErr := callAIService(req)
	if apiErr != nil {
		middleware.RefundQuota(c)
		apiErr.send(c)
		return
	}
	var out struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(reply, &out) != nil || strings.TrimSpace(out.Text) == "" {
		middleware.RefundQuota(c)
		c.JSON(http.StatusBadGateway, gin.H{"error": "The AI service returned no words."})
		return
	}
	text := cleanLine(out.Text)
	if utf8.RuneCountInString(text) > maxVoiceChars {
		text = clip(text, maxVoiceChars)
	}
	c.JSON(http.StatusOK, gin.H{"text": text})
}

// safeVoiceName is the clip's name with no folders and no characters that could break the header it goes in.
func safeVoiceName(name string) string {
	base := filepath.Base(strings.ReplaceAll(name, `\`, "/"))
	var out strings.Builder
	for _, r := range base {
		if r == '"' || r == '\r' || r == '\n' || r < 32 {
			continue
		}
		out.WriteRune(r)
	}
	if out.Len() == 0 {
		return "question.webm"
	}
	return out.String()
}
