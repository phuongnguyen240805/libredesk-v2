package migrations

import (
	"github.com/jmoiron/sqlx"
	"github.com/knadh/koanf/v2"
	"github.com/knadh/stuffbin"
)

// V2_7_1 adds the Zalo personal inbox channel. This is a separate migration
// from v2.7.0 so installations that already ran the Deplao foundation
// migration still receive the enum value.
func V2_7_1(db *sqlx.DB, _ stuffbin.FileSystem, _ *koanf.Koanf) error {
	_, err := db.Exec(`ALTER TYPE channels ADD VALUE IF NOT EXISTS 'zalo_personal'`)
	return err
}
