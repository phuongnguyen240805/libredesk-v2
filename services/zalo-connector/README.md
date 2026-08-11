# Nest Customer Care gateway Zalo Personal Connector (demo v1)

Connector Node.js chạy `zca-js` cho một tài khoản Zalo cá nhân:

- đăng nhập QR;
- lưu cookie/IMEI/user-agent vào volume local;
- nghe tin nhắn text mới realtime;
- đẩy tin nhắn vào LibreDesk;
- nhận lệnh gửi trả lời từ LibreDesk;
- lưu mapping thread Zalo ↔ conversation UUID.

## Chạy local

```bash
cp .env.example .env
npm install
npm run dev
```

Mở:

- `http://localhost:3100/status`
- `http://localhost:3100/qr`

Sau khi quét QR, trạng thái chuyển thành `connected`.

## Lưu ý

Đây là connector tài khoản cá nhân không chính thức. Chỉ dùng tài khoản phụ cho demo. Không mở Zalo Web trong trình duyệt đồng thời vì listener web có thể bị ngắt.


## Nest Customer Care gateway

Inbound events are HMAC-signed and sent to `CUSTOMER_CARE_WEBHOOK_URL`. The connector no longer stores LibreDesk conversation mappings and does not need LibreDesk API credentials. Configure the same `CUSTOMER_CARE_WEBHOOK_SECRET` in the connector and Nest backend.
