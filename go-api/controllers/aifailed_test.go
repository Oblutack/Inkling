package controllers

import (
	"net/http"
	"testing"
)

// Only a broken AI service counts towards the failure alert: not a refusal of what was sent, and not its deliberate
// "busy" answer.
func TestWhichAIRepliesCountAsTheServiceFailing(t *testing.T) {
	cases := map[int]bool{
		http.StatusOK:                    false,
		http.StatusBadRequest:            false,
		http.StatusUnprocessableEntity:   false,
		http.StatusRequestEntityTooLarge: false,
		http.StatusTooManyRequests:       false,
		http.StatusServiceUnavailable:    false, // "busy reading other scans", on purpose
		http.StatusInternalServerError:   true,
		http.StatusBadGateway:            true,
		http.StatusGatewayTimeout:        true,
	}
	for status, want := range cases {
		if got := aiFailed(status); got != want {
			t.Errorf("aiFailed(%d) = %v, want %v", status, got, want)
		}
	}
}
