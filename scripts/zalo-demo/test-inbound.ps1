param(
    [Parameter(Mandatory = $true)] [string] $ConnectorToken,
    [string] $LibreDeskUrl = "http://127.0.0.1:9001/api/v1",
    [string] $AccountId = "demo-zalo"
)

$payload = @{
    account_id = $AccountId
    external_thread_id = "demo-thread-001"
    external_message_id = "demo-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    thread_type = "user"
    occurred_at = [DateTime]::UtcNow.ToString("o")
    sender = @{
        external_id = "demo-customer-001"
        display_name = "Khách Zalo Demo"
    }
    message = @{
        type = "text"
        text = "Tin nhắn kiểm thử từ Zalo connector"
    }
} | ConvertTo-Json -Depth 8

$params = @{
    Method = "Post"
    Uri = "$LibreDeskUrl/channels/zalo/inbound"
    Headers = @{
        "X-Zalo-Connector-Token" = $ConnectorToken
        "Content-Type" = "application/json"
    }
    Body = $payload
}

Invoke-RestMethod @params | ConvertTo-Json -Depth 10
