// Package facebook implements a LibreDesk inbox backed by the fbchat-v2 E2EE connector.
package facebook

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

const ChannelFacebookPersonal = "facebook_personal"

type Config struct {
	ChannelConnectionKey string `json:"channel_connection_key"`
	ConnectorURL   string `json:"connector_url"`
	ConnectorToken string `json:"connector_token"`
	AccountID      string `json:"account_id"`
	RequestTimeout string `json:"request_timeout"`
}

type Facebook struct {
	id         int
	name       string
	config     Config
	client     *http.Client
	lo         *logf.Logger
	baseURL    string
	cancelWait chan struct{}
}

type Opts struct {
	ID     int
	Name   string
	Config Config
	Lo     *logf.Logger
}

func New(_ inbox.MessageStore, _ inbox.UserStore, opts Opts) (*Facebook, error) {
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
	timeout := 30 * time.Second
	if opts.Config.RequestTimeout != "" {
		parsed, err := time.ParseDuration(opts.Config.RequestTimeout)
		if err != nil || parsed <= 0 || parsed > 2*time.Minute {
			return nil, fmt.Errorf("invalid request_timeout")
		}
		timeout = parsed
	}
	return &Facebook{id: opts.ID, name: opts.Name, config: opts.Config, client: &http.Client{Timeout: timeout}, lo: opts.Lo, baseURL: baseURL, cancelWait: make(chan struct{})}, nil
}

func (f *Facebook) Identifier() int          { return f.id }
func (f *Facebook) Name() string             { return f.name }
func (f *Facebook) FromAddress() string      { return "" }
func (f *Facebook) FromNameTemplate() string { return "" }
func (f *Facebook) ReplyToAddress() string   { return "" }
func (f *Facebook) Channel() string          { return ChannelFacebookPersonal }
func (f *Facebook) Receive(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return nil
	case <-f.cancelWait:
		return nil
	}
}
func (f *Facebook) Close() error {
	select {
	case <-f.cancelWait:
	default:
		close(f.cancelWait)
	}
	return nil
}

func (f *Facebook) Send(message models.OutboundMessage) error {
	var metadata struct {
		Facebook struct {
			ChannelConnectionKey string `json:"channel_connection_key"`
			AccountID        string `json:"account_id"`
			ExternalThreadID string `json:"external_thread_id"`
			ThreadType       string `json:"thread_type"`
		} `json:"facebook"`
	}
	if len(message.Meta) > 0 {
		if err := json.Unmarshal(message.Meta, &metadata); err != nil {
			return fmt.Errorf("decoding Facebook metadata: %w", err)
		}
	}
	if metadata.Facebook.ExternalThreadID == "" {
		return fmt.Errorf("missing facebook.external_thread_id in conversation metadata")
	}
	if metadata.Facebook.ChannelConnectionKey == "" {
		return fmt.Errorf("missing facebook.channel_connection_key in conversation metadata")
	}
	if metadata.Facebook.ThreadType != "group" {
		metadata.Facebook.ThreadType = "user"
	}
	text := strings.TrimSpace(message.TextContent)
	if text == "" {
		text = strings.TrimSpace(stringutil.HTML2Text(message.Content))
	}
	if text == "" && len(message.Attachments) == 0 {
		return fmt.Errorf("cannot send an empty Facebook message")
	}
	attachments := make([]map[string]any, 0, len(message.Attachments))
	for _, item := range message.Attachments {
		if len(item.Content) == 0 {
			return fmt.Errorf("attachment %q has no content", item.Name)
		}
		attachments = append(attachments, map[string]any{"name": item.Name, "mime_type": item.ContentType, "size": item.Size, "data": item.Content})
	}
	payload := map[string]any{"account_id": metadata.Facebook.AccountID, "external_thread_id": metadata.Facebook.ExternalThreadID, "thread_type": metadata.Facebook.ThreadType, "text": text, "client_message_id": message.UUID, "attachments": attachments}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, f.baseURL+"/sessions/"+metadata.Facebook.ChannelConnectionKey+"/messages/send", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Facebook-Connector-Token", f.config.ConnectorToken)
	resp, err := f.client.Do(req)
	if err != nil {
		return fmt.Errorf("calling Facebook connector: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("Facebook connector returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	f.lo.Debug("message accepted by Facebook connector", "message_uuid", message.UUID, "thread_id", metadata.Facebook.ExternalThreadID)
	return nil
}
