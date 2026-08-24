# Ahram Pay Access Control

## Scope

The security control module is isolated from financial business logic. It manages:

- one active web device and one active mobile-app device per protected principal;
- WebAuthn passkeys for the administration device;
- approval requests when an account moves to a different device;
- administrator roles and explicit permissions;
- absolute 12-hour web and mobile security sessions;
- high-confidence network-risk signals supplied by the trusted edge;
- a single-use emergency code that freezes protected financial and account mutations for 60 minutes;
- immutable audit events for every security-sensitive decision.

## Safe activation order

1. Deploy with all enforcement switches disabled. This is the default.
2. Set `SECURITY_DEVICE_HASH_SECRET`, `WEBAUTHN_RP_ID`, and `WEBAUTHN_ORIGIN` in production.
3. Sign in as the master administrator over HTTPS.
4. Open `/admin/security` and register the administration device with Windows Hello or a platform passkey.
5. Test the passkey from the same page.
6. Generate the emergency code and store it offline. The plaintext code is shown once.
7. Create restricted administrator accounts and assign their permissions.
8. Enable administrator device enforcement.
9. Enable account device enforcement only after the mobile app version that sends `X-Device-Id`, `X-Client-Channel: app`, and login location is distributed.
10. Enable administrator permission enforcement after every administrator has an explicit permission set.

Do not enable administrator device enforcement before a passkey is registered. The server rejects that configuration.

## Required production variables

```env
SESSION_MAX_AGE_MS=43200000
SECURITY_DEVICE_HASH_SECRET=<dedicated random secret, at least 32 bytes>
WEBAUTHN_RP_NAME=Ahram Pay
WEBAUTHN_RP_ID=ahrampay.com
WEBAUTHN_ORIGIN=https://ahrampay.com
MOBILE_SECURITY_SESSION_TTL_SECONDS=43200
```

`WEBAUTHN_RP_ID` is the domain only. `WEBAUTHN_ORIGIN` includes `https://` and must exactly match the public origin.

## VPN and proxy decisions

The application does not guess VPN use from browser names or ordinary IP changes. It blocks only a high-confidence signal supplied by a trusted reverse proxy using one of:

- `X-VPN-Detected: true`
- `X-Security-VPN: true`
- a Cloudflare WARP tag header

Configure the reverse proxy to remove these headers from untrusted incoming traffic and set them itself. IP and location are risk signals, not authentication factors.

## Emergency recovery

The emergency route is `/security/emergency-access`. It requires:

- valid administrator credentials;
- browser geolocation;
- the single-use emergency code.

A successful recovery immediately freezes protected mutations for exactly 60 minutes and creates a restricted session that can access only the security center. It does not bypass account passwords, passkeys, database controls, or audit logging.

The master administrator may also enter the valid password with `***` appended on the normal login page. The suffix only completes the first credential check; it does not grant access. The browser is then moved to the emergency-code and geolocation step. The pending proof expires after five minutes and the emergency code remains single-use.

During the lockdown:

- financial transfers, executor completion/cancellation, account mutations, and protected settings writes return HTTP `423`;
- read-only pages remain available for investigation;
- the emergency session can access only `/admin/security` and logout;
- the security center and blocked-operation page show the authoritative server countdown.

## Account sessions

Customers, companies, agents, and executors can open `/security/sessions` to review their active devices and pending access requests. The mobile application exposes the same controls from Settings.

The session policy is channel-aware:

- one active web session is allowed;
- one active mobile-app session is allowed at the same time;
- signing in from a second browser requires approval and replaces only the previous web session;
- signing in from a second application requires approval and replaces only the previous application session;
- revoking the current session signs out only that device and channel;
- the account owner can approve or reject pending requests from an already active session.

The server derives the authoritative channel from its own API route. Mobile clients send `X-Client-Channel: app` for diagnostics, but that client-controlled header cannot change a web request into an app session. The startup migration assigns legacy Flutter and Android records to `app` and remaining records to `web`, then creates a unique active-device index per channel.

## Device transfer

When a correct account password is used on a different device, the old device is not immediately revoked. A 15-minute approval request is created with the device description, IP, geolocation, and trusted-edge risk signals. The main administration receives an in-app security notification. Approval revokes the old device in the same channel and activates the new device; rejection leaves the existing web or app session unchanged. The other channel remains active.

Do not use IP address alone as a device identifier. Residential and mobile IP addresses change. The control combines a random device identifier, a server-side HMAC, location as a risk signal, session expiry, and a platform passkey for administration.

## Rollback

If a client rollout is incomplete, disable account device enforcement from `/admin/security`. Do not remove device records or weaken token validation. Administrator enforcement can be disabled only from an authenticated security-manager session.
