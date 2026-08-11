// Copyright Kailash Nadh (https://github.com/knadh/listmonk)
// SPDX-License-Identifier: AGPL-3.0
// Adapted from listmonk for Libredesk.

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"time"

	"golang.org/x/mod/semver"
)

const updateCheckURL = "https://updates.libredesk.io/updates.json"

type AppUpdate struct {
	Update struct {
		ReleaseVersion string `json:"release_version"`
		ReleaseDate    string `json:"release_date"`
		URL            string `json:"url"`
		Description    string `json:"description"`

		// This is computed and set locally based on the local version.
		IsNew bool `json:"is_new"`
	} `json:"update"`
	Messages []struct {
		Date        string `json:"date"`
		Title       string `json:"title"`
		Description string `json:"description"`
		URL         string `json:"url"`
		Priority    string `json:"priority"`
	} `json:"messages"`
}

var reSemver = regexp.MustCompile(`-(.*)`)

// checkUpdates is a blocking function that checks for updates to the app
// at the given intervals. On detecting a new update (new semver), it
// sets the global update status that renders a prompt on the UI.
func checkUpdates(curVersion string, interval time.Duration, app *App) {
	// Strip -* suffix.
	curVersion = reSemver.ReplaceAllString(curVersion, "")

	fnCheck := func() {
		resp, err := http.Get(updateCheckURL)
		if err != nil {
			app.lo.Error("error checking for app updates", "err", err)
			return
		}

		if resp.StatusCode != 200 {
			app.lo.Error("non-ok status code checking for app updates", "status", resp.StatusCode)
			return
		}

		b, err := io.ReadAll(resp.Body)
		if err != nil {
			app.lo.Error("error reading response body", "err", err)
			return
		}
		resp.Body.Close()

		var out AppUpdate
		if err := json.Unmarshal(b, &out); err != nil {
			app.lo.Error("error unmarshalling response body", "err", err)
			return
		}

		// There is an update. Set it on the global app state.
		if semver.IsValid(out.Update.ReleaseVersion) {
			v := reSemver.ReplaceAllString(out.Update.ReleaseVersion, "")
			if semver.Compare(v, curVersion) > 0 {
				out.Update.IsNew = true
				app.lo.Info("new update available", "version", out.Update.ReleaseVersion)
			}
		}

		app.Lock()
		app.update = &out
		app.Unlock()
	}

	// Give a 5 minute buffer after app start in case the admin wants to disable
	// update checks entirely and not make a request to upstream.
	time.Sleep(time.Minute * 5)
	fnCheck()

	// Thereafter, check every $interval.
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for range ticker.C {
		fnCheck()
	}
}
