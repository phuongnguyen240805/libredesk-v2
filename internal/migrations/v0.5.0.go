package migrations

import (
	"github.com/jmoiron/sqlx"
	"github.com/knadh/koanf/v2"
	"github.com/knadh/stuffbin"
)

// V0_5_0 updates the database schema to v0.5.0.
func V0_5_0(db *sqlx.DB, fs stuffbin.FileSystem, ko *koanf.Koanf) error {
	_, err := db.Exec(`
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'applied_sla_status') THEN
				CREATE TYPE "applied_sla_status" AS ENUM ('pending', 'breached', 'met', 'partially_met');
			END IF;
		END$$;
	`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		ALTER TABLE applied_slas ADD COLUMN IF NOT EXISTS status applied_sla_status DEFAULT 'pending' NOT NULL;
	`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		CREATE INDEX IF NOT EXISTS index_applied_slas_on_status ON applied_slas(status);
	`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		INSERT INTO settings (key, value)
		VALUES 
			('notification.email.tls_type', '"starttls"'::jsonb),
			('notification.email.tls_skip_verify', 'false'::jsonb),
			('notification.email.hello_hostname', '""'::jsonb)
		ON CONFLICT (key) DO NOTHING;
	`)
	if err != nil {
		return err
	}

	// Update tls_type for IMAP
	_, err = db.Exec(`
		UPDATE inboxes
		SET config = jsonb_set(config, '{imap,0,tls_type}', '"tls"', true)
		WHERE config->'imap' IS NOT NULL AND config#>'{imap,0,tls_type}' IS NULL;
	`)
	if err != nil {
		return err
	}

	// Update tls_skip_verify for IMAP
	_, err = db.Exec(`
		UPDATE inboxes
		SET config = jsonb_set(config, '{imap,0,tls_skip_verify}', 'false', true)
		WHERE config->'imap' IS NOT NULL AND config#>'{imap,0,tls_skip_verify}' IS NULL;
	`)
	if err != nil {
		return err
	}

	// Update scan_inbox_since for IMAP
	_, err = db.Exec(`
		UPDATE inboxes
		SET config = jsonb_set(config, '{imap,0,scan_inbox_since}', '"48h"', true)
		WHERE config->'imap' IS NOT NULL AND config#>'{imap,0,scan_inbox_since}' IS NULL;
	`)
	if err != nil {
		return err
	}

	// Update tls_type for SMTP
	_, err = db.Exec(`
		UPDATE inboxes
		SET config = jsonb_set(config, '{smtp,0,tls_type}', '"starttls"', true)
		WHERE config->'smtp' IS NOT NULL AND config#>'{smtp,0,tls_type}' IS NULL;
	`)
	if err != nil {
		return err
	}

	// Update tls_skip_verify for SMTP
	_, err = db.Exec(`
		UPDATE inboxes
		SET config = jsonb_set(config, '{smtp,0,tls_skip_verify}', 'false', true)
		WHERE config->'smtp' IS NOT NULL AND config#>'{smtp,0,tls_skip_verify}' IS NULL;
	`)
	if err != nil {
		return err
	}

	// Update hello_hostname for SMTP
	_, err = db.Exec(`
		UPDATE inboxes
		SET config = jsonb_set(config, '{smtp,0,hello_hostname}', '""', true)
		WHERE config->'smtp' IS NOT NULL AND config#>'{smtp,0,hello_hostname}' IS NULL;
	`)
	if err != nil {
		return err
	}

	// Add notifications column to sla_policies
	_, err = db.Exec(`
		ALTER TABLE sla_policies 
			ADD COLUMN IF NOT EXISTS notifications JSONB DEFAULT '[]'::jsonb NOT NULL;
	`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sla_metric') THEN
				CREATE TYPE "sla_metric" AS ENUM ('first_response', 'resolution');
			END IF;
		END$$;
	`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sla_notification_type') THEN
				CREATE TYPE "sla_notification_type" AS ENUM ('warning', 'breach');
			END IF;
		END$$;
	`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS scheduled_sla_notifications (
			id BIGSERIAL PRIMARY KEY,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW(),
			applied_sla_id BIGINT NOT NULL REFERENCES applied_slas(id) ON DELETE CASCADE,
			metric sla_metric NOT NULL,
			notification_type sla_notification_type NOT NULL,
			recipients TEXT[] NOT NULL,
			send_at TIMESTAMPTZ NOT NULL,
			processed_at TIMESTAMPTZ
		);
		CREATE INDEX IF NOT EXISTS index_scheduled_sla_notifications_on_send_at ON scheduled_sla_notifications(send_at);
		CREATE INDEX IF NOT EXISTS index_scheduled_sla_notifications_on_processed_at ON scheduled_sla_notifications(processed_at);
	`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM templates WHERE "name" = 'SLA breach warning') THEN
				INSERT INTO templates
					("type", body, is_default, "name", subject, is_builtin)
					VALUES (
					'email_notification'::template_type,
					'

					<p>This is a notification that the SLA for conversation {{ .Conversation.ReferenceNumber }} is approaching the SLA deadline for {{ .SLA.Metric }}.</p>

					<p>
					Details:<br>
					- Conversation reference number: {{ .Conversation.ReferenceNumber }}<br>
					- Metric: {{ .SLA.Metric }}<br>
					- Due in: {{ .SLA.DueIn }}
					</p>

					<p>
						<a href="{{ RootURL }}/inboxes/assigned/conversation/{{ .Conversation.UUID }}">View Conversation</a>
					</p>


					<p>
					Best regards,<br>
					libredesk
					</p>

					',
					false,
					'SLA breach warning',
					'SLA Alert: Conversation {{ .Conversation.ReferenceNumber }} is approaching SLA deadline for {{ .SLA.Metric }}',
					true
				);
			END IF;
		END$$;
	`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM templates WHERE "name" = 'SLA breached') THEN
				INSERT INTO templates
					("type", body, is_default, "name", subject, is_builtin)
					VALUES (
					'email_notification'::template_type,
					'
					<p>This is an urgent alert that the SLA for conversation {{ .Conversation.ReferenceNumber }} has been breached for {{ .SLA.Metric }}. Please take immediate action.</p>

					<p>
					Details:<br>
					- Conversation reference number: {{ .Conversation.ReferenceNumber }}<br>
					- Metric: {{ .SLA.Metric }}<br>
					- Overdue by: {{ .SLA.OverdueBy }}
					</p>

					<p>
						<a href="{{ RootURL }}/inboxes/assigned/conversation/{{ .Conversation.UUID }}">View Conversation</a>
					</p>


					<p>
					Best regards,<br>
					libredesk
					</p>

					',
					false,
					'SLA breached',
					'Urgent: SLA Breach for Conversation {{ .Conversation.ReferenceNumber }} for {{ .SLA.Metric }}',
					true
					);

			END IF;
		END$$;
	`)
	if err != nil {
		return err
	}


	return nil
}
