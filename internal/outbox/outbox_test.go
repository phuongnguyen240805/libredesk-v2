package outbox

import (
	"testing"
	"time"
)

func TestCalculateBackoff(t *testing.T) {
	b1 := CalculateBackoff(1)
	if b1 < 2*time.Second || b1 > 3*time.Second {
		t.Errorf("expected backoff ~2s, got %v", b1)
	}

	b2 := CalculateBackoff(2)
	if b2 < 4*time.Second || b2 > 6*time.Second {
		t.Errorf("expected backoff ~4s, got %v", b2)
	}
}

func TestAccountRateLimiter(t *testing.T) {
	limiter := NewAccountRateLimiter(100 * time.Millisecond)

	start := time.Now()
	limiter.WaitIfNecessary("acc_1")
	limiter.WaitIfNecessary("acc_1")
	elapsed := time.Since(start)

	if elapsed < 90*time.Millisecond {
		t.Errorf("rate limiter should have delayed second call, elapsed: %v", elapsed)
	}
}
