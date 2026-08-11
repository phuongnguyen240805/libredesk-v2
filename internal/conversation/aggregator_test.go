package conversation

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/abhinavxd/libredesk/internal/eventbus"
)

func TestMessageAggregator_DebounceWindow(t *testing.T) {
	dispatcher := eventbus.NewDispatcher()
	var wg sync.WaitGroup
	wg.Add(1)

	var receivedBundle AggregatedBundle

	dispatcher.Subscribe(eventbus.EventMessageBundleReady, func(ctx context.Context, evt eventbus.CanonicalEvent) error {
		defer wg.Done()
		_ = evt.Payload
		return nil
	})

	aggregator := NewMessageAggregator(AggregatorConfig{
		WindowDuration: 100 * time.Millisecond,
		MaxMessages:    5,
	}, dispatcher)

	evt := eventbus.CanonicalEvent{
		WorkspaceID:      "ws-1",
		InboxID:          "inbox-1",
		ExternalThreadID: "thread-1",
		Channel:          "zalo",
		ChannelAccountID: "acc-1",
	}

	aggregator.AddMessage(context.Background(), evt, "Xin chào")
	aggregator.AddMessage(context.Background(), evt, "Shop có hàng không?")

	wg.Wait()
	_ = receivedBundle
}
