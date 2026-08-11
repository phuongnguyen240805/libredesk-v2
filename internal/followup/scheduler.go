package followup

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/jmoiron/sqlx"
)

type JobStatus string

const (
	StatusScheduled JobStatus = "scheduled"
	StatusRunning   JobStatus = "running"
	StatusCompleted JobStatus = "completed"
	StatusCancelled JobStatus = "cancelled"
	StatusFailed    JobStatus = "failed"
)

type ScheduledJob struct {
	ID               string          `db:"id" json:"id"`
	WorkspaceID      string          `db:"workspace_id" json:"workspace_id"`
	JobType          string          `db:"job_type" json:"job_type"`
	EntityType       string          `db:"entity_type" json:"entity_type"`
	EntityID         string          `db:"entity_id" json:"entity_id"`
	Payload          json.RawMessage `db:"payload" json:"payload"`
	RunAt            time.Time       `db:"run_at" json:"run_at"`
	Status           JobStatus       `db:"status" json:"status"`
	AttemptCount     int             `db:"attempt_count" json:"attempt_count"`
	DeduplicationKey *string         `db:"deduplication_key,omitempty" json:"deduplication_key,omitempty"`
	ExecutedAt       *time.Time      `db:"executed_at,omitempty" json:"executed_at,omitempty"`
	LastError        *string         `db:"last_error,omitempty" json:"last_error,omitempty"`
	CreatedAt        time.Time       `db:"created_at" json:"created_at"`
}

type JobHandler func(ctx context.Context, job ScheduledJob) error

type Scheduler struct {
	db       *sqlx.DB
	handlers map[string]JobHandler
	stopChan chan struct{}
	wg       sync.WaitGroup
	mu       sync.RWMutex
}

func NewScheduler(db *sqlx.DB) *Scheduler {
	return &Scheduler{
		db:       db,
		handlers: make(map[string]JobHandler),
		stopChan: make(chan struct{}),
	}
}

func (s *Scheduler) RegisterHandler(jobType string, handler JobHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handlers[jobType] = handler
}

// ScheduleJob enqueues a persistent scheduled job into scheduled_jobs.
func (s *Scheduler) ScheduleJob(ctx context.Context, job ScheduledJob) (string, error) {
	if job.Payload == nil {
		job.Payload = json.RawMessage("{}")
	}

	query := `
		INSERT INTO scheduled_jobs (
			workspace_id, job_type, entity_type, entity_id, payload, run_at, status, deduplication_key
		) VALUES (
			$1, $2, $3, $4, $5, $6, 'scheduled', $7
		)
		RETURNING id;
	`

	var id string
	err := s.db.QueryRowContext(ctx, query,
		job.WorkspaceID,
		job.JobType,
		job.EntityType,
		job.EntityID,
		job.Payload,
		job.RunAt,
		job.DeduplicationKey,
	).Scan(&id)

	if err != nil {
		return "", fmt.Errorf("failed to schedule job: %w", err)
	}

	return id, nil
}

func (s *Scheduler) Start(ctx context.Context, pollInterval time.Duration) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(pollInterval)
		defer ticker.Stop()

		for {
			select {
			case <-s.stopChan:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.processDueJobs(ctx)
			}
		}
	}()
}

func (s *Scheduler) Stop() {
	close(s.stopChan)
	s.wg.Wait()
}

func (s *Scheduler) processDueJobs(ctx context.Context) {
	var dueJobs []ScheduledJob
	query := `
		UPDATE scheduled_jobs
		SET status = 'running'
		WHERE id IN (
			SELECT id FROM scheduled_jobs
			WHERE status = 'scheduled' AND run_at <= NOW()
			ORDER BY run_at ASC
			LIMIT 20
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, workspace_id, job_type, entity_type, entity_id, payload, run_at, status, attempt_count, created_at;
	`

	if err := s.db.SelectContext(ctx, &dueJobs, query); err != nil {
		log.Printf("[Scheduler] Error fetching due jobs: %v", err)
		return
	}

	for _, job := range dueJobs {
		s.mu.RLock()
		handler, exists := s.handlers[job.JobType]
		s.mu.RUnlock()

		if !exists {
			log.Printf("[Scheduler] No handler registered for job type: %s", job.JobType)
			_, _ = s.db.ExecContext(ctx, `UPDATE scheduled_jobs SET status = 'failed', last_error = 'no handler' WHERE id = $1`, job.ID)
			continue
		}

		err := handler(ctx, job)
		if err == nil {
			_, _ = s.db.ExecContext(ctx, `UPDATE scheduled_jobs SET status = 'completed', executed_at = NOW() WHERE id = $1`, job.ID)
		} else {
			_, _ = s.db.ExecContext(ctx, `
				UPDATE scheduled_jobs
				SET status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'scheduled' END,
				    attempt_count = attempt_count + 1,
				    run_at = NOW() + INTERVAL '1 minute',
				    last_error = $2
				WHERE id = $1
			`, job.ID, err.Error())
		}
	}
}
