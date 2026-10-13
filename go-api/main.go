package main

import (
	"ai-summarizer/go-api/alerts"
	"ai-summarizer/go-api/controllers"
	"ai-summarizer/go-api/initializers"
	"ai-summarizer/go-api/mailer"
	"ai-summarizer/go-api/server"
	"context"
	"flag"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// listenAddr honors PORT (set by hosts like Render) and defaults to 8080.
func listenAddr() string {
	if port := os.Getenv("PORT"); port != "" {
		return ":" + port
	}
	return ":8080"
}

// runHealthcheck probes the local server and exits 0/1. It exists so the minimal scratch-based
// image, which has no shell or curl, can still define a container HEALTHCHECK.
func runHealthcheck() {
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1" + listenAddr() + "/healthz")
	if err != nil {
		os.Exit(1)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		os.Exit(1)
	}
	os.Exit(0)
}

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe the running server and exit")
	flag.Parse()
	if *healthcheck {
		runHealthcheck()
	}

	logger := initializers.SetupLogger()
	defer initializers.SetupSentry(logger)()

	initializers.ConnectToDB()
	if err := initializers.RunMigrations(); err != nil {
		logger.Error("database migration failed", "error", err)
		os.Exit(1)
	}
	logger.Info("database migrations up to date")

	// A bad MAIL_PROVIDER or missing key fails here, at startup, not silently at the first reset.
	m, err := mailer.FromEnv()
	if err != nil {
		logger.Error("mail configuration is invalid", "error", err)
		os.Exit(1)
	}
	controllers.Mail = m
	if provider := strings.ToLower(os.Getenv("MAIL_PROVIDER")); provider == "" || provider == "log" {
		logger.Warn("MAIL_PROVIDER is not set: emails are only written to the log, never sent")
	}

	// Alerts (many people at once, the AI budget used up, the AI service failing): emailed to ALERT_EMAIL when it is set,
	// always written to the log.
	alerts.Start(context.Background(), alerts.ConfigFromEnv(), m)

	rates := server.DefaultRates
	if v := os.Getenv("RATE_LIMIT_MULTIPLIER"); v != "" {
		factor, err := strconv.Atoi(v)
		if err != nil || factor < 1 {
			logger.Error("RATE_LIMIT_MULTIPLIER must be a whole number of at least 1", "value", v)
			os.Exit(1)
		}
		rates = rates.Scaled(factor)
		logger.Info("rate limits scaled", "factor", factor)
	}

	r, err := server.NewRouter(logger, rates)
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	logger.Info("listening", "addr", listenAddr())
	if err := r.Run(listenAddr()); err != nil {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
