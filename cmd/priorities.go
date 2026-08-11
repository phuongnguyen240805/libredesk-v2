package main

import (
	"github.com/zerodha/fastglue"
)

// handleGetPriorities returns all priorities.
func handleGetPriorities(r *fastglue.Request) error {
	var app = r.Context.(*App)
	out, err := app.priority.GetAll()
	if err != nil {
		return sendErrorEnvelope(r, err)
	}
	return r.SendEnvelope(out)
}
