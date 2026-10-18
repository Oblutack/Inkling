package controllers

import (
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/middleware"
	"database/sql"
	"encoding/json"
	"math/rand/v2"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Exam mode: a mock exam drawn from the quizzes already made for a person's study sets, a collection (tag) or sets picked
// one by one. Nothing here calls a model: the questions are the stored quizzes (a set without one is given one first, from
// the page, through the usual quiz route, which costs one chat question each). The questions are mixed, with the options
// of each in a new order, and the page marks the exam; the server keeps the result so a collection's scores can be shown
// over time.
const (
	maxExamQuestions  = 40
	maxExamDocuments  = 100
	maxExamSeconds    = 24 * 60 * 60
	maxExamHistory    = 30
	maxExamTagRunes   = 30
	maxExamTitleRunes = 200
	maxExamMissed     = maxExamQuestions
)

type examQuestion struct {
	DocumentID    uint     `json:"documentId"`
	DocumentTitle string   `json:"documentTitle"`
	Question      string   `json:"question"`
	Options       []string `json:"options"`
	Answer        int      `json:"answer"`
	Explanation   string   `json:"explanation"`
}

// examSet is one study set that can be examined: what it holds and whether a quiz can be made for it.
type examSet struct {
	ID        uint     `json:"id"`
	Title     string   `json:"title"`
	Tags      []string `json:"tags"`
	Questions int      `json:"questions"`
	CanMake   bool     `json:"canMake"`
	quiz      []quizQuestion
}

type examSetRow struct {
	ID        uint
	Title     string
	Tags      string
	Questions int
	CanMake   bool
	Study     sql.NullString
}

const examSetColumns = `id, filename AS title, tags::text AS tags,
	COALESCE(jsonb_array_length(study->'quiz'), 0) AS questions,
	(btrim(summary) <> '' OR (has_content AND btrim(content) <> '' AND char_length(content) <= ?)) AS can_make`

func rowsToSets(rows []examSetRow, withQuiz bool) []examSet {
	sets := make([]examSet, 0, len(rows))
	for _, r := range rows {
		set := examSet{ID: r.ID, Title: r.Title, Questions: r.Questions, CanMake: r.CanMake, Tags: []string{}}
		_ = json.Unmarshal([]byte(r.Tags), &set.Tags)
		if withQuiz && r.Study.Valid {
			var material studyMaterial
			if json.Unmarshal([]byte(r.Study.String), &material) == nil && len(material.Quiz) >= minQuizQuestions {
				set.quiz = material.Quiz
			}
		}
		sets = append(sets, set)
	}
	return sets
}

// ExamSources lists the person's sets that an exam can be made from: with a quiz already (and how many questions), or
// able to have one made.
func ExamSources(c *gin.Context) {
	user := middleware.CurrentUser(c)
	var rows []examSetRow
	err := initializers.DB.Raw(
		"SELECT "+examSetColumns+" FROM documents WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 200",
		studyFullTextMax, user.ID,
	).Scan(&rows).Error
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load your sets."})
		return
	}
	out := []examSet{}
	for _, set := range rowsToSets(rows, false) {
		if set.Questions >= minQuizQuestions || set.CanMake {
			out = append(out, set)
		}
	}
	c.JSON(http.StatusOK, gin.H{"sets": out})
}

