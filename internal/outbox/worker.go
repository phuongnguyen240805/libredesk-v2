package outbox

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/jmoiron/sqlx"
)

type MessageSender interface {
	SendMessage(ctx context.Context, msg OutboxMessage) error
}

type Worker struct {
	db          *sqlx.DB
	sender      MessageSender
	rateLimiter *AccountRateLimiter
	workerID    string
	stopChan    chan struct{}
	wg          sync.WaitGroup
}

func NewWorker(db *sqlx.DB, sender MessageSender, workerID string) *Worker {
	return &Worker{
		db:          db,
		sender:      sender,
		rateLimiter: NewAccountRateLimiter(500 * time.Millisecond),
		workerID:    workerID,
		stopChan:    make(chan struct{}),
	}
}

func (w *Worker) Start(ctx context.Context, pollInterval time.Duration) {
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		ticker := time.NewTicker(pollInterval)
		defer ticker.Stop()

		for {
			select {
			case <-w.stopChan:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := w.processNextBatch(ctx); err != nil {
					log.Printf("[OutboxWorker] Error processing batch: %v", err)
				}
			}
		}
	}()
}

func (w *Worker) Stop() {
	close(w.stopChan)
	w.wg.Wait()
}

func (w *Worker) processNextBatch(ctx context.Context) error {
	// Fetch and lock pending messages using FOR UPDATE SKIP LOCKED
	tx, err := w.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	query := `
		SELECT id, workspace_id, conversation_id, message_id, inbox_id, channel_account_id,
		       operation, payload_json, idempotency_key, priority, status, attempt_count,
		       max_attempts, available_at, created_at, updated_at
		FROM message_outbox
		WHERE status IN ('pending', 'retry_wait') AND available_at <= NOW()
		ORDER BY priority DESC, created_at ASC
		LIMIT 10
		FOR UPDATE SKIP LOCKED;
	`

	var messages []OutboxMessage
	if err := tx.SelectContext(ctx, &messages, query); err != nil {
		return err
	}

	if len(messages) == 0 {
		return nil
	}

	// Mark locked
	for _, m := range messages {
		_, _ = tx.ExecContext(ctx, `
			UPDATE message_outbox
			SET status = 'processing', locked_at = NOW(), locked_by = $2, updated_at = NOW()
			WHERE id = $1
		`, m.ID, w.workerID)
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	// Process unlocked batch in Go
	for _, msg := range messages {
		w.rateLimiter.WaitIfNecessary(msg.ChannelAccountID)

		sendErr := w.sender.SendMessage(ctx, msg)
		if sendErr == nil {
			_, _ = w.db.ExecContext(ctx, `
				UPDATE message_outbox
				SET status = 'sent', locked_at = NULL, locked_by = NULL, updated_at = NOW()
				WHERE id = $1
			`, msg.ID)
		} else {
			nextAttempt := msg.AttemptCount + 1
			backoff := CalculateBackoff(nextAttempt)

			status := "retry_wait"
			if nextAttempt >= msg.MaxAttempts {
				status = "failed"
			}

			_, _ = w.db.ExecContext(ctx, `
				UPDATE message_outbox
				SET status = $2,
				    attempt_count = attempt_count + 1,
				    available_at = NOW() + $3::interval,
				    last_error_message = $4,
				    locked_at = NULL,
				    locked_by = NULL,
				    updated_at = NOW()
				WHERE id = $1
			`, msg.ID, status, fmt.Sprintf("%d seconds", int(backoff.Seconds())), sendErr.Error())
		}
	}

	return nil
}
