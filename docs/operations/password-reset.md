# Password reset by email

`POST /api/password-reset/start` always returns the same JSON. The message
does not say whether the username exists or whether an approved address is
stored. WhatsApp is not used. `WHATSAPP_OTP_ENABLED` stays off and is not a
fallback.

## Which address can receive a reset code

No model stores `emailVerified` or `emailVerifiedAt`. A well-formed address
on its own is not enough.

The reset is sent only when both are true:

- `otpDeliveryChannel` is `email`
- the stored address is valid (`businessProfile.email` on a retail client,
  or `email` on a user-owned sub-account)

That channel is the admin-controlled flag. It is set to `email` when an
administrator saves a valid address from the account editor, when
registration approval stores the address, or when an administrator saves
the admin login email. The editor does not keep a separate boolean. Saving
the valid address sets the channel.

Scope is a retail `User` (not role `agent`) and a `SubAccount` with
`masterType` `user`. Company staff, agents, and administrators are not
looked up by this route.

Accounts that already have `otpDeliveryChannel: 'email'` and a valid
address qualify with no migration. That includes production accounts whose
email was saved from the admin panel after the email field and the channel
were added.

Accounts that have a valid address but still have the default channel
`whatsapp` do not qualify. That includes older rows written before the
channel existed. An administrator re-saves the address on the account
screen, which sets the channel. There is no backfill script: flipping the
channel for every stored address would treat addresses that were never
saved by that path as approved.

The public sentence says «بريد مفعّل». It does not say the address was
proven by a mailbox check.

## Code, window, and completion

When an approved address exists, the server stores an HMAC of a 6-digit
code with purpose `password_reset`. That digest does not verify as a login
OTP, and a login OTP does not verify as a reset code. The code expires
after 10 minutes, allows 5 attempts, and is single-use. Each verify
increments `otpAttempts` with a conditional update (`status: otp_sent`,
not expired, `otpAttempts < 5`) before the code is compared. The attempt
that reaches 5 and is wrong sets the request to `expired` and clears the
hash. A later submit, including the correct code, does not pass that
filter.

Another send for the same account is limited to 5 in 10 minutes and by
`OTP_RESEND_COOLDOWN_SECONDS`. The same route is also limited per IP.

A failed email send expires the request, clears the hash, writes an audit
entry with the delivery code, and still returns the public start message.
No session is opened and `sendOtp` is not called.

`otpVerifiedAt` is set when the code is accepted. The new password must be
submitted within `PASSWORD_RESET_COMPLETE_WINDOW_SECONDS`. The default is
600 seconds. Values below 60 or above 600 are clamped. After the window,
the request is set to `expired` and the person must start again.

Completion runs in one MongoDB transaction:

1. Conditional update from `otp_verified` to `completing`, only while
   `otpVerifiedAt` is still inside the window.
2. Replace `webPassword` with the bcrypt hash, increment
   `sessionVersion`, and remove `refreshToken` plus the login OTP fields.
3. Delete connect-mongo `sessions` documents for that account id.
4. Revoke active `MobileDeviceSession` rows.
5. Set the request to `completed`.

Two concurrent completions can commit only one of those transitions. If
any step throws, the transaction aborts. The password, `sessionVersion`,
refresh token, web sessions, device sessions, and request status all stay
as they were (`otp_verified`). The request is not left in `completing`,
because that status is written only inside the transaction. The caller
receives a failure, not success. A retry is allowed until the window ends.

`completing` is not a state operators should see after a request finishes.
If a document is ever found in `completing` outside a transaction, set it
to `expired` by hand and ask the customer to start again. Do not add an
index for this flow. Claims filter on `_id`. Creating indexes in
production is a separate approved step and is not part of this change.

## Audit and support

Audit actions are `PASSWORD_RESET_START`, `PASSWORD_RESET_VERIFY`,
`PASSWORD_RESET_FAILURE`, and `PASSWORD_RESET_SUCCESS`. The entries carry
the purpose and a status code. They do not carry the code or the password.

The message uses the phone and email from `getBrandContact`
(`BRAND_PHONE_DISPLAY`, `BRAND_SUPPORT_EMAIL`). Defaults are `0913731533`
and `support@ahrampay.com`, isolated as left-to-right text.

## Accounts without an approved address

There is no self-service reset. The public start message already tells the
person to contact support. Staff then do this by hand:

1. Confirm the account has no valid address with `otpDeliveryChannel`
   `email`.
2. Verify the customer's identity out of band. Do not send the reset code
   on WhatsApp.
3. Set a new password from the existing account-management screen. That
   change increments `sessionVersion` and clears the refresh token.
4. If the customer should reset by email next time, save a valid address
   on that same screen so the channel becomes `email`.

Support contact, from the same brand config: `0913731533` and
`support@ahrampay.com`.

## Rollback

Revert the application commit. Documents in `otp_sent`, `otp_verified`,
`expired`, or `completed` remain readable by the previous code. No account
field was added, and no migration runs on boot. In-flight `otp_verified`
requests keep `otpVerifiedAt`. After a revert, the previous completion path
does not apply this window. A request stuck in `completing` (it should not
be, because that write commits only together with `completed`) should be
set to `expired` manually before relying on it.