// drawExam picks up to `count` questions from the sets: one from each set in turn (so a big set cannot crowd out a small
// one), no question twice, then mixed, with the options of each in a new order. It gives the sets the questions came from.
func drawExam(sets []examSet, count int, rng *rand.Rand) []examQuestion {
	pools := make([][]examQuestion, 0, len(sets))
	seen := map[string]bool{}
	for _, set := range sets {
		var pool []examQuestion
		for _, q := range set.quiz {
			key := strings.ToLower(strings.Join(strings.Fields(q.Question), " "))
			if key == "" || seen[key] || len(q.Options) != quizOptionCount || q.Answer < 0 || q.Answer >= len(q.Options) {
				continue
			}
			seen[key] = true
			order := rng.Perm(len(q.Options))
			options := make([]string, len(order))
			answer := 0
			for to, from := range order {
				options[to] = q.Options[from]
				if from == q.Answer {
					answer = to
				}
			}
			pool = append(pool, examQuestion{
				DocumentID: set.ID, DocumentTitle: set.Title, Question: q.Question,
				Options: options, Answer: answer, Explanation: q.Explanation,
			})
		}
		rng.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
		if len(pool) > 0 {
			pools = append(pools, pool)
		}
	}
	rng.Shuffle(len(pools), func(i, j int) { pools[i], pools[j] = pools[j], pools[i] })

	var drawn []examQuestion
	for round := 0; len(drawn) < count; round++ {
		progressed := false
		for _, pool := range pools {
			if round < len(pool) && len(drawn) < count {
				drawn = append(drawn, pool[round])
				progressed = true
			}
		}
		if !progressed {
			break
		}
	}
	rng.Shuffle(len(drawn), func(i, j int) { drawn[i], drawn[j] = drawn[j], drawn[i] })
	return drawn
}

// DrawExam makes an exam from a collection (`tag`) or from chosen sets (`documentIds`). Sets with no quiz yet are listed as
// `missing` (with whether one can be made), so the page can offer to make them; the exam is drawn from the others.
func DrawExam(c *gin.Context) {
	user := middleware.CurrentUser(c)
	var body struct {
		Tag         string `json:"tag"`
		DocumentIDs []uint `json:"documentIds"`
		Count       int    `json:"count"`
	}
	if !bindJSON(c, &body) {
		return
	}
	tag := cleanLine(body.Tag)
	if body.Count < 1 || body.Count > maxExamQuestions {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Choose between 1 and 40 questions."})
		return
	}
	if (tag == "") == (len(body.DocumentIDs) == 0) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Choose a collection or some sets."})
		return
	}
	if len(body.DocumentIDs) > maxExamDocuments {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Choose fewer sets."})
		return
	}

	query := initializers.DB.Table("documents").
		Select(examSetColumns+", study::text AS study", studyFullTextMax).
		Where("user_id = ? AND deleted_at IS NULL", user.ID)
	if tag != "" {
		encoded, _ := json.Marshal([]string{tag})
		query = query.Where("tags @> ?::jsonb", string(encoded)).Order("id DESC").Limit(maxExamDocuments)
	} else {
		query = query.Where("id IN ?", body.DocumentIDs)
	}
	var rows []examSetRow
	if err := query.Scan(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to make the exam."})
		return
	}
	if tag == "" && len(rows) != len(uniqueIDs(body.DocumentIDs)) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Document not found"})
		return
	}
	sets := rowsToSets(rows, true)

	var ready []examSet
	missing := []examSet{}
	for _, set := range sets {
		if len(set.quiz) >= minQuizQuestions {
			ready = append(ready, set)
		} else if set.CanMake {
			missing = append(missing, set)
		}
	}
	questions := drawExam(ready, body.Count, rand.New(rand.NewPCG(rand.Uint64(), rand.Uint64())))
	if questions == nil {
		questions = []examQuestion{}
	}
	available := 0
	for _, set := range ready {
		available += len(set.quiz)
	}
	c.JSON(http.StatusOK, gin.H{"questions": questions, "available": available, "missing": missing})
}

func uniqueIDs(ids []uint) map[uint]bool {
	seen := make(map[uint]bool, len(ids))
	for _, id := range ids {
		seen[id] = true
	}
	return seen
}

type examBreakdown struct {
	DocumentID uint   `json:"documentId"`
	Title      string `json:"title"`
	Questions  int    `json:"questions"`
	Correct    int    `json:"correct"`
}

type examMissed struct {
	DocumentID uint   `json:"documentId"`
	Question   string `json:"question"`
}

