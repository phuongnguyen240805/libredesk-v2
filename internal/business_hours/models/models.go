// Package models contains the data models for the businesshours package.
package models

import (
	"time"

	"github.com/jmoiron/sqlx/types"
	"github.com/volatiletech/null/v9"
)

// BusinessHours represents the business in the database.
type BusinessHours struct {
	ID           int            `db:"id" json:"id"`
	CreatedAt    time.Time      `db:"created_at" json:"created_at"`
	UpdatedAt    time.Time      `db:"updated_at" json:"updated_at"`
	Name         string         `db:"name" json:"name"`
	Description  null.String    `db:"description" json:"description"`
	IsAlwaysOpen bool           `db:"is_always_open" json:"is_always_open"`
	Holidays     types.JSONText `db:"holidays" json:"holidays"`
	Hours        types.JSONText `db:"hours" json:"hours"`
}

// WorkingHours represents the working hours for a specific day.
type WorkingHours struct {
	Open         string `json:"open"`
	Close        string `json:"close"`
}

// Holiday represents a holiday.
type Holiday struct {
	Name string `json:"name"`
	Date string `json:"date"`
}
