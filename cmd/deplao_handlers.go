package main

import (
	"strconv"

	"github.com/abhinavxd/libredesk/internal/ai"
	"github.com/abhinavxd/libredesk/internal/envelope"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

// handleGetAISuggestions returns smart reply suggestions for a conversation.
func handleGetAISuggestions(r *fastglue.Request) error {
	var (
		app            = r.Context.(*App)
		conversationID = r.RequestCtx.UserValue("id").(string)
	)

	req := ai.SuggestionRequest{
		ConversationID: conversationID,
		LastMessages:   []string{},
	}

	// Read last_messages from query
	msgs := string(r.RequestCtx.QueryArgs().Peek("messages"))
	if msgs != "" {
		req.LastMessages = append(req.LastMessages, msgs)
	}

	suggestions, err := app.ai.GenerateSuggestions(r.RequestCtx, req)
	if err != nil {
		return sendErrorEnvelope(r, err)
	}

	return r.SendEnvelope(suggestions)
}

// handleGetOutboxStatus returns outbox queue status for monitoring.
func handleGetOutboxStatus(r *fastglue.Request) error {
	var (
		app   = r.Context.(*App)
		limit = 20
	)

	if l := string(r.RequestCtx.QueryArgs().Peek("limit")); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 {
			limit = v
		}
	}

	type outboxStats struct {
		TotalPending    int `json:"total_pending"`
		TotalProcessing int `json:"total_processing"`
		TotalFailed     int `json:"total_failed"`
		TotalSent       int `json:"total_sent"`
	}

	var stats outboxStats
	_ = app.redis // ensure app is valid

	// Query stats from message_outbox
	db := app.user.DB()
	_ = db.Get(&stats.TotalPending, `SELECT COUNT(*) FROM message_outbox WHERE status = 'pending'`)
	_ = db.Get(&stats.TotalProcessing, `SELECT COUNT(*) FROM message_outbox WHERE status = 'processing'`)
	_ = db.Get(&stats.TotalFailed, `SELECT COUNT(*) FROM message_outbox WHERE status = 'failed'`)
	_ = db.Get(&stats.TotalSent, `SELECT COUNT(*) FROM message_outbox WHERE status = 'sent'`)

	_ = limit
	return r.SendEnvelope(stats)
}

// handleGetScheduledJobs returns scheduled follow-up jobs for monitoring.
func handleGetScheduledJobs(r *fastglue.Request) error {
	var (
		app   = r.Context.(*App)
		limit = 20
	)

	if l := string(r.RequestCtx.QueryArgs().Peek("limit")); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 {
			limit = v
		}
	}

	type scheduledJobSummary struct {
		ID        string `db:"id" json:"id"`
		JobType   string `db:"job_type" json:"job_type"`
		Status    string `db:"status" json:"status"`
		RunAt     string `db:"run_at" json:"run_at"`
		CreatedAt string `db:"created_at" json:"created_at"`
	}

	var jobs []scheduledJobSummary
	db := app.user.DB()
	err := db.Select(&jobs, `
		SELECT id, job_type, status, run_at::text, created_at::text
		FROM scheduled_jobs
		ORDER BY run_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return r.SendErrorEnvelope(fasthttp.StatusInternalServerError, "error fetching scheduled jobs", nil, envelope.GeneralError)
	}

	return r.SendEnvelope(jobs)
}

// handleGetEventPipelineStatus returns integration event pipeline stats for monitoring.
func handleGetEventPipelineStatus(r *fastglue.Request) error {
	var (
		app = r.Context.(*App)
	)

	type eventStats struct {
		TotalPending   int `json:"total_pending"`
		TotalProcessed int `json:"total_processed"`
		TotalFailed    int `json:"total_failed"`
		TotalRetryWait int `json:"total_retry_wait"`
	}

	var stats eventStats
	db := app.user.DB()
	_ = db.Get(&stats.TotalPending, `SELECT COUNT(*) FROM integration_events WHERE status = 'pending'`)
	_ = db.Get(&stats.TotalProcessed, `SELECT COUNT(*) FROM integration_events WHERE status = 'processed'`)
	_ = db.Get(&stats.TotalFailed, `SELECT COUNT(*) FROM integration_events WHERE status = 'failed'`)
	_ = db.Get(&stats.TotalRetryWait, `SELECT COUNT(*) FROM integration_events WHERE status = 'retry_wait'`)

	return r.SendEnvelope(stats)
}
