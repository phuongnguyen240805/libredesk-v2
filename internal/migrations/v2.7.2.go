package migrations

import (
	"github.com/jmoiron/sqlx"
	"github.com/knadh/koanf/v2"
	"github.com/knadh/stuffbin"
)

// V2_7_2 adds the Facebook personal/E2EE inbox channel.
func V2_7_2(db *sqlx.DB, _ stuffbin.FileSystem, _ *koanf.Koanf) error {
	_, err := db.Exec(`ALTER TYPE channels ADD VALUE IF NOT EXISTS 'facebook_personal'`)
	return err
}
