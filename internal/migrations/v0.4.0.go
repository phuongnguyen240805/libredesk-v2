package migrations

import (
	"github.com/jmoiron/sqlx"
	"github.com/knadh/koanf/v2"
	"github.com/knadh/stuffbin"
)

// V0_4_0 updates the database schema to v0.4.0.
func V0_4_0(db *sqlx.DB, fs stuffbin.FileSystem, ko *koanf.Koanf) error {
	// Admin role gets new permissions.
	_, err := db.Exec(`
		UPDATE roles 
		SET permissions = array_append(permissions, 'ai:manage')
		WHERE name = 'Admin' AND NOT ('ai:manage' = ANY(permissions));
	`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		UPDATE roles 
		SET permissions = array_append(permissions, 'conversations:write')
		WHERE name = 'Admin' AND NOT ('conversations:write' = ANY(permissions));
	`)
	if err != nil {
		return err
	}

	// Create trigram index on users.email if it doesn't exist.
	_, err = db.Exec(`
		CREATE INDEX IF NOT EXISTS index_tgrm_users_on_email 
		ON users USING GIN (email gin_trgm_ops);
	`)
	return err
}
