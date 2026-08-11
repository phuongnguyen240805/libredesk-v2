package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/abhinavxd/libredesk/internal/conversation/models"
	"github.com/abhinavxd/libredesk/internal/envelope"
	"github.com/abhinavxd/libredesk/internal/inbox"
	"github.com/abhinavxd/libredesk/internal/inbox/channel/facebook"
	imodels "github.com/abhinavxd/libredesk/internal/inbox/models"
	"github.com/valyala/fasthttp"
	"github.com/volatiletech/null/v9"
	"github.com/zerodha/fastglue"
)

type facebookInboundRequest struct {
	ChannelConnectionKey string `json:"channel_connection_key"`
	AccountID         string `json:"account_id"`
	ExternalThreadID  string `json:"external_thread_id"`
	ExternalMessageID string `json:"external_message_id"`
	ConversationUUID  string `json:"conversation_uuid"`
	ThreadType        string `json:"thread_type"`
	OccurredAt        string `json:"occurred_at"`
	Sender            struct {
		ExternalID  string `json:"external_id"`
		DisplayName string `json:"display_name"`
		AvatarURL   string `json:"avatar_url"`
	} `json:"sender"`
	Message struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"message"`
}

type facebookInboundResponse struct {
	MessageUUID      string `json:"message_uuid"`
	ConversationUUID string `json:"conversation_uuid"`
	Duplicate        bool   `json:"duplicate"`
}

func handleFacebookInbound(r *fastglue.Request) error {
	app := r.Context.(*App)
	var req facebookInboundRequest
	if err := r.Decode(&req, "json"); err != nil {
		return r.SendErrorEnvelope(fasthttp.StatusBadRequest, app.i18n.T("errors.parsingRequest"), err.Error(), envelope.InputError)
	}
	req.AccountID = strings.TrimSpace(req.AccountID)
	req.ChannelConnectionKey = strings.TrimSpace(req.ChannelConnectionKey)
	req.ExternalThreadID = strings.TrimSpace(req.ExternalThreadID)
	req.ExternalMessageID = strings.TrimSpace(req.ExternalMessageID)
	req.ConversationUUID = strings.TrimSpace(req.ConversationUUID)
	req.Sender.ExternalID = strings.TrimSpace(req.Sender.ExternalID)
	req.Sender.DisplayName = strings.TrimSpace(req.Sender.DisplayName)
	req.Message.Text = strings.TrimSpace(req.Message.Text)
	if req.ThreadType != "group" {
		req.ThreadType = "user"
	}
	if req.ChannelConnectionKey == "" || req.AccountID == "" || req.ExternalThreadID == "" || req.ExternalMessageID == "" || req.Sender.ExternalID == "" || req.Message.Text == "" {
		return r.SendErrorEnvelope(fasthttp.StatusBadRequest, "Missing required Facebook event fields", nil, envelope.InputError)
	}
	inboxRecord, _, err := findAuthorizedFacebookInbox(app, req.ChannelConnectionKey, req.AccountID, string(r.RequestCtx.Request.Header.Peek("X-Facebook-Connector-Token")))
	if err != nil {
		return r.SendErrorEnvelope(fasthttp.StatusUnauthorized, "Invalid Facebook connector credentials", nil, envelope.UnauthorizedError)
	}
	if exists, err := app.conversation.MessageExists(req.ExternalMessageID); err != nil {
		return sendErrorEnvelope(r, err)
	} else if exists {
		conversationUUID, err := app.conversation.GetConversationUUIDBySourceID(req.ExternalMessageID)
		if err != nil {
			return sendErrorEnvelope(r, err)
		}
		return r.SendEnvelope(facebookInboundResponse{ConversationUUID: conversationUUID, Duplicate: true})
	}
	meta := map[string]any{"facebook": map[string]any{"channel_connection_key": req.ChannelConnectionKey, "account_id": req.AccountID, "external_thread_id": req.ExternalThreadID, "external_message_id": req.ExternalMessageID, "thread_type": req.ThreadType, "sender_external_id": req.Sender.ExternalID, "sender_avatar_url": req.Sender.AvatarURL, "occurred_at": parseFacebookOccurredAt(req.OccurredAt)}}
	metaJSON, _ := json.Marshal(meta)
	incoming := models.IncomingMessage{Channel: inbox.ChannelFacebookPersonal, InboxID: inboxRecord.ID, Contact: models.IncomingContact{FirstName: req.Sender.DisplayName, Email: null.StringFrom(syntheticFacebookEmail(req.ChannelConnectionKey, req.Sender.ExternalID)), AvatarURL: null.NewString(req.Sender.AvatarURL, req.Sender.AvatarURL != "")}, Subject: fmt.Sprintf("Facebook: %s", req.Sender.DisplayName), SourceID: null.StringFrom(req.ExternalMessageID), Content: req.Message.Text, ContentType: models.ContentTypeText, Meta: metaJSON, ConversationMeta: map[string]any{"facebook": map[string]any{"channel_connection_key": req.ChannelConnectionKey, "account_id": req.AccountID, "external_thread_id": req.ExternalThreadID, "thread_type": req.ThreadType}}, ConversationUUIDFromReplyTo: req.ConversationUUID}
	message, err := app.conversation.ProcessIncomingMessage(incoming)
	if err != nil {
		return sendErrorEnvelope(r, err)
	}
	return r.SendEnvelope(facebookInboundResponse{MessageUUID: message.UUID, ConversationUUID: message.ConversationUUID})
}

func findAuthorizedFacebookInbox(app *App, connectionKey, accountID, token string) (imodels.Inbox, facebook.Config, error) {
	var empty imodels.Inbox
	var emptyCfg facebook.Config
	if token == "" {
		return empty, emptyCfg, fmt.Errorf("missing token")
	}
	inboxes, err := app.inbox.GetAll()
	if err != nil {
		return empty, emptyCfg, err
	}
	for _, record := range inboxes {
		if !record.Enabled || record.Channel != inbox.ChannelFacebookPersonal {
			continue
		}
		var cfg facebook.Config
		if json.Unmarshal(record.Config, &cfg) != nil {
			continue
		}
		if cfg.ChannelConnectionKey == connectionKey && subtle.ConstantTimeCompare([]byte(cfg.ConnectorToken), []byte(token)) == 1 {
			return record, cfg, nil
		}
	}
	return empty, emptyCfg, fmt.Errorf("no matching inbox")
}
func syntheticFacebookEmail(accountID, externalID string) string {
	hash := sha256.Sum256([]byte(accountID + ":" + externalID))
	return "facebook-" + hex.EncodeToString(hash[:12]) + "@facebook.local"
}
func parseFacebookOccurredAt(value string) string {
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed.UTC().Format(time.RFC3339Nano)
	}
	return time.Now().UTC().Format(time.RFC3339Nano)
}
