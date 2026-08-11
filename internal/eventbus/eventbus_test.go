package eventbus

import (
	"context"
	"testing"
	"time"
)

func TestDispatcher_SubscribeAndDispatch(t *testing.T) {
	dispatcher := NewDispatcher()
	received := false

	dispatcher.Subscribe(EventMessageReceived, func(ctx context.Context, evt CanonicalEvent) error {
		received = true
		if evt.Channel != "zalo" {
			t.Errorf("expected channel zalo, got %s", evt.Channel)
		}
		return nil
	})

	evt := CanonicalEvent{
		ID:          "evt-1",
		WorkspaceID: "ws-1",
		Type:        EventMessageReceived,
		Channel:     "zalo",
		OccurredAt:  time.Now(),
	}

	errs := dispatcher.Dispatch(context.Background(), evt)
	if len(errs) > 0 {
		t.Fatalf("expected no errors, got %v", errs)
	}

	if !received {
		t.Fatal("expected handler to be invoked")
	}
}
