package migrations

import (
	"github.com/jmoiron/sqlx"
	"github.com/knadh/koanf/v2"
	"github.com/knadh/stuffbin"
)

func V2_7_0(db *sqlx.DB, fs stuffbin.FileSystem, ko *koanf.Koanf) error {
	// 1. integration_events
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS integration_events (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			workspace_id UUID NOT NULL,
			event_type VARCHAR(100) NOT NULL,
			channel VARCHAR(50) NOT NULL,
			channel_account_id UUID NOT NULL,
			external_event_id VARCHAR(255) NOT NULL,
			payload JSONB NOT NULL DEFAULT '{}',
			status VARCHAR(20) NOT NULL DEFAULT 'pending',
			attempt_count INT NOT NULL DEFAULT 0,
			available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			processed_at TIMESTAMPTZ,
			last_error TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			CONSTRAINT idx_integration_events_unique UNIQUE(workspace_id, channel, channel_account_id, external_event_id)
		);
	`); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_integration_events_status ON integration_events(status, available_at);`); err != nil {
		return err
	}

	// 2. message_outbox
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS message_outbox (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			workspace_id UUID NOT NULL,
			conversation_id UUID NOT NULL,
			message_id UUID NOT NULL,
			inbox_id UUID NOT NULL,
			channel_account_id UUID NOT NULL,
			operation VARCHAR(50) NOT NULL DEFAULT 'send_message',
			payload_json JSONB NOT NULL DEFAULT '{}',
			idempotency_key VARCHAR(255) NOT NULL,
			priority INT NOT NULL DEFAULT 0,
			status VARCHAR(20) NOT NULL DEFAULT 'pending',
			attempt_count INT NOT NULL DEFAULT 0,
			max_attempts INT NOT NULL DEFAULT 5,
			available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			locked_at TIMESTAMPTZ,
			locked_by VARCHAR(100),
			last_error_code VARCHAR(50),
			last_error_message TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			CONSTRAINT idx_message_outbox_idempotency UNIQUE(workspace_id, idempotency_key)
		);
	`); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_message_outbox_queue ON message_outbox(channel_account_id, status, available_at, priority DESC);`); err != nil {
		return err
	}

	// 3. scheduled_jobs
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS scheduled_jobs (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			workspace_id UUID NOT NULL,
			job_type VARCHAR(100) NOT NULL,
			entity_type VARCHAR(50) NOT NULL,
			entity_id UUID NOT NULL,
			payload JSONB NOT NULL DEFAULT '{}',
			run_at TIMESTAMPTZ NOT NULL,
			status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
			attempt_count INT NOT NULL DEFAULT 0,
			deduplication_key VARCHAR(255),
			executed_at TIMESTAMPTZ,
			last_error TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(status, run_at);`); err != nil {
		return err
	}

	// 4. contact_channel_identities
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS contact_channel_identities (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			workspace_id UUID NOT NULL,
			contact_id UUID NOT NULL,
			channel VARCHAR(50) NOT NULL,
			channel_account_id UUID NOT NULL,
			external_contact_id VARCHAR(255) NOT NULL,
			external_username VARCHAR(255),
			verified_phone VARCHAR(50),
			verified_email VARCHAR(255),
			metadata JSONB NOT NULL DEFAULT '{}',
			last_synced_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			CONSTRAINT idx_contact_identities_unique UNIQUE(workspace_id, channel, channel_account_id, external_contact_id)
		);
	`); err != nil {
		return err
	}

	// 5. automation_runs & automation_node_runs
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS automation_runs (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			workspace_id UUID NOT NULL,
			workflow_id UUID NOT NULL,
			trigger_event VARCHAR(100) NOT NULL,
			conversation_id UUID,
			status VARCHAR(20) NOT NULL,
			error_summary TEXT,
			started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			finished_at TIMESTAMPTZ
		);
	`); err != nil {
		return err
	}

	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS automation_node_runs (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			run_id UUID NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
			node_id VARCHAR(100) NOT NULL,
			node_type VARCHAR(50) NOT NULL,
			input_data JSONB,
			output_data JSONB,
			status VARCHAR(20) NOT NULL,
			duration_ms INT,
			error_details TEXT,
			executed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`); err != nil {
		return err
	}

	return nil
}
