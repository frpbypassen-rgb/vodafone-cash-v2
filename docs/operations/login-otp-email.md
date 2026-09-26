# Login OTP email

Email is already the live login OTP channel for any account with a usable
address. `WHATSAPP_LOGIN_OTP_ENABLED` and `LOGIN_OTP_SKIP_WITHOUT_EMAIL`
are unchanged: WhatsApp is only for accounts with no usable email, and
skip-without-email still completes password-only login for those accounts.
Do not put the email channel behind an off switch.

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

From the application directory on the production host. This starts a
separate Node process, loads `.env`, then forces the new template for that
process only. It does not edit `.env` and does not reload PM2. The
recipient is fixed to `support@ahrampay.com`.

```powershell
node .\scripts\sendLoginOtpTemplateV2Sample.js
```

Do not point this at a customer address.

## DNS for ahrampay.com

Looked up on 2026-09-26 against 1.1.1.1 and 8.8.8.8. Nameservers:
`ns1.ns.ly` through `ns5.ns.ly`.

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
