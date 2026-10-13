package middleware

import (
	"ai-summarizer/go-api/alerts"
	"ai-summarizer/go-api/models"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func activityRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(Activity())
	ok := func(c *gin.Context) { c.Status(http.StatusOK) }
	r.GET("/", ok)
	r.GET("/healthz", ok)
	r.GET("/readyz", ok)
	r.GET("/metrics", ok)
	r.GET("/options", ok)
	r.GET("/me", func(c *gin.Context) {
		c.Set(UserKey, models.User{Model: gorm.Model{ID: 7}})
		c.Status(http.StatusOK)
	})
	r.GET("/me/:id", func(c *gin.Context) {
		c.Set(UserKey, models.User{Model: gorm.Model{ID: 7}})
		c.Status(http.StatusOK)
	})
	return r
}

func hit(r *gin.Engine, method, path, remote string) {
	req := httptest.NewRequest(method, path, nil)
	req.RemoteAddr = remote + ":1234"
	r.ServeHTTP(httptest.NewRecorder(), req)
}

func withActivity(t *testing.T) {
	t.Helper()
	alerts.Default.Reset(alerts.Config{}, nil, nil)
	t.Cleanup(alerts.Default.Disable)
}

func TestVisitorsWithoutAnAccountCountOncePerAddress(t *testing.T) {
	withActivity(t)
	r := activityRouter()
	hit(r, "GET", "/options", "203.0.113.1")
	hit(r, "GET", "/options", "203.0.113.1")
	hit(r, "GET", "/options", "203.0.113.2")
	if got := alerts.Default.Active(); got != 2 {
		t.Fatalf("active = %d, want 2", got)
	}
}

func TestASignedInPersonCountsOnceWhateverTheirAddress(t *testing.T) {
	withActivity(t)
	r := activityRouter()
	hit(r, "GET", "/me", "203.0.113.1")
	hit(r, "GET", "/me/5", "203.0.113.9") // another device, another route, same person
	if got := alerts.Default.Active(); got != 1 {
		t.Fatalf("active = %d, want 1", got)
	}
}

func TestMonitorsScannersAndPreflightsAreNotPeople(t *testing.T) {
	withActivity(t)
	r := activityRouter()
	for _, path := range []string{"/", "/healthz", "/readyz", "/metrics"} {
		hit(r, "GET", path, "198.51.100.4")
	}
	hit(r, "GET", "/wp-login.php", "198.51.100.5") // a route that does not exist
	hit(r, "OPTIONS", "/options", "198.51.100.6")
	if got := alerts.Default.Active(); got != 0 {
		t.Fatalf("active = %d, want 0", got)
	}
}

func TestTheStoredIdentityIsNotTheAddress(t *testing.T) {
	withActivity(t)
	r := activityRouter()
	hit(r, "GET", "/options", "203.0.113.77")
	// the visitor key is a hash: counting works, and the same address maps to the same key as the daily allowance's
	if visitorKey("203.0.113.77") == "203.0.113.77" {
		t.Fatal("the key must not be the address")
	}
}
