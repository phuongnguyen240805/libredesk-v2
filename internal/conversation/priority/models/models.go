package models

import "time"

type Priority struct {
	ID        int       `db:"id" json:"id"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
	Name      string    `db:"name" json:"name"`
}
