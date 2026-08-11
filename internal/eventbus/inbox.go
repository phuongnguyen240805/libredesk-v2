package eventbus

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
)

type InboxStore struct {
	db *sqlx.DB
}

func NewInboxStore(db *sqlx.DB) *InboxStore {
	return &InboxStore{db: db}
}

// StoreEvent stores an event into integration_events. Returns true if inserted, false if duplicate.
func (s *InboxStore) StoreEvent(ctx context.Context, evt CanonicalEvent) (bool, error) {
	if evt.Payload == nil {
		evt.Payload = json.RawMessage("{}")
	}

	query := `
		INSERT INTO integration_events (
			workspace_id, event_type, channel, channel_account_id, external_event_id, payload, status, available_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, 'pending', NOW()
		)
		ON CONFLICT (workspace_id, channel, channel_account_id, external_event_id) DO NOTHING
		RETURNING id, created_at;
	`

	var id string
	var createdAt time.Time
	err := s.db.QueryRowContext(ctx, query,
		evt.WorkspaceID,
		evt.Type,
		evt.Channel,
		evt.ChannelAccountID,
		evt.ExternalEventID,
		evt.Payload,
	).Scan(&id, &createdAt)

	if err != nil {
		if err == sql.ErrNoRows {
			// Duplicate event - skipped due to ON CONFLICT DO NOTHING
			return false, nil
		}
		return false, fmt.Errorf("failed to store integration event: %w", err)
	}

	return true, nil
}

// MarkProcessed updates status to processed.
func (s *InboxStore) MarkProcessed(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE integration_events
		SET status = 'processed', processed_at = NOW()
		WHERE id = $1
	`, id)
	return err
}

// MarkFailed updates status and sets error details for retry or dead-letter.
func (s *InboxStore) MarkFailed(ctx context.Context, id string, lastErr error, nextRetryIn time.Duration) error {
	errMsg := ""
	if lastErr != nil {
		errMsg = lastErr.Error()
	}

	_, err := s.db.ExecContext(ctx, `
		UPDATE integration_events
		SET status = CASE WHEN attempt_count >= 5 THEN 'failed' ELSE 'retry_wait' END,
		    attempt_count = attempt_count + 1,
		    last_error = $2,
		    available_at = NOW() + $3::interval
		WHERE id = $1
	`, id, errMsg, fmt.Sprintf("%d seconds", int(nextRetryIn.Seconds())))
	return err
}

// FetchPendingEvents fetches available pending or retry_wait events for processing.
func (s *InboxStore) FetchPendingEvents(ctx context.Context, limit int) ([]CanonicalEvent, error) {
	var events []CanonicalEvent
	query := `
		SELECT id, workspace_id, event_type, channel, channel_account_id, external_event_id,
		       payload, status, attempt_count, available_at, processed_at, COALESCE(last_error, '') as last_error, created_at
		FROM integration_events
		WHERE status IN ('pending', 'retry_wait') AND available_at <= NOW()
		ORDER BY created_at ASC
		LIMIT $1
	`
	err := s.db.SelectContext(ctx, &events, query, limit)
	return events, err
}
