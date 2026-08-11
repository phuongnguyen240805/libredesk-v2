package sla

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/abhinavxd/libredesk/internal/business_hours/models"
	"github.com/jmoiron/sqlx/types"
	"github.com/stretchr/testify/assert"
)

func mustMarshalJSON(v interface{}) types.JSONText {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return types.JSONText(data)
}

func TestCalculateDeadline(t *testing.T) {
	locUTC := time.UTC
	locIST, _ := time.LoadLocation("Asia/Kolkata")

	tests := []struct {
		name           string
		startTime      time.Time
		slaMinutes     int
		businessHours  models.BusinessHours
		timeZone       string
		expectedResult time.Time
		expectError    error
	}{
		{
			name:       "Always Open Business",
			startTime:  time.Date(2023, 10, 10, 9, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				IsAlwaysOpen: true,
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 10, 10, 0, 0, 0, locUTC),
		},
		{
			name:        "Invalid SLA Duration (Zero)",
			slaMinutes:  0,
			expectError: ErrInvalidSLADuration,
		},
		{
			name:        "Invalid SLA Duration (Negative)",
			slaMinutes:  -5,
			expectError: ErrInvalidSLADuration,
		},
		{
			name:       "Start Time on Holiday",
			startTime:  time.Date(2023, 10, 10, 10, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Holidays: mustMarshalJSON([]models.Holiday{{Date: "2023-10-10"}}),
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 17, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Current Time Before Work Hours",
			startTime:  time.Date(2023, 10, 10, 8, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Holidays: mustMarshalJSON([]models.Holiday{}),
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 10, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Current Time After Work Hours",
			startTime:  time.Date(2023, 10, 10, 18, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 17, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Span Multiple Business Days",
			startTime:  time.Date(2023, 10, 10, 9, 0, 0, 0, locUTC),
			slaMinutes: 900, // 15 hours
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday":   {Open: "09:00", Close: "17:00"},
					"Wednesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 11, 16, 0, 0, 0, locUTC),
		},
		{
			name:       "Closed All Day",
			startTime:  time.Date(2023, 10, 10, 10, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Wednesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 11, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Time Zone Conversion",
			startTime:  time.Date(2023, 10, 10, 20, 0, 0, 0, locUTC), // 01:30 IST next day
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "Asia/Kolkata",
			expectedResult: time.Date(2023, 10, 17, 10, 0, 0, 0, locIST),
		},
		{
			name:       "Weekend Handling",
			startTime:  time.Date(2023, 10, 14, 10, 0, 0, 0, locUTC), // Saturday
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Monday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 16, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Max Iterations Exceeded",
			startTime:  time.Date(2023, 10, 10, 9, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{}),
			},
			timeZone:    "UTC",
			expectError: ErrMaxIterations,
		},
		{
			name:       "Invalid Open Time Format",
			startTime:  time.Date(2023, 10, 10, 9, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "25:00", Close: "17:00"},
				}),
			},
			timeZone:    "UTC",
			expectError: ErrInvalidTime,
		},
		{
			name:       "Exact End of Work Hours",
			startTime:  time.Date(2023, 10, 10, 17, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Wednesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 11, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Always Open Business",
			startTime:  time.Date(2023, 10, 10, 9, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				IsAlwaysOpen: true,
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 10, 10, 0, 0, 0, locUTC),
		},
		{
			name:        "Invalid SLA Duration (Zero)",
			slaMinutes:  0,
			expectError: ErrInvalidSLADuration,
		},
		{
			name:        "Invalid SLA Duration (Negative)",
			slaMinutes:  -5,
			expectError: ErrInvalidSLADuration,
		},
		{
			name:       "Start Time on Holiday",
			startTime:  time.Date(2023, 10, 10, 10, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Holidays: mustMarshalJSON([]models.Holiday{{Date: "2023-10-10"}}),
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone: "UTC",
			// Next available Tuesday after skipping holiday
			expectedResult: time.Date(2023, 10, 17, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Current Time Before Work Hours",
			startTime:  time.Date(2023, 10, 10, 8, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Holidays: mustMarshalJSON([]models.Holiday{}),
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 10, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Current Time After Work Hours",
			startTime:  time.Date(2023, 10, 10, 18, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone: "UTC",
			// Skips to next Tuesday (assuming only Tuesday is defined)
			expectedResult: time.Date(2023, 10, 17, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Span Multiple Business Days",
			startTime:  time.Date(2023, 10, 10, 9, 0, 0, 0, locUTC),
			slaMinutes: 900, // 15 hours
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday":   {Open: "09:00", Close: "17:00"},
					"Wednesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 11, 16, 0, 0, 0, locUTC),
		},
		{
			name:       "Open All Day",
			startTime:  time.Date(2023, 10, 10, 23, 30, 0, 0, locUTC),
			slaMinutes: 29,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "00:01", Close: "23:59"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 10, 23, 59, 0, 0, locUTC),
		},
		{
			name:       "Open All Day #2",
			startTime:  time.Date(2023, 10, 10, 23, 30, 0, 0, locUTC),
			slaMinutes: 30,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "00:01", Close: "23:59"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 17, 00, 02, 0, 0, locUTC),
		},
		{
			name:       "Closed All Day",
			startTime:  time.Date(2023, 10, 10, 10, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Wednesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 11, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Time Zone Conversion",
			startTime:  time.Date(2023, 10, 10, 20, 0, 0, 0, locUTC), // becomes next day in IST
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "Asia/Kolkata",
			expectedResult: time.Date(2023, 10, 17, 10, 0, 0, 0, locIST),
		},
		{
			name:       "Weekend Handling",
			startTime:  time.Date(2023, 10, 14, 10, 0, 0, 0, locUTC), // Saturday
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Monday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 16, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Max Iterations Exceeded",
			startTime:  time.Date(2023, 10, 10, 9, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{}),
			},
			timeZone:    "UTC",
			expectError: ErrMaxIterations,
		},
		{
			name:       "Invalid Open Time Format",
			startTime:  time.Date(2023, 10, 10, 9, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "25:00", Close: "17:00"},
				}),
			},
			timeZone:    "UTC",
			expectError: ErrInvalidTime,
		},
		{
			name:       "Invalid Close Time Format",
			startTime:  time.Date(2023, 10, 10, 9, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday": {Open: "09:00", Close: "18:60"},
				}),
			},
			timeZone:    "UTC",
			expectError: ErrInvalidTime,
		},
		{
			name:       "Exact End of Work Hours",
			startTime:  time.Date(2023, 10, 10, 17, 0, 0, 0, locUTC),
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Wednesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone:       "UTC",
			expectedResult: time.Date(2023, 10, 11, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Start Equals End-of-Work",
			startTime:  time.Date(2023, 10, 10, 17, 0, 0, 0, locUTC),
			slaMinutes: 30,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday":   {Open: "09:00", Close: "17:00"},
					"Wednesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone: "UTC",
			// Tuesday has no remaining time; on Wednesday, work starts at 09:00 so adding 30 mins results in 09:30.
			expectedResult: time.Date(2023, 10, 11, 9, 30, 0, 0, locUTC),
		},
		{
			name:       "Start at End-of-Day",
			startTime:  time.Date(2023, 10, 10, 23, 59, 0, 0, locUTC),
			slaMinutes: 1,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday":   {Open: "00:01", Close: "23:59"},
					"Wednesday": {Open: "00:01", Close: "23:59"},
				}),
			},
			timeZone: "UTC",
			// Tuesday's work is done; on Wednesday, starting at 00:01, adding 1 minute gives 00:02.
			expectedResult: time.Date(2023, 10, 11, 0, 2, 0, 0, locUTC),
		},
		{
			name:       "Multiple Consecutive Holidays",
			startTime:  time.Date(2023, 10, 10, 10, 0, 0, 0, locUTC), // Tuesday
			slaMinutes: 60,
			businessHours: models.BusinessHours{
				Holidays: mustMarshalJSON([]models.Holiday{
					{Date: "2023-10-10"},
					{Date: "2023-10-11"},
				}),
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday":   {Open: "09:00", Close: "17:00"},
					"Wednesday": {Open: "09:00", Close: "17:00"},
					"Thursday":  {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone: "UTC",
			// Skips Tuesday and Wednesday holidays, so deadline is on Thursday at 10:00.
			expectedResult: time.Date(2023, 10, 12, 10, 0, 0, 0, locUTC),
		},
		{
			name:       "Short Working Day",
			startTime:  time.Date(2023, 10, 10, 9, 0, 0, 0, locUTC),
			slaMinutes: 90, // 1.5 hours total
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday":   {Open: "09:00", Close: "09:30"},
					"Wednesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone: "UTC",
			expectedResult: time.Date(2023, 10, 11, 10, 0, 0, 0, locUTC),
		},
		{
			name:      "Short Working Day #2",
			startTime: time.Date(2025, 03, 22, 18, 01, 0, 0, locIST),
			// 24 hours.
			slaMinutes: 1440,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Tuesday":   {Open: "09:00", Close: "09:30"},
					"Wednesday": {Open: "09:00", Close: "17:00"},
				}),
			},
			timeZone: "UTC",
			expectedResult: time.Date(2025, 04, 9, 15, 30, 0, 0, locUTC),
		},
		{
			name:      "Monday to Friday 10:00 to 18:00",
			startTime: time.Date(2025, 03, 22, 18, 1, 43, 0, locIST), // Sat
			slaMinutes: 1439,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Monday":    {Open: "10:00", Close: "18:00"},
					"Tuesday":   {Open: "10:00", Close: "18:00"},
					"Wednesday": {Open: "10:00", Close: "18:00"},
					"Thursday":  {Open: "10:00", Close: "18:00"},
					"Friday":    {Open: "10:00", Close: "18:00"},
					"Saturday":  {Open: "10:00", Close: "14:00"},
				}),
			},
			timeZone:       "Asia/Kolkata",
			expectedResult: time.Date(2025, 03, 26, 17, 59, 0, 0, locIST),
		},
		{
			name:      "Monday to Friday 10:00 to 18:00",
			startTime: time.Date(2025, 03, 22, 18, 1, 43, 0, locIST), // Sat
			// 24 hours.
			slaMinutes: 1440,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Monday":    {Open: "10:00", Close: "18:00"},
					"Tuesday":   {Open: "10:00", Close: "18:00"},
					"Wednesday": {Open: "10:00", Close: "18:00"},
					"Thursday":  {Open: "10:00", Close: "18:00"},
					"Friday":    {Open: "10:00", Close: "18:00"},
					"Saturday":  {Open: "10:00", Close: "14:00"},
				}),
			},
			timeZone:       "Asia/Kolkata",
			expectedResult: time.Date(2025, 03, 26, 18, 0, 0, 0, locIST),
		},
		{
			name:       "Monday to Friday 10:00 to 18:00 #2",
			startTime:  time.Date(2025, 03, 22, 18, 1, 43, 0, locIST), // Sat
			slaMinutes: 1430,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Monday":    {Open: "10:00", Close: "18:00"},
					"Tuesday":   {Open: "10:00", Close: "18:00"},
					"Wednesday": {Open: "10:00", Close: "18:00"},
					"Thursday":  {Open: "10:00", Close: "18:00"},
					"Friday":    {Open: "10:00", Close: "18:00"},
					"Saturday":  {Open: "10:00", Close: "14:00"},
				}),
			},
			timeZone:       "Asia/Kolkata",
			expectedResult: time.Date(2025, 03, 26, 17, 50, 0, 0, locIST),
		},
		{
			name:       "Monday to Friday 10:00 to 18:00 #3",
			startTime:  time.Date(2025, 03, 22, 18, 1, 43, 0, locIST), // Sat
			slaMinutes: 1450,
			businessHours: models.BusinessHours{
				Hours: mustMarshalJSON(map[string]models.WorkingHours{
					"Monday":    {Open: "10:00", Close: "18:00"},
					"Tuesday":   {Open: "10:00", Close: "18:00"},
					"Wednesday": {Open: "10:00", Close: "18:00"},
					"Thursday":  {Open: "10:00", Close: "18:00"},
					"Friday":    {Open: "10:00", Close: "18:00"},
					"Saturday":  {Open: "10:00", Close: "14:00"},
				}),
			},
			timeZone:       "Asia/Kolkata",
			expectedResult: time.Date(2025, 03, 27, 10, 10, 0, 0, locIST),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := &Manager{}
			result, err := m.CalculateDeadline(tt.startTime, tt.slaMinutes, tt.businessHours, tt.timeZone)

			if tt.expectError != nil {
				assert.ErrorContains(t, err, tt.expectError.Error())
				return
			}

			assert.NoError(t, err)
			assert.Equal(t, tt.expectedResult, result)
		})
	}
}
