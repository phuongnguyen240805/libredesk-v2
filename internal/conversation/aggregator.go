package conversation

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/abhinavxd/libredesk/internal/eventbus"
)

type AggregatorConfig struct {
	WindowDuration time.Duration
	MaxMessages    int
	MaxLength      int
}

type AggregatedBundle struct {
	WorkspaceID      string   `json:"workspace_id"`
	InboxID          string   `json:"inbox_id"`
	ExternalThreadID string   `json:"external_thread_id"`
	Channel          string   `json:"channel"`
	ChannelAccountID string   `json:"channel_account_id"`
	Messages         []string `json:"messages"`
	CombinedText     string   `json:"combined_text"`
}

type windowState struct {
	timer            *time.Timer
	messages         []string
	channel          string
	channelAccountID string
	workspaceID      string
	inboxID          string
	threadID         string
}

type MessageAggregator struct {
	mu         sync.Mutex
	windows    map[string]*windowState
	config     AggregatorConfig
	dispatcher *eventbus.Dispatcher
}

func NewMessageAggregator(config AggregatorConfig, dispatcher *eventbus.Dispatcher) *MessageAggregator {
	if config.WindowDuration == 0 {
		config.WindowDuration = 5 * time.Second
	}
	if config.MaxMessages == 0 {
		config.MaxMessages = 10
	}
	if config.MaxLength == 0 {
		config.MaxLength = 5000
	}

	return &MessageAggregator{
		windows:    make(map[string]*windowState),
		config:     config,
		dispatcher: dispatcher,
	}
}

// AddMessage accumulates a message in the debounce window.
func (a *MessageAggregator) AddMessage(ctx context.Context, evt eventbus.CanonicalEvent, text string) {
	key := fmt.Sprintf("%s:%s:%s", evt.WorkspaceID, evt.InboxID, evt.ExternalThreadID)

	a.mu.Lock()
	defer a.mu.Unlock()

	win, exists := a.windows[key]
	if !exists {
		win = &windowState{
			workspaceID:      evt.WorkspaceID,
			inboxID:          evt.InboxID,
			threadID:         evt.ExternalThreadID,
			channel:          evt.Channel,
			channelAccountID: evt.ChannelAccountID,
			messages:         make([]string, 0),
		}
		win.timer = time.AfterFunc(a.config.WindowDuration, func() {
			a.flushWindow(key)
		})
		a.windows[key] = win
	} else {
		// Reset window timer
		win.timer.Reset(a.config.WindowDuration)
	}

	win.messages = append(win.messages, text)

	// Check max count or max length limit for immediate flush
	totalLen := 0
	for _, m := range win.messages {
		totalLen += len(m)
	}

	if len(win.messages) >= a.config.MaxMessages || totalLen >= a.config.MaxLength {
		win.timer.Stop()
		go a.flushWindow(key)
	}
}

func (a *MessageAggregator) flushWindow(key string) {
	a.mu.Lock()
	win, exists := a.windows[key]
	if !exists {
		a.mu.Unlock()
		return
	}
	delete(a.windows, key)
	a.mu.Unlock()

	combinedText := ""
	for i, msg := range win.messages {
		if i > 0 {
			combinedText += "\n"
		}
		combinedText += msg
	}

	bundle := AggregatedBundle{
		WorkspaceID:      win.workspaceID,
		InboxID:          win.inboxID,
		ExternalThreadID: win.threadID,
		Channel:          win.channel,
		ChannelAccountID: win.channelAccountID,
		Messages:         win.messages,
		CombinedText:     combinedText,
	}

	payloadBytes, _ := json.Marshal(bundle)

	bundleEvent := eventbus.CanonicalEvent{
		ID:               fmt.Sprintf("bundle_%d", time.Now().UnixNano()),
		WorkspaceID:      win.workspaceID,
		Type:             eventbus.EventMessageBundleReady,
		Channel:          win.channel,
		ChannelAccountID: win.channelAccountID,
		ExternalEventID:  fmt.Sprintf("bundle_%s_%d", key, time.Now().UnixNano()),
		ExternalThreadID: win.threadID,
		Payload:          payloadBytes,
		OccurredAt:       time.Now(),
	}

	if a.dispatcher != nil {
		a.dispatcher.Dispatch(context.Background(), bundleEvent)
	}
}
