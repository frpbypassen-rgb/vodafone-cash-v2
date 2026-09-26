# Login OTP email

Email is the live login OTP channel for any account with a usable address.
`EMAIL_OTP_ENABLED` defaults to on when unset. An explicit `0` / `false` /
`no` / `off` returns `EMAIL_OTP_DISABLED` and does not send on WhatsApp.
`OTP_DELIVERY_CHANNEL=email` selects email for accounts that have a valid
address. A failed email send never falls back to WhatsApp. The only email
fallback is the new template to the current cream template.

`WHATSAPP_OTP_ENABLED` defaults to off. Only `1` / `true` / `yes` / `on`
allows `sendOtp` to call WhatChimp. Unset, `false`, `0`, `off`, and `no`
return `WHATSAPP_OTP_DISABLED` with no HTTP request to WhatChimp or
WP Sender. When the flag is on and `WHATCHIMP_ENABLED` is off, the result
is `WHATCHIMP_DISABLED` and WP Sender is still not used for OTP. Receipts,
cancellation receipts, rate alerts, financial group alerts, and support
replies do not read this flag.

`WHATSAPP_LOGIN_OTP_ENABLED=false` still returns
`WHATSAPP_LOGIN_OTP_DISABLED` for accounts with no usable email, before
the newer flag is considered. `LOGIN_OTP_SKIP_WITHOUT_EMAIL=true` still
completes password-only login for those accounts, including when the
selection code is `WHATSAPP_OTP_DISABLED`, because the channel stays
`whatsapp`. An account that explicitly selects email but has no valid
address still fails with `EMAIL_OTP_ADDRESS_INVALID`.

A production `.env` that already has `WHATSAPP_LOGIN_OTP_ENABLED=false`
and does not yet define the new variables cannot send an OTP on WhatsApp:
unset `WHATSAPP_OTP_ENABLED` is off inside `sendOtp`. Add these lines and
reload the process. Keep the two existing lines as well:

```
OTP_DELIVERY_CHANNEL=email
EMAIL_OTP_ENABLED=true
WHATSAPP_OTP_ENABLED=false
WHATSAPP_LOGIN_OTP_ENABLED=false
LOGIN_OTP_SKIP_WITHOUT_EMAIL=true
```

Do not add the three new names to `productionSecurityDefaults` or to the
required production boot flags.

Password reset (`POST /api/password-reset/start`) does not call WhatsApp
and does not look up the account. Every start returns HTTP 503 with
`PASSWORD_RESET_UNAVAILABLE` and the same Arabic support message, whether
or not an account exists. No OTP hash is stored and no session is opened.
Accounts without an email that are not covered by
`LOGIN_OTP_SKIP_WITHOUT_EMAIL` still fail closed on login with
`WHATSAPP_OTP_DISABLED` (or `WHATSAPP_LOGIN_OTP_DISABLED` when that older
flag is explicitly off).

`LOGIN_OTP_EMAIL_TEMPLATE_V2` changes the **template only**. It defaults to
off. Unset, `false`, `0`, `off`, or `no` keeps sending the current cream
template and `From: Ahram Pay <noreply@ahrampay.com>` (unless `SMTP_FROM`
is set). `true`, `1`, `yes`, or `on` sends the dark template. The visible
brand, support email, phone, address, and website on that template come
from the `BRAND_*` variables below. The confirmed phone is also used by the
current cream template, in both its HTML and plain-text parts. `SMTP_FROM`
still overrides the From header for both templates.

The flag never blocks sending. The logo is only a remote `<img>` with alt
text; the mailer does not fetch it. If the new template throws while
rendering, the current template is sent instead and the error is logged
with the code redacted.

`public/images/login-otp-logo.jpg` is a JPEG (`FFD8FF`, about 15 KB). The
app serves `public/` with `express.static` before session checks, and that
file is `Content-Type: image/jpeg`. Checked on 2026-09-26,
`https://ahrampay.com/images/login-otp-logo.jpg` is not on production yet:
the host answers `302` to `/login` with `text/plain`, because the file is
absent. After this deploy the same URL is the static JPEG.

