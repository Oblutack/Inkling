package server

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// Exam mode: questions drawn from the stored quizzes of a person's sets, and the record of the exams taken.

// giveQuiz stores a quiz of n distinct questions (named after the set) in a document, as the quiz route would have.
func giveQuiz(t *testing.T, a *app, id, n int, prefix string) {
	t.Helper()
	var questions []string
	for i := 1; i <= n; i++ {
		questions = append(questions, fmt.Sprintf(`{"question":"%s question %d?","options":["right %d","wrong a","wrong b","wrong c"],"answer":0,"explanation":"Because %d."}`, prefix, i, i, i))
	}
	doc := `{"quiz":[` + strings.Join(questions, ",") + `]}`
	if err := a.db.Exec("UPDATE documents SET study = ?::jsonb WHERE id = ?", doc, id).Error; err != nil {
		t.Fatal(err)
	}
}

func tagDoc(t *testing.T, cl *client, id int, tags ...string) {
	t.Helper()
	if r := cl.put(docPath(id, ""), map[string]any{"tags": tags}); r.Status != http.StatusOK {
		t.Fatalf("tag: %d %s", r.Status, r.Body)
	}
}

func questionsOf(t *testing.T, r reply) []map[string]any {
	t.Helper()
	if r.Status != http.StatusOK {
		t.Fatalf("draw: %d %s", r.Status, r.Body)
	}
	var out []map[string]any
	for _, q := range r.JSON()["questions"].([]any) {
		out = append(out, q.(map[string]any))
	}
	return out
}

func TestAnExamIsDrawnFromACollectionWithEveryOptionKeptAndTheAnswerMoved(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	first := saveText(t, cl, "Some words about the first subject.")
	second := saveText(t, cl, "Some words about the second subject.")
	giveQuiz(t, a, first, 6, "Alpha")
	giveQuiz(t, a, second, 6, "Beta")
	tagDoc(t, cl, first, "course")
	tagDoc(t, cl, second, "course")

	r := cl.post("/exams", map[string]any{"tag": "course", "count": 8})
	questions := questionsOf(t, r)
	if len(questions) != 8 {
		t.Fatalf("8 questions were asked for: %d", len(questions))
	}
	perSet := map[float64]int{}
	seen := map[string]bool{}
	for _, q := range questions {
		perSet[q["documentId"].(float64)]++
		if seen[q["question"].(string)] {
			t.Errorf("a question twice: %v", q["question"])
		}
		seen[q["question"].(string)] = true
		options := q["options"].([]any)
		answer := int(q["answer"].(float64))
		if len(options) != 4 || !strings.HasPrefix(options[answer].(string), "right ") {
			t.Errorf("the answer index must point at the right option after the options were mixed: %v", q)
		}
		if q["explanation"] == "" || q["documentTitle"] == "" {
			t.Errorf("explanation and title: %v", q)
		}
	}
	if perSet[float64(first)] != 4 || perSet[float64(second)] != 4 {
		t.Errorf("each set gives its share: %v", perSet)
	}
	if r.JSON()["available"].(float64) != 12 {
		t.Errorf("available: %v", r.JSON()["available"])
	}
	if a.ai.studyCalls.Load() != 0 || a.ai.calls.Load() > 2 {
		t.Errorf("drawing an exam calls no model: %d", a.ai.calls.Load())
	}
}

func TestTheAnswerIsNotAlwaysTheFirstOption(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Some words.")
	giveQuiz(t, a, id, 12, "Gamma")
	positions := map[int]bool{}
	for i := 0; i < 5; i++ {
		for _, q := range questionsOf(t, cl.post("/exams", map[string]any{"documentIds": []int{id}, "count": 12})) {
			positions[int(q["answer"].(float64))] = true
		}
	}
	if len(positions) < 3 {
		t.Errorf("the options are mixed: the answer was only ever at %v", positions)
	}
}

func TestASmallSetIsNotCrowdedOutAndAskingForMoreGivesWhatThereIs(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	big := saveText(t, cl, "Big.")
	small := saveText(t, cl, "Small.")
	giveQuiz(t, a, big, 10, "Big")
	giveQuiz(t, a, small, 3, "Small")
	questions := questionsOf(t, cl.post("/exams", map[string]any{"documentIds": []int{big, small}, "count": 6}))
	count := map[float64]int{}
	for _, q := range questions {
		count[q["documentId"].(float64)]++
	}
	if count[float64(small)] != 3 || count[float64(big)] != 3 {
		t.Errorf("an even draw: %v", count)
	}
	all := questionsOf(t, cl.post("/exams", map[string]any{"documentIds": []int{big, small}, "count": 40}))
	if len(all) != 13 {
		t.Errorf("all that there is: %d", len(all))
	}
}

