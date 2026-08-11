package ai

import (
	"context"
	"fmt"
	"strings"
)

type SuggestionRequest struct {
	WorkspaceID    string   `json:"workspace_id"`
	ConversationID string   `json:"conversation_id"`
	LastMessages   []string `json:"last_messages"`
	CustomerIntent string   `json:"customer_intent,omitempty"`
}

type ReplySuggestion struct {
	ID         string   `json:"id"`
	Text       string   `json:"text"`
	Confidence float64  `json:"confidence"`
	MacroID    *string  `json:"macro_id,omitempty"`
	TagsToApply []string `json:"tags_to_apply,omitempty"`
}

type SuggestionResponse struct {
	Intent      string            `json:"intent"`
	Suggestions []ReplySuggestion `json:"suggestions"`
}

// GenerateSuggestions generates 3 smart reply suggestions for agents.
func (m *Manager) GenerateSuggestions(ctx context.Context, req SuggestionRequest) (*SuggestionResponse, error) {
	combined := strings.Join(req.LastMessages, "\n")
	intent := "general_inquiry"

	lower := strings.ToLower(combined)
	if strings.Contains(lower, "giá") || strings.Contains(lower, "bao nhiêu") || strings.Contains(lower, "chi phí") {
		intent = "pricing_inquiry"
	} else if strings.Contains(lower, "lỗi") || strings.Contains(lower, "hỏng") || strings.Contains(lower, "khiếu nại") {
		intent = "complaint"
	} else if strings.Contains(lower, "đơn hàng") || strings.Contains(lower, "vận chuyển") {
		intent = "order_status"
	}

	suggestions := []ReplySuggestion{
		{
			ID:          "sug_1",
			Text:        fmt.Sprintf("Chào bạn, cám ơn bạn đã liên hệ! Về vấn đề %s, bên mình xin phản hồi như sau...", intent),
			Confidence: 0.92,
		},
		{
			ID:          "sug_2",
			Text:        "Dạ shop đã ghi nhận thông tin của bạn và đang kiểm tra ngay đây ạ. Bạn đợi chút nhé!",
			Confidence: 0.85,
		},
		{
			ID:          "sug_3",
			Text:        "Dạ cho shop xin thêm mã đơn hàng hoặc thông tin liên hệ để shop hỗ trợ nhanh nhất nhé!",
			Confidence: 0.78,
		},
	}

	return &SuggestionResponse{
		Intent:      intent,
		Suggestions: suggestions,
	}, nil
}
