// Package zalo implements a LibreDesk inbox transport backed by a standalone
// zca-js connector service.
package zalo

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/abhinavxd/libredesk/internal/conversation/models"
	"github.com/abhinavxd/libredesk/internal/inbox"
	"github.com/abhinavxd/libredesk/internal/stringutil"
	"github.com/zerodha/logf"
)

const ChannelZaloPersonal = "zalo_personal"

// Config configures the external zca-js connector.
type Config struct {
	ChannelConnectionKey string `json:"channel_connection_key"`
	ConnectorURL   string `json:"connector_url"`
	ConnectorToken string `json:"connector_token"`
	AccountID      string `json:"account_id"`
	RequestTimeout string `json:"request_timeout"`
}

// Zalo is a transport adapter. Incoming messages are accepted by the
// /api/v1/channels/zalo/inbound HTTP endpoint; Send forwards outbound messages
// to the connector.
type Zalo struct {
	id         int
	name       string
	config     Config
	client     *http.Client
	lo         *logf.Logger
	baseURL    string
	cancelWait chan struct{}
}

// Opts contains constructor options.
type Opts struct {
	ID     int
	Name   string
	Config Config
	Lo     *logf.Logger
}

// New validates config and returns a Zalo inbox.
func New(_ inbox.MessageStore, _ inbox.UserStore, opts Opts) (*Zalo, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(opts.Config.ConnectorURL), "/")
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("invalid connector_url")
	}
	if strings.TrimSpace(opts.Config.ConnectorToken) == "" {
		return nil, fmt.Errorf("connector_token is required")
	}
	if strings.TrimSpace(opts.Config.AccountID) == "" {
		return nil, fmt.Errorf("account_id is required")
	}

	timeout := 15 * time.Second
	if opts.Config.RequestTimeout != "" {
		parsed, err := time.ParseDuration(opts.Config.RequestTimeout)
		if err != nil || parsed <= 0 || parsed > 2*time.Minute {
			return nil, fmt.Errorf("invalid request_timeout")
		}
		timeout = parsed
	}

	return &Zalo{
		id:         opts.ID,
		name:       opts.Name,
		config:     opts.Config,
		client:     &http.Client{Timeout: timeout},
		lo:         opts.Lo,
		baseURL:    baseURL,
		cancelWait: make(chan struct{}),
	}, nil
}

func (z *Zalo) Identifier() int          { return z.id }
func (z *Zalo) Name() string             { return z.name }
func (z *Zalo) FromAddress() string      { return "" }
func (z *Zalo) FromNameTemplate() string { return "" }
func (z *Zalo) ReplyToAddress() string   { return "" }
func (z *Zalo) Channel() string          { return ChannelZaloPersonal }

// Receive blocks until shutdown. The connector pushes inbound events over HTTP.
func (z *Zalo) Receive(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return nil
	case <-z.cancelWait:
		return nil
	}
}

// Close stops Receive.
func (z *Zalo) Close() error {
	select {
	case <-z.cancelWait:
	default:
		close(z.cancelWait)
	}
	return nil
}

// Send forwards a text and/or attachment message to the standalone connector.
func (z *Zalo) Send(message models.OutboundMessage) error {
	var metadata struct {
		Zalo struct {
			ChannelConnectionKey string `json:"channel_connection_key"`
			AccountID        string `json:"account_id"`
			ExternalThreadID string `json:"external_thread_id"`
			ThreadType       string `json:"thread_type"`
		} `json:"zalo"`
	}
	if len(message.Meta) > 0 {
		if err := json.Unmarshal(message.Meta, &metadata); err != nil {
			return fmt.Errorf("decoding Zalo conversation metadata: %w", err)
		}
	}
	if metadata.Zalo.ExternalThreadID == "" {
		return fmt.Errorf("missing zalo.external_thread_id in conversation metadata")
	}
	if metadata.Zalo.ChannelConnectionKey == "" {
		return fmt.Errorf("missing zalo.channel_connection_key in conversation metadata")
	}
	if metadata.Zalo.ThreadType != "group" {
		metadata.Zalo.ThreadType = "user"
	}

	text := strings.TrimSpace(message.TextContent)
	if text == "" {
		text = strings.TrimSpace(stringutil.HTML2Text(message.Content))
	}
	if text == "" && len(message.Attachments) == 0 {
		return fmt.Errorf("cannot send an empty Zalo message")
	}

	attachments := make([]map[string]any, 0, len(message.Attachments))
	for _, item := range message.Attachments {
		if len(item.Content) == 0 {
			return fmt.Errorf("attachment %q has no content", item.Name)
		}
		attachments = append(attachments, map[string]any{
			"name":      item.Name,
			"mime_type": item.ContentType,
			"size":      item.Size,
			"data":      item.Content,
		})
	}

	payload := map[string]any{
		"account_id":         metadata.Zalo.AccountID,
		"external_thread_id": metadata.Zalo.ExternalThreadID,
		"thread_type":        metadata.Zalo.ThreadType,
		"text":               text,
		"client_message_id":  message.UUID,
		"attachments":        attachments,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encoding connector request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, z.baseURL+"/sessions/"+metadata.Zalo.ChannelConnectionKey+"/messages/send", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("creating connector request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zalo-Connector-Token", z.config.ConnectorToken)

	resp, err := z.client.Do(req)
	if err != nil {
		return fmt.Errorf("calling Zalo connector: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("Zalo connector returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	z.lo.Debug("message accepted by Zalo connector", "message_uuid", message.UUID, "thread_id", metadata.Zalo.ExternalThreadID)
	return nil
}
