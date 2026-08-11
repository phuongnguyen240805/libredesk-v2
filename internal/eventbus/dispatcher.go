package eventbus

import (
	"context"
	"log"
	"sync"
)

type EventHandler func(ctx context.Context, evt CanonicalEvent) error

type Dispatcher struct {
	mu       sync.RWMutex
	handlers map[EventType][]EventHandler
}

func NewDispatcher() *Dispatcher {
	return &Dispatcher{
		handlers: make(map[EventType][]EventHandler),
	}
}

// Subscribe registers a handler for a specific event type.
func (d *Dispatcher) Subscribe(eventType EventType, handler EventHandler) {
	d.mu.Lock()
	defer d.mu.Unlock()

	d.handlers[eventType] = append(d.handlers[eventType], handler)
}

// Dispatch dispatches an event to all subscribed handlers asynchronously or synchronously.
func (d *Dispatcher) Dispatch(ctx context.Context, evt CanonicalEvent) []error {
	d.mu.RLock()
	handlers := append([]EventHandler{}, d.handlers[evt.Type]...)
	d.mu.RUnlock()

	var errs []error
	for _, h := range handlers {
		if err := h(ctx, evt); err != nil {
			log.Printf("Event handler error for type %s: %v", evt.Type, err)
			errs = append(errs, err)
		}
	}
	return errs
}
