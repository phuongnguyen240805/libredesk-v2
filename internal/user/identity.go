package user

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
)

type ChannelIdentity struct {
	ID                string          `db:"id" json:"id"`
	WorkspaceID       string          `db:"workspace_id" json:"workspace_id"`
	ContactID         string          `db:"contact_id" json:"contact_id"`
	Channel           string          `db:"channel" json:"channel"`
	ChannelAccountID  string          `db:"channel_account_id" json:"channel_account_id"`
	ExternalContactID string          `db:"external_contact_id" json:"external_contact_id"`
	ExternalUsername  *string         `db:"external_username,omitempty" json:"external_username,omitempty"`
	VerifiedPhone     *string         `db:"verified_phone,omitempty" json:"verified_phone,omitempty"`
	VerifiedEmail     *string         `db:"verified_email,omitempty" json:"verified_email,omitempty"`
	Metadata          json.RawMessage `db:"metadata" json:"metadata"`
	LastSyncedAt      time.Time       `db:"last_synced_at" json:"last_synced_at"`
	CreatedAt         time.Time       `db:"created_at" json:"created_at"`
}

type IdentityStore struct {
	db *sqlx.DB
}

func NewIdentityStore(db *sqlx.DB) *IdentityStore {
	return &IdentityStore{db: db}
}

// LinkIdentity links a channel identity to a contact profile in Customer 360.
func (s *IdentityStore) LinkIdentity(ctx context.Context, identity ChannelIdentity) error {
	if identity.Metadata == nil {
		identity.Metadata = json.RawMessage("{}")
	}

	query := `
		INSERT INTO contact_channel_identities (
			workspace_id, contact_id, channel, channel_account_id, external_contact_id,
			external_username, verified_phone, verified_email, metadata, last_synced_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()
		)
		ON CONFLICT (workspace_id, channel, channel_account_id, external_contact_id)
		DO UPDATE SET
			external_username = EXCLUDED.external_username,
			verified_phone = COALESCE(EXCLUDED.verified_phone, contact_channel_identities.verified_phone),
			verified_email = COALESCE(EXCLUDED.verified_email, contact_channel_identities.verified_email),
			metadata = contact_channel_identities.metadata || EXCLUDED.metadata,
			last_synced_at = NOW();
	`

	_, err := s.db.ExecContext(ctx, query,
		identity.WorkspaceID,
		identity.ContactID,
		identity.Channel,
		identity.ChannelAccountID,
		identity.ExternalContactID,
		identity.ExternalUsername,
		identity.VerifiedPhone,
		identity.VerifiedEmail,
		identity.Metadata,
	)

	if err != nil {
		return fmt.Errorf("failed to link channel identity: %w", err)
	}
	return nil
}

// GetContactIdentities fetches all channel identities linked to a specific contact ID.
func (s *IdentityStore) GetContactIdentities(ctx context.Context, workspaceID, contactID string) ([]ChannelIdentity, error) {
	var identities []ChannelIdentity
	query := `
		SELECT id, workspace_id, contact_id, channel, channel_account_id, external_contact_id,
		       external_username, verified_phone, verified_email, metadata, last_synced_at, created_at
		FROM contact_channel_identities
		WHERE workspace_id = $1 AND contact_id = $2
		ORDER BY created_at ASC;
	`
	err := s.db.SelectContext(ctx, &identities, query, workspaceID, contactID)
	return identities, err
}

// FindContactByIdentity finds contact_id for a given channel identity.
func (s *IdentityStore) FindContactByIdentity(ctx context.Context, workspaceID, channel, channelAccountID, externalContactID string) (string, error) {
	query := `
		SELECT contact_id
		FROM contact_channel_identities
		WHERE workspace_id = $1 AND channel = $2 AND channel_account_id = $3 AND external_contact_id = $4;
	`
	var contactID string
	err := s.db.GetContext(ctx, &contactID, query, workspaceID, channel, channelAccountID, externalContactID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return contactID, err
}