The confirmed phone is `0913731533`, shown inside an isolated LTR element
and linked as `tel:0913731533`.

## SMTP (no secrets)

Set these in the host environment. Never commit `SMTP_PASS` or a real
mailbox password.

| Variable | Role |
| --- | --- |
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | Usually `587` (STARTTLS) or `465` (implicit TLS) |
| `SMTP_SECURE` | `true` for port 465. Empty uses secure mode only when the port is 465 |
| `SMTP_USER` | Mailbox username |
| `SMTP_PASS` | Mailbox password. Not in Git |
| `SMTP_FROM` | Optional full From header. Wins over the template default |

A missing host, user, or password returns `SMTP_CONFIG_MISSING`. A provider
failure returns `EMAIL_OTP_SEND_FAILED` or `EMAIL_OTP_TIMEOUT`. The OTP is
then cleared, no login session is opened, and the user sees the public
delivery message. The WhatsApp path is not used as a fallback for that
failure. Unknown usernames and wrong passwords both answer
`بيانات الدخول غير صحيحة.`

## Brand variables

Empty values use the defaults. Add them only in `.env.example` as samples;
do not commit a production `.env`.

```
BRAND_NAME=أهرام باي
BRAND_SUPPORT_EMAIL=support@ahrampay.com
BRAND_PHONE_TEL=0913731533
BRAND_PHONE_DISPLAY=0913731533
BRAND_ADDRESS=ليبيا / مصراتة، سوق الاستثمار / أمام المسجد العالي
BRAND_WEBSITE=https://ahrampay.com
LOGIN_OTP_EMAIL_TEMPLATE_V2=false
```

`BRAND_PHONE_TEL` is the dialable number used in `tel:`. `BRAND_PHONE_DISPLAY`
is the text shown in the message. Both default to `0913731533`.

## One test message, without a restart

One command, from any directory. It changes into the app directory, starts
a separate Node process, loads `.env`, then forces the new template because
`--template v2` is present. A `LOGIN_OTP_EMAIL_TEMPLATE_V2=false` line in
`.env` does not win. The process does not edit `.env` and does not reload
PM2. The recipient is fixed to `support@ahrampay.com`. Any other address,
including `--to`, is refused with `RECIPIENT_REFUSED` and nothing is sent.
The sample code stays inside the message. The console prints success, a
status code, and the SMTP message id only.

```powershell
cd C:\Users\Administrator\Desktop\vodafone-cash-v2; node .\scripts\sendLoginOtpTemplateV2Sample.js --template v2
```

## DNS for ahrampay.com

Looked up again on 2026-09-26 against 1.1.1.1 and 8.8.8.8. Both resolvers
agree. Nameservers: `ns1.ns.ly` through `ns5.ns.ly`.

SPF at `ahrampay.com`:

```
v=spf1 a mx ip4:102.213.183.6 ip4:5.9.99.245 ip4:5.9.99.246 include:spf.secure.ly ~all
```

DKIM selector `default` at `default._domainkey.ahrampay.com`:

```
v=DKIM1; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoeLC+0zBwpEWRakQMSExfZopxgxJxPvMnAUpRja5750g37G46ArbijenC9vHWAobfLfbY/E7zeEHVrwJzol+XT9PZ0AepBEEi1/b7e7DS8phfOUUI7yZvBJ6YXZCuVz6abzcS+vZXBoLQHYN30BZkOCcGXKS0EdnMOcXIyL15k8PSXLwZwfyNRbd3bY7dch4et2yszjDbk2RVErKUdBYKTwibMd17Vm5o0cdPL+Hjzjf9cvAUU7AxP8LPUfwXykKNAYq6akZTeq2sG82Dd+dheEj2jYz6Vj144OBG9u0tgWjl1BDMqitmOISp4YAQLhBG6bkg3C83+995v4JtKh5AQIDAQAB;
```

DMARC at `_dmarc.ahrampay.com`: no TXT record. Both resolvers return
`NXDOMAIN`. There is no published DMARC policy to quote. Add one at the
DNS host when the operator is ready; this document does not invent one.