func TestSetsWithoutAQuizAreListedAsMissingAndLeftOutOfTheDraw(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	ready := saveText(t, cl, "Ready.")
	waiting := saveText(t, cl, "Waiting.")
	empty := saveText(t, cl, "Empty.")
	giveQuiz(t, a, ready, 4, "Ready")
	a.db.Exec("UPDATE documents SET summary = '', has_content = false, content = '' WHERE id = ?", empty)

	r := cl.post("/exams", map[string]any{"documentIds": []int{ready, waiting, empty}, "count": 10})
	questions := questionsOf(t, r)
	if len(questions) != 4 {
		t.Errorf("only the set with a quiz gives questions: %d", len(questions))
	}
	missing := r.JSON()["missing"].([]any)
	if len(missing) != 1 || missing[0].(map[string]any)["id"].(float64) != float64(waiting) {
		t.Errorf("only a set that can be given a quiz is offered one: %v", missing)
	}

	// the quiz route makes it (one chat question), and then the set can be drawn from
	if q := cl.post(docPath(waiting, "/study"), map[string]string{"kind": "quiz"}); q.Status != http.StatusOK {
		t.Fatalf("making the quiz: %d %s", q.Status, q.Body)
	}
	again := cl.post("/exams", map[string]any{"documentIds": []int{ready, waiting}, "count": 10})
	if got := len(questionsOf(t, again)); got != 7 {
		t.Errorf("4 + 3 questions: %d", got)
	}
	if len(again.JSON()["missing"].([]any)) != 0 {
		t.Errorf("nothing is missing now: %s", again.Body)
	}
}

func TestTheSourcesListWhatCanBeExamined(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	quiz := saveText(t, cl, "With a quiz.")
	plain := saveText(t, cl, "Without a quiz.")
	giveQuiz(t, a, quiz, 5, "Q")
	tagDoc(t, cl, quiz, "law")
	r := cl.get("/exams/sources")
	if r.Status != http.StatusOK {
		t.Fatalf("sources: %d %s", r.Status, r.Body)
	}
	sets := r.JSON()["sets"].([]any)
	if len(sets) != 2 {
		t.Fatalf("both can be examined: %s", r.Body)
	}
	byID := map[float64]map[string]any{}
	for _, s := range sets {
		byID[s.(map[string]any)["id"].(float64)] = s.(map[string]any)
	}
	if byID[float64(quiz)]["questions"].(float64) != 5 || byID[float64(quiz)]["tags"].([]any)[0] != "law" {
		t.Errorf("the set with a quiz: %v", byID[float64(quiz)])
	}
	if byID[float64(plain)]["questions"].(float64) != 0 || byID[float64(plain)]["canMake"] != true {
		t.Errorf("the set without: %v", byID[float64(plain)])
	}
}

func TestDrawingAnExamIsValidatedAndStaysWithTheOwner(t *testing.T) {
	a := newApp(t)
	alice, _ := a.newUser()
	bob, _ := a.newUser()
	id := saveText(t, alice, "Alice's words.")
	giveQuiz(t, a, id, 5, "Alice")
	tagDoc(t, alice, id, "mine")

	for name, body := range map[string]map[string]any{
		"no count":      {"tag": "mine"},
		"too many":      {"tag": "mine", "count": 41},
		"no source":     {"count": 5},
		"both sources":  {"tag": "mine", "documentIds": []int{id}, "count": 5},
		"too many sets": {"documentIds": make([]int, 101), "count": 5},
	} {
		if r := alice.post("/exams", body); r.Status != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, r.Status, r.Body)
		}
	}
	if r := bob.post("/exams", map[string]any{"documentIds": []int{id}, "count": 5}); r.Status != http.StatusNotFound {
		t.Errorf("another person's set: %d", r.Status)
	}
	if got := questionsOf(t, bob.post("/exams", map[string]any{"tag": "mine", "count": 5})); len(got) != 0 {
		t.Errorf("another person's collection of the same name gives nothing: %d", len(got))
	}
	if sets := bob.get("/exams/sources").JSON()["sets"].([]any); len(sets) != 0 {
		t.Errorf("sources are private: %v", sets)
	}
	if r := a.newClient().get("/exams/sources"); r.Status != http.StatusUnauthorized {
		t.Errorf("signed out: %d", r.Status)
	}
}

