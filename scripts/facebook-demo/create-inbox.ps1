param(
    [Parameter(Mandatory = $true)] [string] $ApiKey,
    [Parameter(Mandatory = $true)] [string] $ApiSecret,
    [Parameter(Mandatory = $true)] [string] $ConnectorToken,
    [string] $LibreDeskUrl = "http://127.0.0.1:9001/api/v1",
    [string] $AccountId = "demo-facebook",
    [string] $ConnectorUrl = "http://facebook-connector:3200"
)

$pair = "${ApiKey}:${ApiSecret}"
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
$headers = @{ Authorization = "Basic $basic"; "Content-Type" = "application/json" }
$payload = @{
    name = "Facebook Messenger"
    channel = "facebook_personal"
    enabled = $true
    csat_enabled = $false
    prompt_tags_on_reply = $false
    from = ""
    from_name_template = ""
    config = @{
        connector_url = $ConnectorUrl
        connector_token = $ConnectorToken
        account_id = $AccountId
        request_timeout = "30s"
    }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri "$LibreDeskUrl/inboxes" -Headers $headers -Body $payload | ConvertTo-Json -Depth 10
