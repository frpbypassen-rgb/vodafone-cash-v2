# Flutter Mobile API Contract

This is the current backend contract for the Flutter app.

Current staging host:

```text
https://2c70a687affed6.lhr.life
```

Final Flutter base URL:

```text
https://2c70a687affed6.lhr.life/api/mobile
```

Important:

- Flutter must call `POST /api/mobile/login`, not the web `POST /login`.
- `/api/v1/mobile` is also mounted as an alias, but the recommended and canonical mobile prefix is `/api/mobile`.
- Mobile endpoints are CSRF-exempt. Flutter sends JSON plus `Authorization: Bearer <token>` when required.
- Common request headers:

```http
Content-Type: application/json
Accept: application/json
X-Correlation-Id: optional-client-request-id
Authorization: Bearer <accessToken>
```

Common error envelope:

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Safe user-facing message",
  "correlationId": "optional-client-request-id"
}
```

## Auth

### POST /login

Full URL:

```text
POST https://2c70a687affed6.lhr.life/api/mobile/login
```

Request:

```json
{
  "username": "m_star@ahram.com",
  "password": "123456"
}
```

Success 200:

```json
{
  "success": true,
  "token": "access.jwt",
  "refreshToken": "refresh.jwt",
  "expiresIn": 3600,
  "refreshExpiresIn": 2592000,
  "id": "665f1f...",
  "accountType": "client_user",
  "name": "Mohamed Star",
  "balance": 1200,
  "exchangeRate": 6.45,
  "isOpen": true,
  "serverTime": "2026-06-11T14:00:00.000Z",
  "context": {
    "clientCompanyId": null,
    "clientCompanyName": null,
    "executorGroupId": null,
    "executorGroupName": null,
    "executorBotId": null,
    "executorBotName": null
  }
}
```

Executor success uses `accountType: "executor"` and puts group identity in `context.executorGroupId`. The legacy `executorBotId` field mirrors `executorGroupId` for compatibility.

Error examples:

```json
{
  "success": false,
  "code": "INVALID_CREDENTIALS",
  "message": "Invalid username or password",
  "correlationId": "corr-1"
}
```

```json
{
  "success": false,
  "code": "ACCOUNT_LOCKED",
  "message": "Account temporarily locked",
  "correlationId": "corr-1"
}
```

Curl:

```bash
curl -X POST "https://2c70a687affed6.lhr.life/api/mobile/login" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{\"username\":\"m_star@ahram.com\",\"password\":\"123456\"}"
```

### POST /refresh-token

Full URL:

```text
POST https://2c70a687affed6.lhr.life/api/mobile/refresh-token
```

Request:

```json
{
  "refreshToken": "refresh.jwt"
}
```

Success 200:

```json
{
  "success": true,
  "token": "new-access.jwt",
  "expiresIn": 3600,
  "serverTime": "2026-06-11T14:00:00.000Z"
}
```

Current behavior: refresh token is not rotated on refresh, so the response normally does not include a new `refreshToken`.

Errors:

```json
{
  "success": false,
  "code": "TOKEN_INVALID",
  "message": "Invalid or expired token",
  "correlationId": "corr-1"
}
```

```json
{
  "success": false,
  "code": "SESSION_REVOKED",
  "message": "Session was revoked",
  "correlationId": "corr-1"
}
```

Curl:

```bash
curl -X POST "https://2c70a687affed6.lhr.life/api/mobile/refresh-token" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{\"refreshToken\":\"REFRESH_TOKEN_HERE\"}"
```

### POST /logout

Full URL:

```text
POST https://2c70a687affed6.lhr.life/api/mobile/logout
```

Request body: empty.

Success 200:

```json
{
  "success": true,
  "message": "Logged out and session revoked",
  "serverTime": "2026-06-11T14:00:00.000Z"
}
```

Errors:

- `401 TOKEN_INVALID` when the access token is missing or invalid.
- `500 SERVER_ERROR` for unexpected backend errors.

Curl:

```bash
curl -X POST "https://2c70a687affed6.lhr.life/api/mobile/logout" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE"
```

## Client Home

### GET /client/home

Full URL:

```text
GET https://2c70a687affed6.lhr.life/api/mobile/client/home
```

Allowed account types: `client_user`, `client_company`.

Success 200:

```json
{
  "success": true,
  "balance": 1200,
  "exchangeRate": 6.45,
  "isOpen": true,
  "serverTime": "2026-06-11T14:00:00.000Z"
}
```

Notes:

- `balance` is the wallet balance in LYD for the current account.
- `exchangeRate` is selected server-side from the account tier.
- `isOpen` is false when the system is manually closed.

Errors:

```json
{
  "success": false,
  "code": "FORBIDDEN",
  "message": "Insufficient permissions",
  "correlationId": "corr-1"
}
```

Curl:

```bash
curl -X GET "https://2c70a687affed6.lhr.life/api/mobile/client/home" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE"
```

## Transfers

### POST /client/new-transfer

Full URL:

```text
POST https://2c70a687affed6.lhr.life/api/mobile/client/new-transfer
```

Required headers:

```http
Authorization: Bearer <accessToken>
Idempotency-Key: <uuid-v4>
Content-Type: application/json
```

Supported `transferType` enum:

- `vodafone`
- `post_account`
- `post_card`

Request for Vodafone/Cash:

```json
{
  "transferType": "vodafone",
  "amount": 1000,
  "number": "01012345678",
  "notes": "optional"
}
```

Request for postal account:

```json
{
  "transferType": "post_account",
  "amount": 1000,
  "number": "1234567890",
  "name": "First Second Third Fourth",
  "oldReceiptImage": "data:image/jpeg;base64,/9j/...",
  "notes": "optional"
}
```

Request for postal card:

```json
{
  "transferType": "post_card",
  "amount": 1000,
  "number": "29901011234567",
  "name": "First Second Third Fourth",
  "idCardImage": "data:image/jpeg;base64,/9j/...",
  "notes": "optional"
}
```

Success 200:

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "Transfer request submitted successfully",
  "txId": "ATT-2606-0001",
  "status": "pending",
  "costLYD": 155.039,
  "exchangeRate": 6.45,
  "newBalance": 1044.961,
  "serverTime": "2026-06-11T14:00:00.000Z"
}
```

Currency rules:

- `amount` is the Egyptian amount, EGP.
- `costLYD` is always calculated by the server: `amount / finalRate`.
- `newBalance` is the remaining wallet balance in LYD.
- Flutter should not calculate `costLYD` for final submission. It may display a local estimate, but must trust the server response.
- Do not send Arabic transfer type values.

Image upload rules for transfer request images:

- Images are sent as Base64 strings in JSON.
- `idCardImage` is required for `post_card`.
- `oldReceiptImage` is optional for `post_account`.
- The validator currently allows up to 5 MB per request image.

Idempotency:

- `Idempotency-Key` is required and must be a valid UUID.
- Same key + same payload returns a replay response with `code: "DUPLICATE_REPLAYED"`.
- Same key + different payload returns `409 IDEMPOTENCY_CONFLICT`.

Errors:

```json
{
  "success": false,
  "code": "IDEMPOTENCY_KEY_REQUIRED",
  "message": "Idempotency-Key is required",
  "correlationId": "corr-1"
}
```

```json
{
  "success": false,
  "code": "INSUFFICIENT_BALANCE",
  "message": "Insufficient wallet balance",
  "correlationId": "corr-1"
}
```

Curl:

```bash
curl -X POST "https://2c70a687affed6.lhr.life/api/mobile/client/new-transfer" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE" \
  -H "Idempotency-Key: 11111111-1111-4111-8111-111111111111" \
  -d "{\"transferType\":\"vodafone\",\"amount\":1000,\"number\":\"01012345678\",\"notes\":\"test\"}"
```

## Client Transactions

### GET /client/transactions

Query params:

- `page` optional, default `1`.
- `limit` optional, default `20`, max `100`.

Success 200:

```json
{
  "success": true,
  "transactions": [
    {
      "id": "665f1f...",
      "customId": "ATT-2606-0001",
      "transferType": "vodafone",
      "recipientNumber": "01012345678",
      "recipientName": null,
      "amount": 1000,
      "costLYD": 155.039,
      "exchangeRate": 6.45,
      "status": "pending",
      "createdAt": "2026-06-11T14:00:00.000Z",
      "notes": "optional",
      "hasProofImage": false
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "pages": 1
  }
}
```

Curl:

```bash
curl -X GET "https://2c70a687affed6.lhr.life/api/mobile/client/transactions?page=1&limit=20" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE"
```

### GET /client/transactions/:id

Success 200:

```json
{
  "success": true,
  "transaction": {
    "id": "665f1f...",
    "customId": "ATT-2606-0001",
    "transferType": "vodafone",
    "recipientNumber": "01012345678",
    "recipientName": null,
    "amount": 1000,
    "costLYD": 155.039,
    "exchangeRate": 6.45,
    "status": "completed",
    "createdAt": "2026-06-11T14:00:00.000Z",
    "notes": "optional",
    "hasProofImage": true
  }
}
```

Errors:

- `404 NOT_FOUND` if the transaction does not exist.
- `403 FORBIDDEN` if it belongs to another account.

Curl:

```bash
curl -X GET "https://2c70a687affed6.lhr.life/api/mobile/client/transactions/TRANSACTION_OBJECT_ID" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE"
```

## Receipts and Images

### GET /transaction/image/:id

Full URL:

```text
GET https://2c70a687affed6.lhr.life/api/mobile/transaction/image/:id
```

Requires `Authorization: Bearer <accessToken>`.

Success 200:

```json
{
  "success": true,
  "url": "https://2c70a687affed6.lhr.life/api/mobile/transaction/image/content?ticket=...",
  "expiresIn": 120,
  "serverTime": "2026-06-11T14:00:00.000Z"
}
```

Rules:

- This endpoint returns a secure backend proxy URL, not a raw Telegram URL.
- The returned URL also requires the same `Authorization` header.
- The ticket expires after 120 seconds.
- The ticket is single-use. After the first successful content request, it is deleted.

### GET /transaction/image/content?ticket=...

Requires `Authorization: Bearer <accessToken>`.

Success 200:

- Body is the image stream.
- `Content-Type` is an image type, usually `image/jpeg`.

Curl:

```bash
curl -X GET "https://2c70a687affed6.lhr.life/api/mobile/transaction/image/TRANSACTION_OBJECT_ID" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE"
```

```bash
curl -L -X GET "RECEIPT_URL_FROM_PREVIOUS_RESPONSE" \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE" \
  --output receipt.jpg
```

## Executor

All executor endpoints require an executor token.

### GET /executor/live-tasks

Success 200:

```json
{
  "success": true,
  "data": [
    {
      "id": "665f1f...",
      "txId": "ATT-2606-0001",
      "transferType": "vodafone",
      "amount": 1000,
      "recipientNumber": "01012345678",
      "recipientName": null,
      "status": "processing",
      "createdAt": "2026-06-11T14:00:00.000Z",
      "emergencyAlert": null
    }
  ],
  "alerts": [],
  "pollIntervalSeconds": 5,
  "serverTime": "2026-06-11T14:00:00.000Z"
}
```

Curl:

```bash
curl -X GET "https://2c70a687affed6.lhr.life/api/mobile/executor/live-tasks" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer EXECUTOR_ACCESS_TOKEN_HERE"
```

### POST /executor/accept-task/:id

Request body: empty.

Success 200:

```json
{
  "success": true
}
```

Errors:

- `403 FORBIDDEN` if not executor.
- `404 EMPLOYEE_NOT_FOUND` if executor account was not found.
- `409 ALREADY_TAKEN` if the task is no longer available.

Curl:

```bash
curl -X POST "https://2c70a687affed6.lhr.life/api/mobile/executor/accept-task/TRANSACTION_OBJECT_ID" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer EXECUTOR_ACCESS_TOKEN_HERE"
```

### POST /executor/cancel-task/:id

Request:

```json
{
  "reason": "Receiver number is invalid"
}
```

Success 200:

```json
{
  "success": true,
  "message": "Task cancelled and balance refunded successfully"
}
```

Errors:

- `400 VALIDATION_ERROR` if `reason` is missing or too short.
- `403 FORBIDDEN` if not executor.
- `404 EMPLOYEE_NOT_FOUND` if executor account was not found.
- `409 INVALID_STATE` if the task is not accepted by this executor.

Curl:

```bash
curl -X POST "https://2c70a687affed6.lhr.life/api/mobile/executor/cancel-task/TRANSACTION_OBJECT_ID" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer EXECUTOR_ACCESS_TOKEN_HERE" \
  -d "{\"reason\":\"Receiver number is invalid\"}"
```

### POST /executor/complete-task/:id

Request:

```json
{
  "imageBase64": "data:image/jpeg;base64,/9j/...",
  "senderPhone": "01099999999"
}
```

Success 200:

```json
{
  "success": true,
  "message": "Proof submitted successfully"
}
```

Notes:

- This endpoint expects JSON Base64, not multipart form-data.
- `senderPhone` is optional.

Errors:

- `400 MALFORMED_IMAGE` or `VALIDATION_ERROR` when proof image is missing or invalid.
- `403 FORBIDDEN` if not executor.
- `404 EMPLOYEE_NOT_FOUND` if executor account was not found.
- `409 INVALID_STATE` if the task is not accepted by this executor.

Curl:

```bash
curl -X POST "https://2c70a687affed6.lhr.life/api/mobile/executor/complete-task/TRANSACTION_OBJECT_ID" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer EXECUTOR_ACCESS_TOKEN_HERE" \
  -d "{\"imageBase64\":\"data:image/jpeg;base64,/9j/...\",\"senderPhone\":\"01099999999\"}"
```

## Support Tickets

The route prefix is `/client/tickets` for compatibility, but the endpoint currently works for:

- `client_user`
- `client_company`
- `executor`

There is no separate `/executor/tickets` endpoint at this time.

### POST /client/tickets

Request:

```json
{
  "text": "I need help with a transfer"
}
```

Success 201:

```json
{
  "success": true,
  "ticket": {
    "id": "665f1f...",
    "ticketId": "TCK-123456",
    "name": "Mohamed Star",
    "phone": "01012345678",
    "status": "open",
    "createdAt": "2026-06-11T14:00:00.000Z",
    "updatedAt": "2026-06-11T14:00:00.000Z"
  }
}
```

### GET /client/tickets

Query params: `page`, `limit`.

Success 200:

```json
{
  "success": true,
  "tickets": [
    {
      "id": "665f1f...",
      "ticketId": "TCK-123456",
      "name": "Mohamed Star",
      "phone": "01012345678",
      "status": "open",
      "unreadCount": 0,
      "createdAt": "2026-06-11T14:00:00.000Z",
      "updatedAt": "2026-06-11T14:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "pages": 1
  }
}
```

### GET /client/tickets/:id

Success 200:

```json
{
  "success": true,
  "ticket": {
    "id": "665f1f...",
    "ticketId": "TCK-123456",
    "name": "Mohamed Star",
    "phone": "01012345678",
    "status": "open",
    "messages": [
      {
        "sender": "user",
        "senderName": "Mohamed Star",
        "text": "I need help",
        "imageUrl": null,
        "createdAt": "2026-06-11T14:00:00.000Z"
      }
    ],
    "createdAt": "2026-06-11T14:00:00.000Z",
    "updatedAt": "2026-06-11T14:00:00.000Z"
  }
}
```

### POST /client/tickets/:id/reply

Request:

```json
{
  "text": "More details"
}
```

Success 200:

```json
{
  "success": true,
  "message": {
    "sender": "user",
    "senderName": "Mohamed Star",
    "text": "More details",
    "createdAt": "2026-06-11T14:00:00.000Z"
  }
}
```

## Registration

All registration endpoints create a pending request. They do not create an active login account until admin approval.

Username rules:

- Flutter may send `m_star`.
- The backend stores and returns `m_star@ahram.com`.
- After admin approval, login should use the returned full username `m_star@ahram.com` or phone when supported by that account.
- The suffix is auto-added by all four mobile registration endpoints when the submitted username has no `@`.

Confirm password:

- `confirmPassword` is not required by the mobile API.
- Flutter should validate password confirmation locally for UX.
- Backend currently validates only `password`.

Password storage:

- `RegistrationRequest` hashes `password` before save.
- Responses do not return password.

### POST /client/register/direct

Request:

```json
{
  "fullName": "First Second Third",
  "phone": "0912345678",
  "storeName": "Star Store",
  "address": "Tripoli",
  "username": "m_star",
  "password": "123456"
}
```

Success 200:

```json
{
  "success": true,
  "message": "Registration request submitted successfully and is pending admin review",
  "data": {
    "refCode": "REG-2606-123456",
    "accountType": "direct",
    "fullName": "First Second Third",
    "phone": "0912345678",
    "storeName": "Star Store",
    "address": "Tripoli",
    "username": "m_star@ahram.com",
    "status": "pending",
    "createdAt": "2026-06-11T14:00:00.000Z"
  }
}
```

### POST /client/register/new

Same as direct, plus:

```json
{
  "agentCode": "12345678"
}
```

`agentCode` is required and must belong to an active agent.

### POST /client/register/company

Request:

```json
{
  "companyName": "Legal Company Name",
  "companyContact": "Company Manager",
  "companyPhone": "0912345678",
  "companyEmail": "company@example.com",
  "username": "company_user",
  "password": "123456"
}
```

### POST /client/register/agent

Request:

```json
{
  "companyName": "Agency Name",
  "fullName": "Manager First Second",
  "phone": "0912345678",
  "address": "Tripoli",
  "city": "Tripoli",
  "companyEmail": "agent@example.com",
  "username": "agent_user",
  "password": "123456"
}
```

Success includes generated `agentCode`.

## Staging Notes

If the staging server is running with an in-memory database, all data and accounts reset when the server process restarts.

The current `lhr.life` URL should be treated as a tunnel/testing URL unless it is explicitly reserved. It may change if the tunnel or hosting session is recreated.

## Postman

A ready collection is available at:

```text
docs/Flutter-Mobile-API.postman_collection.json
```
