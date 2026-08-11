package models

import "time"

type ContextLink struct {
	ID                 int       `db:"id" json:"id"`
	CreatedAt          time.Time `db:"created_at" json:"created_at"`
	UpdatedAt          time.Time `db:"updated_at" json:"updated_at"`
	Name               string    `db:"name" json:"name"`
	URLTemplate        string    `db:"url_template" json:"url_template"`
	Secret             string    `db:"signing_secret" json:"secret"`
	TokenExpirySeconds int       `db:"token_expiry_seconds" json:"token_expiry_seconds"`
	IsActive           bool      `db:"is_active" json:"is_active"`
}
