param(
    [Parameter(Mandatory = $true)] [string] $ApiKey,
    [Parameter(Mandatory = $true)] [string] $ApiSecret,
    [Parameter(Mandatory = $true)] [string] $ConnectorToken,
    [string] $LibreDeskUrl = "http://127.0.0.1:9001/api/v1",
    [string] $AccountId = "demo-zalo",
    [string] $ConnectorUrl = "http://zalo-connector:3100"
)

$pair = "${ApiKey}:${ApiSecret}"
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
$headers = @{
    Authorization = "Basic $basic"
    "Content-Type" = "application/json"
}

$payload = @{
    name = "Zalo cá nhân Demo"
    channel = "zalo_personal"
    enabled = $true
    csat_enabled = $false
    prompt_tags_on_reply = $false
    from = ""
    from_name_template = ""
    config = @{
        connector_url = $ConnectorUrl
        connector_token = $ConnectorToken
        account_id = $AccountId
        request_timeout = "15s"
    }
} | ConvertTo-Json -Depth 8

Write-Host "Creating Zalo inbox at $LibreDeskUrl/inboxes ..."
$result = Invoke-RestMethod -Method Post -Uri "$LibreDeskUrl/inboxes" -Headers $headers -Body $payload
$result | ConvertTo-Json -Depth 10
