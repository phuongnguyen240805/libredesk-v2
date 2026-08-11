package outbox

import (
	"math/rand"
	"time"
)

// CalculateBackoff returns an exponential backoff duration with jitter.
func CalculateBackoff(attempt int) time.Duration {
	if attempt <= 0 {
		attempt = 1
	}
	// Base interval: 2 seconds
	base := 2.0
	// Max cap: 5 minutes
	maxCap := 300.0

	// 2 * 2^(attempt-1)
	backoff := base * float64(uint(1)<<uint(attempt-1))
	if backoff > maxCap {
		backoff = maxCap
	}

	// Add 10-30% jitter
	jitter := rand.Float64() * 0.2 * backoff
	total := backoff + jitter

	return time.Duration(total) * time.Second
}
