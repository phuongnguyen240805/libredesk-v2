package models

import "time"

type Tag struct {
	ID        int       `db:"id" json:"id"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
	UpdateAt  time.Time `db:"updated_at" json:"updated_at"`
	Name      string    `db:"name" json:"name"`
}
