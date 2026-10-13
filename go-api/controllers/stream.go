package controllers

import (
	"ai-summarizer/go-api/alerts"
	"ai-summarizer/go-api/metrics"
	"ai-summarizer/go-api/middleware"
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// wantsStream reports whether the client asked for a server-sent-events response.
func wantsStream(c *gin.Context) bool {
	return c.Query("stream") == "true"
}

// writeEvent sends one server-sent event and flushes it so the client sees it immediately.
func writeEvent(c *gin.Context, event map[string]any) {
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(c.Writer, "data: %s\n\n", payload)
	c.Writer.Flush()
}

// streamSummary forwards the AI service's event stream to the client.
//
// The stream carries the summary as "delta" events and ends with a "done" event. The done event
// also includes the extracted source text; that is stripped before it reaches the client and, for
// signed-in users, stored with the summary so the document can be chatted with later.
//
// Errors before the first byte are ordinary JSON error responses. Once streaming has begun the
// status line is already sent, so failures are reported as a final "error" event instead.
func streamSummary(c *gin.Context, ar *aiRequest, save bool, label string) {
	started := time.Now()
	resp, err := aiHTTPClient.Do(ar.req)
	if err != nil {
		metrics.AIRequest(ar.req.URL.Path, "unavailable", time.Since(started))
		alerts.Default.AIResult(true)
		middleware.RefundQuota(c)
		(&apiError{http.StatusGatewayTimeout, "The AI service is unavailable or took too long to respond."}).send(c)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	metrics.AIRequest(ar.req.URL.Path, aiOutcome(resp.StatusCode), time.Since(started))
	alerts.Default.AIResult(aiFailed(resp.StatusCode))

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		middleware.RefundQuota(c)
		upstreamError(resp.StatusCode, body).send(c)
		return
	}

	h := c.Writer.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no") // ask reverse proxies not to buffer the stream
	c.Status(http.StatusOK)
	c.Writer.Flush()

	var summary strings.Builder
	finished := false
	var savedID uint

	reader := bufio.NewReader(resp.Body)
	for {
		// ReadBytes rather than a Scanner: the done event can carry hundreds of KB of source text.
		raw, readErr := reader.ReadBytes('\n')

		if payload, ok := strings.CutPrefix(strings.TrimSpace(string(raw)), "data: "); ok {
			var event map[string]json.RawMessage
			if json.Unmarshal([]byte(payload), &event) == nil {
				var kind string
				_ = json.Unmarshal(event["type"], &kind)

				if kind == "done" {
					var filename, source string
					_ = json.Unmarshal(event["filename"], &filename)
					_ = json.Unmarshal(event["text"], &source)
					if source == "" {
						source = ar.sourceText
					}

					if save && strings.TrimSpace(summary.String()) != "" {
						title := filename
						if label != "" {
							title = titleFromText(source, label)
						}
						savedID = saveDocument(c, title, &aiSummary{Filename: filename, Summary: summary.String(), Text: source, files: ar.files})
					}

					// The client gets the filename but never the source text.
					out := map[string]any{"type": "done"}
					if filename != "" {
						out["filename"] = filename
					}
					if savedID != 0 {
						out["id"] = savedID
					}
					writeEvent(c, out)
					return
				}

				if kind == "delta" {
					var text string
					_ = json.Unmarshal(event["text"], &text)
					summary.WriteString(text)
				}

				// status, delta and error events pass through unchanged.
				_, _ = fmt.Fprintf(c.Writer, "data: %s\n\n", payload)
				c.Writer.Flush()
				if kind == "error" {
					middleware.RefundQuota(c) // the user got no complete summary
					return
				}
			}
		}

		if readErr != nil {
			break
		}
	}

	if !finished && c.Request.Context().Err() == nil {
		middleware.RefundQuota(c)
		writeEvent(c, map[string]any{"type": "error", "status": http.StatusBadGateway, "message": "The summary stream ended unexpectedly. Please try again."})
	}
}
