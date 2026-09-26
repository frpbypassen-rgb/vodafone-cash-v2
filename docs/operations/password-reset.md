# Password reset by email

`POST /api/password-reset/start` always returns the same JSON. The message
does not say whether the username exists or whether a verified email is
stored. A verified email is a valid address on `businessProfile.email`
(retail client) or `email` (sub-account). WhatsApp is not used.
`WHATSAPP_OTP_ENABLED` stays off and is not a fallback.

When a verified email exists, the server stores an HMAC of a 6-digit code
with purpose `password_reset`. That digest does not verify as a login OTP,
and a login OTP does not verify as a reset code. The code expires after 10
minutes, allows 5 attempts, and is single-use. Another send for the same
account is limited to 5 in 10 minutes and by `OTP_RESEND_COOLDOWN_SECONDS`.
The same route is also limited per IP.

A failed email send expires the request, clears the hash, writes an audit
entry with the delivery code, and still returns the public start message.
No session is opened.

After a correct code and a new password, `webPassword` is replaced, 
`sessionVersion` is incremented, `refreshToken` is removed, and active
mobile device sessions for that account are revoked. Web portal requests
for that client compare `sessionVersion` and end the old browser session.

Audit actions are `PASSWORD_RESET_START`, `PASSWORD_RESET_VERIFY`,
`PASSWORD_RESET_FAILURE`, and `PASSWORD_RESET_SUCCESS`. The entries carry
the purpose and a status code. They do not carry the code or the password.

The message uses the phone and email from `getBrandContact`
(`BRAND_PHONE_DISPLAY`, `BRAND_SUPPORT_EMAIL`). Defaults are `0913731533`
and `support@ahrampay.com`, isolated as left-to-right text.

## Accounts without a verified email

There is no self-service reset. The public start message already tells the
person to contact support. Staff then do this by hand:

1. Confirm the account has no valid stored email.
2. Verify the customer's identity out of band. Do not send the reset code
   on WhatsApp.
3. Set a new password from the existing account-management screen. That
   change increments `sessionVersion` and clears the refresh token.
4. Ask the customer to sign in and add a verified email before the next
   reset.

Support contact, from the same brand config: `0913731533` and
`support@ahrampay.com`.
