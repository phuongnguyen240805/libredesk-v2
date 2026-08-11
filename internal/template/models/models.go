package models

import (
	"time"

	"github.com/volatiletech/null/v9"
)

type Template struct {
	ID        int         `db:"id" json:"id"`
	CreatedAt time.Time   `db:"created_at" json:"created_at"`
	UpdatedAt time.Time   `db:"updated_at" json:"updated_at"`
	Type      string      `db:"type" json:"type"`
	Name      string      `db:"name" json:"name"`
	Subject   null.String `db:"subject" json:"subject"`
	Body      string      `db:"body" json:"body"`
	IsDefault bool        `db:"is_default" json:"is_default"`
	IsBuiltIn bool        `db:"is_builtin" json:"is_builtin"`
}