func TestExamResultsAreKeptAndListedForACollection(t *testing.T) {
	a := newApp(t)
	cl, _ := a.newUser()
	id := saveText(t, cl, "Words.")
	other := saveText(t, cl, "More words.")
	record := func(tag string, docs []int, questions, correct int) reply {
		return cl.post("/exams/results", map[string]any{
			"tag": tag, "documentIds": docs, "questions": questions, "correct": correct, "seconds": 95,
			"breakdown": []map[string]any{{"documentId": docs[0], "title": "Words", "questions": questions, "correct": correct}},
			"missed":    []map[string]any{},
		})
	}
	if r := record("course", []int{id}, 10, 7); r.Status != http.StatusCreated {
		t.Fatalf("record: %d %s", r.Status, r.Body)
	}
	record("course", []int{id}, 10, 9)
	record("", []int{other}, 5, 2)

	results := func(query string) []any { return cl.get("/exams/results" + query).JSON()["results"].([]any) }
	if got := results(""); len(got) != 3 {
		t.Errorf("all: %d", len(got))
	}
	course := results("?tag=course")
	if len(course) != 2 || course[0].(map[string]any)["correct"].(float64) != 9 {
		t.Errorf("newest first, for the collection only: %v", course)
	}
	if got := results("?tag="); len(got) != 1 {
		t.Errorf("sets picked one by one have no tag: %d", len(got))
	}
}

func TestAnExamResultThatDoesNotAddUpIsRefused(t *testing.T) {
	a := newApp(t)
	alice, _ := a.newUser()
	bob, _ := a.newUser()
	id := saveText(t, alice, "Words.")
	good := func() map[string]any {
		return map[string]any{
			"tag": "x", "documentIds": []int{id}, "questions": 5, "correct": 3, "seconds": 60,
			"breakdown": []map[string]any{{"documentId": id, "title": "Words", "questions": 5, "correct": 3}},
			"missed":    []map[string]any{{"documentId": id, "question": "Which?"}, {"documentId": id, "question": "Why?"}},
		}
	}
	if r := alice.post("/exams/results", good()); r.Status != http.StatusCreated {
		t.Fatalf("a good result: %d %s", r.Status, r.Body)
	}
	bad := map[string]func(m map[string]any){
		"more correct than questions": func(m map[string]any) { m["correct"] = 6 },
		"no questions":                func(m map[string]any) { m["questions"] = 0; m["correct"] = 0 },
		"too many questions":          func(m map[string]any) { m["questions"] = 41 },
		"negative time":               func(m map[string]any) { m["seconds"] = -1 },
		"a day and more":              func(m map[string]any) { m["seconds"] = 90000 },
		"no sets":                     func(m map[string]any) { m["documentIds"] = []int{} },
		"more missed than wrong": func(m map[string]any) {
			m["correct"] = 4
		},
		"a missed question from a set not in the exam": func(m map[string]any) {
			m["missed"] = []map[string]any{{"documentId": id + 100, "question": "?"}}
		},
		"a breakdown that is too good": func(m map[string]any) {
			m["breakdown"] = []map[string]any{{"documentId": id, "title": "Words", "questions": 2, "correct": 3}}
		},
	}
	for name, change := range bad {
		m := good()
		change(m)
		if r := alice.post("/exams/results", m); r.Status != http.StatusBadRequest && r.Status != http.StatusNotFound {
			t.Errorf("%s: %d %s", name, r.Status, r.Body)
		}
	}
	if r := bob.post("/exams/results", good()); r.Status != http.StatusNotFound {
		t.Errorf("a result for someone else's set: %d", r.Status)
	}
	if n := count(t, a.db, "SELECT count(*) FROM exam_results"); n != 1 {
		t.Errorf("only the good one was kept: %d", n)
	}
}

func TestExamResultsGoWithTheAccount(t *testing.T) {
	a := newApp(t)
	cl, email := a.newUser()
	id := saveText(t, cl, "Words.")
	cl.post("/exams/results", map[string]any{"documentIds": []int{id}, "questions": 3, "correct": 1, "seconds": 5, "breakdown": []any{}, "missed": []any{}})
	if n := count(t, a.db, "SELECT count(*) FROM exam_results"); n != 1 {
		t.Fatalf("setup: %d", n)
	}
	a.db.Exec("DELETE FROM users WHERE email = ?", email)
	if n := count(t, a.db, "SELECT count(*) FROM exam_results"); n != 0 {
		t.Errorf("results are removed with the person: %d", n)
	}
}
