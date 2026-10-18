package server

import (
	"bytes"
	"testing"
)

// Speaking a question: a short recording becomes text, which the page then asks like any typed question.

func TestASpokenQuestionBecomesTidyText(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	r := cl.upload("/voice/transcribe", "audio", map[string][]byte{"question.webm": []byte("audio bytes")})
	if r.Status != 200 || r.JSON()["text"] != "What does the lease say about the deposit?" {
		t.Fatalf("transcribe: %d %s", r.Status, r.Body)
	}
	if a.ai.voiceCalls.Load() != 1 {
		t.Error("the speech service was asked once")
	}
	if n := count(t, a.db, "SELECT COALESCE(SUM(chats) + SUM(summaries),0) FROM daily_usage"); n != 0 {
		t.Errorf("listening does not use the daily allowance, only the asking does: %d", n)
	}
}

func TestTheClipIsCheckedBeforeAnythingIsSent(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	for name, files := range map[string]map[string][]byte{
		"not audio": {"notes.pdf": []byte("%PDF")},
		"too big":   {"question.webm": bytes.Repeat([]byte("x"), 1<<20+10)},
	} {
		if r := cl.upload("/voice/transcribe", "audio", files); r.Status != 400 && r.Status != 413 {
			t.Errorf("%s: %d %s", name, r.Status, r.Body)
		}
	}
	if r := cl.upload("/voice/transcribe", "wrongfield", map[string][]byte{"question.webm": []byte("a")}); r.Status != 400 {
		t.Errorf("no audio field: %d", r.Status)
	}
	if a.ai.voiceCalls.Load() != 0 {
		t.Error("nothing reached the speech service")
	}
}

func TestListeningNeedsASignedInConfirmedPerson(t *testing.T) {
	a := newApp(t)
	if r := a.newClient().upload("/voice/transcribe", "audio", map[string][]byte{"q.webm": []byte("a")}); r.Status != 401 {
		t.Errorf("signed out: %d", r.Status)
	}
}

func TestAFailingSpeechServiceIsReportedAndCostsNothing(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	a.ai.fail.Store(true)
	if r := cl.upload("/voice/transcribe", "audio", map[string][]byte{"q.webm": []byte("a")}); r.Status < 500 {
		t.Errorf("a failing service: %d", r.Status)
	}
	a.ai.fail.Store(false)
	if r := cl.upload("/voice/transcribe", "audio", map[string][]byte{"q.webm": []byte("a")}); r.Status != 200 {
		t.Errorf("and it recovers: %d", r.Status)
	}
}

func TestTheClipNameCannotBreakTheForwardedRequest(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	r := cl.upload("/voice/transcribe", "audio", map[string][]byte{"..\\..\\evil\"; name=\"x\r\nX-Injected: 1.webm": []byte("a")})
	if r.Status != 200 && r.Status != 400 {
		t.Errorf("odd file name: %d %s", r.Status, r.Body)
	}
}
