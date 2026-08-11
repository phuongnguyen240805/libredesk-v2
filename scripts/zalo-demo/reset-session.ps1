param(
    [Parameter(Mandatory = $true)] [string] $ConnectorToken,
    [string] $ConnectorUrl = "http://127.0.0.1:3100"
)
Invoke-RestMethod -Method Post -Uri "$ConnectorUrl/session/reset" -Headers @{ "X-Zalo-Connector-Token" = $ConnectorToken } | ConvertTo-Json -Depth 5
