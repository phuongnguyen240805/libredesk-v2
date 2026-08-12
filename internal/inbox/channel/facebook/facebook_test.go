package facebook

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/abhinavxd/libredesk/internal/conversation/models"
	"github.com/zerodha/logf"
)

func TestSendFallsBackToSessionScopedInboxConfig(t *testing.T) {
	var gotPath string
	var gotPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	logger := logf.New(logf.Opts{})
	channel, err := New(nil, nil, Opts{
		ID:   4,
		Name: "Facebook personal",
		Config: Config{
			ChannelConnectionKey: "connection-current",
			ConnectorURL:         server.URL,
			ConnectorToken:       "secret",
			AccountID:            "account-current",
		},
		Lo: &logger,
	})
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}

	err = channel.Send(models.OutboundMessage{
		UUID:        "message-1",
		TextContent: "hello",
		Meta:        json.RawMessage(`{"facebook":{"external_thread_id":"thread-1","thread_type":"user"}}`),
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if gotPath != "/sessions/connection-current/messages/send" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotPayload["account_id"] != "account-current" {
		t.Fatalf("account_id = %#v", gotPayload["account_id"])
	}
}

func TestSendDoesNotOverrideConversationConnectionKey(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	logger := logf.New(logf.Opts{})
	channel, err := New(nil, nil, Opts{
		Config: Config{
			ChannelConnectionKey: "connection-current",
			ConnectorURL:         server.URL,
			ConnectorToken:       "secret",
			AccountID:            "account-current",
		},
		Lo: &logger,
	})
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}

	err = channel.Send(models.OutboundMessage{
		UUID:        "message-2",
		TextContent: "hello",
		Meta:        json.RawMessage(`{"facebook":{"channel_connection_key":"connection-from-conversation","account_id":"account-from-conversation","external_thread_id":"thread-2"}}`),
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if gotPath != "/sessions/connection-from-conversation/messages/send" {
		t.Fatalf("path = %q", gotPath)
	}
}
