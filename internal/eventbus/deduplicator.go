package eventbus

import (
	"context"
	"fmt"
)

type Deduplicator struct {
	store *InboxStore
}

func NewDeduplicator(store *InboxStore) *Deduplicator {
	return &Deduplicator{store: store}
}

// IsDuplicate checks if an event with the given unique parameters has already been stored/processed.
func (d *Deduplicator) ProcessOnce(ctx context.Context, evt CanonicalEvent, handler func(ctx context.Context, e CanonicalEvent) error) (bool, error) {
	inserted, err := d.store.StoreEvent(ctx, evt)
	if err != nil {
		return false, fmt.Errorf("deduplicator check error: %w", err)
	}

	if !inserted {
		// Event was already stored (duplicate)
		return true, nil
	}

	// Execute handler for new event
	if err := handler(ctx, evt); err != nil {
		_ = d.store.MarkFailed(ctx, evt.ID, err, 10) // retry in 10s
		return false, err
	}

	_ = d.store.MarkProcessed(ctx, evt.ID)
	return false, nil
}
