# Login OTP delivery policy

Login OTP is controlled per account by an administrator. The account must have
`otpDeliveryChannel=email` and a valid stored email address before login OTP is
required. With OTP disabled for the account, password login continues without
requesting or sending a code. WhatsApp is never used for login OTP, regardless
of `WHATSAPP_OTP_ENABLED` or `WHATSAPP_LOGIN_OTP_ENABLED`.

In the admin account editor, enable the email OTP checkbox only after saving a
valid email address. Clearing the checkbox disables login OTP for that account;
it does not enable WhatsApp. This can be changed independently for each managed
account. If email OTP is enabled but the address is invalid, login fails closed.
If email delivery is explicitly disabled by `EMAIL_OTP_ENABLED=false`, login
OTP also fails closed for enabled accounts and never falls back to WhatsApp.

The environment variables below do not opt an account into login OTP:

- `WHATSAPP_OTP_ENABLED` controls non-login WhatsApp OTP flows only.
- `WHATSAPP_LOGIN_OTP_ENABLED` is retained for compatibility but does not
  activate or route login OTP.
- `LOGIN_OTP_SKIP_WITHOUT_EMAIL` is retained for compatibility but no longer
  controls per-account login OTP behavior.

Receipt messages, cancellation receipts, rate alerts, financial group alerts,
and support replies are separate flows and are not disabled by the login OTP
policy.

## Password reset

Password reset is email-only and stays off unless `PASSWORD_RESET_EMAIL_ENABLED`
is `1`, `true`, `yes`, or `on`. Unset is off, and login OTP does not read that
flag. When enabled, `POST /api/password-reset/start` sends a separate code with
purpose `password_reset` only for accounts with `otpDeliveryChannel=email` and a
valid stored address. WhatsApp is never a fallback. Every start returns the
same HTTP 200 body whether or not the account exists or has an eligible address.
Accounts that do not qualify follow the manual procedure in
`docs/operations/password-reset.md`.

## Email template

`LOGIN_OTP_EMAIL_TEMPLATE_V2` changes the template only. It defaults to off;
unset, `false`, `0`, `off`, or `no` keeps the current template. `true`, `1`,
`yes`, or `on` selects the dark template. The flag never changes whether an
account is eligible for OTP. The logo is a remote image with alt text. If
rendering the new template fails, the current template is used and the error is
logged without the code.

## SMTP (no secrets)

Set these in the host environment. Never commit `SMTP_PASS` or a real mailbox
password.

| Variable | Role |
| --- | --- |
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | Usually `587` (STARTTLS) or `465` (implicit TLS) |
| `SMTP_SECURE` | `true` for port 465; empty uses secure mode only when port is 465 |
| `SMTP_USER` | Mailbox username |
| `SMTP_PASS` | Mailbox password; not in Git |
| `SMTP_FROM` | Optional full From header; wins over the template default |

A missing host, user, or password returns `SMTP_CONFIG_MISSING`. A provider
failure returns `EMAIL_OTP_SEND_FAILED` or `EMAIL_OTP_TIMEOUT`. The OTP is
cleared, no login session is opened, and no WhatsApp fallback occurs.

## Brand variables

Empty values use defaults. Add samples only in `.env.example`; do not commit a
production `.env`.

```ini
BRAND_NAME=أهرام باي
BRAND_SUPPORT_EMAIL=support@ahrampay.com
BRAND_PHONE_TEL=0913731533
BRAND_PHONE_DISPLAY=0913731533
BRAND_ADDRESS=ليبيا / مصراتة، سوق الاستثمار / أمام المسجد العالي
BRAND_WEBSITE=https://ahrampay.com
LOGIN_OTP_EMAIL_TEMPLATE_V2=false
```

`BRAND_PHONE_TEL` is used by `tel:` links and `BRAND_PHONE_DISPLAY` is the
visible number. Both default to `0913731533`.

## DNS

SPF and DKIM were previously observed for `ahrampay.com`; DMARC was not
published at the time of the last check. Verify DNS with the mail provider
before making delivery policy changes.
