package outbox

import (
	"sync"
	"time"
)

type AccountRateLimiter struct {
	mu           sync.Mutex
	lastSent     map[string]time.Time
	minInterval  time.Duration
}

func NewAccountRateLimiter(minInterval time.Duration) *AccountRateLimiter {
	return &AccountRateLimiter{
		lastSent:    make(map[string]time.Time),
		minInterval: minInterval,
	}
}

// WaitIfNecessary blocks until the rate limit interval for the channel account has elapsed.
func (r *AccountRateLimiter) WaitIfNecessary(channelAccountID string) {
	r.mu.Lock()
	last, exists := r.lastSent[channelAccountID]
	now := time.Now()
	var waitTime time.Duration
	if exists {
		elapsed := now.Sub(last)
		if elapsed < r.minInterval {
			waitTime = r.minInterval - elapsed
		}
	}
	r.lastSent[channelAccountID] = now.Add(waitTime)
	r.mu.Unlock()

	if waitTime > 0 {
		time.Sleep(waitTime)
	}
}
