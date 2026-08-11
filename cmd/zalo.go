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
	"github.com/abhinavxd/libredesk/internal/inbox/channel/zalo"
	imodels "github.com/abhinavxd/libredesk/internal/inbox/models"
	"github.com/valyala/fasthttp"
	"github.com/volatiletech/null/v9"
	"github.com/zerodha/fastglue"
)

type zaloInboundRequest struct {
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

type zaloInboundResponse struct {
	MessageUUID      string `json:"message_uuid"`
	ConversationUUID string `json:"conversation_uuid"`
	Duplicate        bool   `json:"duplicate"`
}

// handleZaloInbound accepts authenticated webhook events from the standalone
// zca-js connector. It intentionally does not use normal agent authentication;
// every request is instead scoped to one enabled Zalo inbox and its encrypted
// connector token.
func handleZaloInbound(r *fastglue.Request) error {
	app := r.Context.(*App)
	var req zaloInboundRequest
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
		return r.SendErrorEnvelope(fasthttp.StatusBadRequest, "Missing required Zalo event fields", nil, envelope.InputError)
	}
	if req.Message.Type != "" && req.Message.Type != "text" {
		return r.SendErrorEnvelope(fasthttp.StatusUnprocessableEntity, "Zalo demo v1 only supports text messages", nil, envelope.DataError)
	}

	token := string(r.RequestCtx.Request.Header.Peek("X-Zalo-Connector-Token"))
	inboxRecord, _, err := findAuthorizedZaloInbox(app, req.ChannelConnectionKey, req.AccountID, token)
	if err != nil {
		return r.SendErrorEnvelope(fasthttp.StatusUnauthorized, "Invalid Zalo connector credentials", nil, envelope.UnauthorizedError)
	}

	// Fast idempotency path. This also handles the case where LibreDesk saved a
	// message but the connector did not receive the original HTTP response.
	if exists, existsErr := app.conversation.MessageExists(req.ExternalMessageID); existsErr != nil {
		return sendErrorEnvelope(r, existsErr)
	} else if exists {
		conversationUUID, lookupErr := app.conversation.GetConversationUUIDBySourceID(req.ExternalMessageID)
		if lookupErr != nil {
			return sendErrorEnvelope(r, lookupErr)
		}
		return r.SendEnvelope(zaloInboundResponse{ConversationUUID: conversationUUID, Duplicate: true})
	}

	contactEmail := syntheticZaloEmail(req.ChannelConnectionKey, req.Sender.ExternalID)
	messageMeta := map[string]any{
		"zalo": map[string]any{
			"channel_connection_key": req.ChannelConnectionKey,
			"account_id":          req.AccountID,
			"external_thread_id":  req.ExternalThreadID,
			"external_message_id": req.ExternalMessageID,
			"thread_type":         req.ThreadType,
			"sender_external_id":  req.Sender.ExternalID,
			"sender_avatar_url":   req.Sender.AvatarURL,
			"occurred_at":         parseZaloOccurredAt(req.OccurredAt),
		},
	}
	messageMetaJSON, err := json.Marshal(messageMeta)
	if err != nil {
		return r.SendErrorEnvelope(fasthttp.StatusInternalServerError, app.i18n.T("globals.messages.somethingWentWrong"), nil, envelope.GeneralError)
	}

	incoming := models.IncomingMessage{
		Channel: inbox.ChannelZaloPersonal,
		InboxID: inboxRecord.ID,
		Contact: models.IncomingContact{
			FirstName: req.Sender.DisplayName,
			Email:     null.StringFrom(contactEmail),
			AvatarURL: null.NewString(req.Sender.AvatarURL, req.Sender.AvatarURL != ""),
		},
		Subject:     fmt.Sprintf("Zalo: %s", req.Sender.DisplayName),
		SourceID:    null.StringFrom(req.ExternalMessageID),
		Content:     req.Message.Text,
		ContentType: models.ContentTypeText,
		Meta:        messageMetaJSON,
		ConversationMeta: map[string]any{
			"zalo": map[string]any{
				"channel_connection_key": req.ChannelConnectionKey,
				"account_id":         req.AccountID,
				"external_thread_id": req.ExternalThreadID,
				"thread_type":        req.ThreadType,
			},
		},
		ConversationUUIDFromReplyTo: req.ConversationUUID,
	}

	message, err := app.conversation.ProcessIncomingMessage(incoming)
	if err != nil {
		app.lo.Error("error processing Zalo inbound message", "account_id", req.AccountID, "thread_id", req.ExternalThreadID, "external_message_id", req.ExternalMessageID, "error", err)
		return sendErrorEnvelope(r, err)
	}

	return r.SendEnvelope(zaloInboundResponse{
		MessageUUID:      message.UUID,
		ConversationUUID: message.ConversationUUID,
	})
}

func findAuthorizedZaloInbox(app *App, connectionKey, accountID, suppliedToken string) (imodels.Inbox, zalo.Config, error) {
	var emptyInbox imodels.Inbox
	var emptyConfig zalo.Config
	if suppliedToken == "" {
		return emptyInbox, emptyConfig, fmt.Errorf("missing token")
	}

	inboxes, err := app.inbox.GetAll()
	if err != nil {
		return emptyInbox, emptyConfig, err
	}
	for _, record := range inboxes {
		if !record.Enabled || record.Channel != inbox.ChannelZaloPersonal {
			continue
		}
		var cfg zalo.Config
		if err := json.Unmarshal(record.Config, &cfg); err != nil {
			continue
		}
		if cfg.ChannelConnectionKey != connectionKey || cfg.ConnectorToken == "" {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(cfg.ConnectorToken), []byte(suppliedToken)) == 1 {
			return record, cfg, nil
		}
	}
	return emptyInbox, emptyConfig, fmt.Errorf("no matching inbox")
}

func syntheticZaloEmail(accountID, externalID string) string {
	hash := sha256.Sum256([]byte(accountID + ":" + externalID))
	return "zalo-" + hex.EncodeToString(hash[:12]) + "@zalo.local"
}

func parseZaloOccurredAt(value string) string {
	if value == "" {
		return time.Now().UTC().Format(time.RFC3339Nano)
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed.UTC().Format(time.RFC3339Nano)
	}
	return time.Now().UTC().Format(time.RFC3339Nano)
}
