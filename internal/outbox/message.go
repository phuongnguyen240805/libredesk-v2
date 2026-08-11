package outbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
)

type OutboxStatus string

const (
	StatusPending   OutboxStatus = "pending"
	StatusProcessing OutboxStatus = "processing"
	StatusSent      OutboxStatus = "sent"
	StatusRetryWait OutboxStatus = "retry_wait"
	StatusFailed    OutboxStatus = "failed"
)

type OutboxMessage struct {
	ID               string          `db:"id" json:"id"`
	WorkspaceID      string          `db:"workspace_id" json:"workspace_id"`
	ConversationID   string          `db:"conversation_id" json:"conversation_id"`
	MessageID        string          `db:"message_id" json:"message_id"`
	InboxID          string          `db:"inbox_id" json:"inbox_id"`
	ChannelAccountID string          `db:"channel_account_id" json:"channel_account_id"`
	Operation        string          `db:"operation" json:"operation"`
	PayloadJSON      json.RawMessage `db:"payload_json" json:"payload_json"`
	IdempotencyKey   string          `db:"idempotency_key" json:"idempotency_key"`
	Priority         int             `db:"priority" json:"priority"`
	Status           OutboxStatus    `db:"status" json:"status"`
	AttemptCount     int             `db:"attempt_count" json:"attempt_count"`
	MaxAttempts      int             `db:"max_attempts" json:"max_attempts"`
	AvailableAt      time.Time       `db:"available_at" json:"available_at"`
	LockedAt         *time.Time      `db:"locked_at,omitempty" json:"locked_at,omitempty"`
	LockedBy         *string         `db:"locked_by,omitempty" json:"locked_by,omitempty"`
	LastErrorCtx     *string         `db:"last_error_message,omitempty" json:"last_error_message,omitempty"`
	CreatedAt        time.Time       `db:"created_at" json:"created_at"`
	UpdatedAt        time.Time       `db:"updated_at" json:"updated_at"`
}

type Store struct {
	db *sqlx.DB
}

func NewStore(db *sqlx.DB) *Store {
	return &Store{db: db}
}

// EnqueueTx enqueues an outbound message job inside an active SQL transaction.
func (s *Store) EnqueueTx(ctx context.Context, tx *sql.Tx, msg OutboxMessage) error {
	if msg.PayloadJSON == nil {
		msg.PayloadJSON = json.RawMessage("{}")
	}
	if msg.MaxAttempts <= 0 {
		msg.MaxAttempts = 5
	}
	if msg.Operation == "" {
		msg.Operation = "send_message"
	}

	query := `
		INSERT INTO message_outbox (
			workspace_id, conversation_id, message_id, inbox_id, channel_account_id,
			operation, payload_json, idempotency_key, priority, status, max_attempts, available_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, NOW()
		)
		ON CONFLICT (workspace_id, idempotency_key) DO NOTHING;
	`

	var err error
	if tx != nil {
		_, err = tx.ExecContext(ctx, query,
			msg.WorkspaceID, msg.ConversationID, msg.MessageID, msg.InboxID, msg.ChannelAccountID,
			msg.Operation, msg.PayloadJSON, msg.IdempotencyKey, msg.Priority, msg.MaxAttempts,
		)
	} else {
		_, err = s.db.ExecContext(ctx, query,
			msg.WorkspaceID, msg.ConversationID, msg.MessageID, msg.InboxID, msg.ChannelAccountID,
			msg.Operation, msg.PayloadJSON, msg.IdempotencyKey, msg.Priority, msg.MaxAttempts,
		)
	}

	if err != nil {
		return fmt.Errorf("failed to enqueue message to outbox: %w", err)
	}
	return nil
}
