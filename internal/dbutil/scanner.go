// Package dbutil provides utility functions for database operations.
package dbutil

import (
	"io/fs"

	"github.com/jmoiron/sqlx"
	"github.com/knadh/goyesql/v2"
	goyesqlx "github.com/knadh/goyesql/v2/sqlx"
)

// ScanSQLFile scans a goyesql .sql file from the given fs and prepares the queries in the given struct.
func ScanSQLFile(path string, o interface{}, db *sqlx.DB, f fs.FS) error {
	// Read the SQL file from the embedded filesystem.
	b, err := fs.ReadFile(f, path)
	if err != nil {
		return err
	}

	// Parse the SQL file.
	q, err := goyesql.ParseBytes(b)
	if err != nil {
		return err
	}

	// Scan the parsed queries into the provided struct and prepare them.
	if err := goyesqlx.ScanToStruct(o, q, db.Unsafe()); err != nil {
		return err
	}
	return nil
}