// RecordExam keeps the result of an exam the page marked. The score is the person's own record, so it is checked only for
// being sensible: the sets are theirs, and the numbers add up.
func RecordExam(c *gin.Context) {
	user := middleware.CurrentUser(c)
	var body struct {
		Tag         string          `json:"tag"`
		DocumentIDs []uint          `json:"documentIds"`
		Questions   int             `json:"questions"`
		Correct     int             `json:"correct"`
		Seconds     int             `json:"seconds"`
		Breakdown   []examBreakdown `json:"breakdown"`
		Missed      []examMissed    `json:"missed"`
	}
	if !bindJSON(c, &body) {
		return
	}
	tag := clip(cleanLine(body.Tag), maxExamTagRunes)
	if body.Questions < 1 || body.Questions > maxExamQuestions || body.Correct < 0 || body.Correct > body.Questions ||
		body.Seconds < 0 || body.Seconds > maxExamSeconds || len(body.DocumentIDs) == 0 || len(body.DocumentIDs) > maxExamDocuments ||
		len(body.Breakdown) > maxExamDocuments || len(body.Missed) > maxExamMissed || len(body.Missed) > body.Questions-body.Correct {
		c.JSON(http.StatusBadRequest, gin.H{"error": "That exam result does not add up."})
		return
	}
	ids := uniqueIDs(body.DocumentIDs)
	var owned int64
	if err := initializers.DB.Table("documents").Where("user_id = ? AND deleted_at IS NULL AND id IN ?", user.ID, body.DocumentIDs).Count(&owned).Error; err != nil || int(owned) != len(ids) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Document not found"})
		return
	}
	for i := range body.Breakdown {
		body.Breakdown[i].Title = clip(cleanLine(body.Breakdown[i].Title), maxExamTitleRunes)
		if !ids[body.Breakdown[i].DocumentID] || body.Breakdown[i].Correct < 0 || body.Breakdown[i].Correct > body.Breakdown[i].Questions {
			c.JSON(http.StatusBadRequest, gin.H{"error": "That exam result does not add up."})
			return
		}
	}
	for i := range body.Missed {
		body.Missed[i].Question = clip(cleanLine(body.Missed[i].Question), maxQuizRunes)
		if !ids[body.Missed[i].DocumentID] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "That exam result does not add up."})
			return
		}
	}
	idList, _ := json.Marshal(body.DocumentIDs)
	breakdown, _ := json.Marshal(append([]examBreakdown{}, body.Breakdown...))
	missed, _ := json.Marshal(append([]examMissed{}, body.Missed...))
	var id uint
	err := initializers.DB.Raw(
		`INSERT INTO exam_results (user_id, tag, document_ids, questions, correct, seconds, breakdown, missed)
		 VALUES (?, ?, ?::jsonb, ?, ?, ?, ?::jsonb, ?::jsonb) RETURNING id`,
		user.ID, tag, string(idList), body.Questions, body.Correct, body.Seconds, string(breakdown), string(missed),
	).Scan(&id).Error
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not save that."})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

// ExamHistory lists the person's recent exams, newest first, for one collection (`?tag=`) or all of them.
func ExamHistory(c *gin.Context) {
	user := middleware.CurrentUser(c)
	type row struct {
		ID         uint      `json:"id"`
		Tag        string    `json:"tag"`
		Questions  int       `json:"questions"`
		Correct    int       `json:"correct"`
		Seconds    int       `json:"seconds"`
		FinishedAt time.Time `json:"finishedAt"`
	}
	query := initializers.DB.Table("exam_results").
		Select("id, tag, questions, correct, seconds, finished_at").
		Where("user_id = ?", user.ID)
	if _, asked := c.GetQuery("tag"); asked {
		query = query.Where("tag = ?", cleanLine(c.Query("tag")))
	}
	rows := []row{}
	if err := query.Order("finished_at DESC, id DESC").Limit(maxExamHistory).Scan(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load your exams."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"results": rows})
}
