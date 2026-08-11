package eventbus

import (
	"encoding/json"
	"time"
)

// EventType defines canonical event types.
type EventType string

const (
	EventMessageReceived      EventType = "conversation.message.received"
	EventMessageSent          EventType = "conversation.message.sent"
	EventMessageRecalled      EventType = "conversation.message.recalled"
	EventMessageBundleReady   EventType = "conversation.message.bundle_ready"
	EventReactionAdded        EventType = "conversation.reaction.added"
	EventReactionRemoved      EventType = "conversation.reaction.removed"
	EventConversationOpened   EventType = "conversation.opened"
	EventConversationAssigned EventType = "conversation.assigned"
	EventStatusChanged        EventType = "conversation.status.changed"
	EventContactUpdated       EventType = "contact.updated"
	EventTagAdded             EventType = "contact.tag.added"
	EventAccountDisconnected  EventType = "channel.account.disconnected"
	EventSessionExpired       EventType = "channel.account.session_expired"
	EventSLAWarning           EventType = "sla.warning"
	EventSLABreached          EventType = "sla.breached"
	EventFollowupDue          EventType = "followup.due"
)

// CanonicalEvent represents a normalized cross-channel event.
type CanonicalEvent struct {
	ID               string          `json:"id" db:"id"`
	WorkspaceID      string          `json:"workspace_id" db:"workspace_id"`
	Type             EventType       `json:"type" db:"event_type"`
	Channel          string          `json:"channel" db:"channel"`
	ChannelAccountID string          `json:"channel_account_id" db:"channel_account_id"`
	InboxID          string          `json:"inbox_id,omitempty" db:"-"`
	ExternalEventID  string          `json:"external_event_id" db:"external_event_id"`
	ExternalThreadID string          `json:"external_thread_id,omitempty"`
	Actor            Actor           `json:"actor,omitempty"`
	Payload          json.RawMessage `json:"payload" db:"payload"`
	Status           string          `json:"status" db:"status"` // pending, processing, processed, retry_wait, failed
	AttemptCount     int             `json:"attempt_count" db:"attempt_count"`
	AvailableAt      time.Time       `json:"available_at" db:"available_at"`
	ProcessedAt      *time.Time      `json:"processed_at,omitempty" db:"processed_at"`
	LastError        string          `json:"last_error,omitempty" db:"last_error"`
	OccurredAt       time.Time       `json:"occurred_at" db:"created_at"`
}

type Actor struct {
	ExternalID string `json:"external_id"`
	Name       string `json:"name,omitempty"`
	AvatarURL  string `json:"avatar_url,omitempty"`
}
