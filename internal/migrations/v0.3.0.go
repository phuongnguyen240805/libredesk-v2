package migrations

import (
	"github.com/jmoiron/sqlx"
	"github.com/knadh/koanf/v2"
	"github.com/knadh/stuffbin"
)

// V0_3_0 updates the database schema to v0.3.0.
func V0_3_0(db *sqlx.DB, fs stuffbin.FileSystem, ko *koanf.Koanf) error {
	_, err := db.Exec(`
	DO $$
	BEGIN
		IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_availability_status') THEN
			CREATE TYPE user_availability_status AS ENUM ('online', 'away', 'away_manual', 'offline');
		END IF;
	END$$;
	ALTER TABLE users ADD COLUMN IF NOT EXISTS availability_status user_availability_status DEFAULT 'offline' NOT NULL;
	ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NULL;
	`)
	return err
}
