# Agency statement email

Agency Settings → Notifications now stores verified statement email subscriptions
in MongoDB, separately from login OTP addresses and browser Push preferences.
Each authorized actor has an independent subscription. The attachment is the
agency statement from comprehensive administration reports: `loadAdminReport`
with category `agent`, the authenticated agency ID, subtype `all`, the previous
Libya day and the agency tenant, rendered by `generateAdminReportPdf` using
`reports_pdf.ejs`. No separate email statement template or calculation exists.
Receiving this full account statement requires both balance and agency-wide
report permissions; ordinary employees cannot subscribe. Actor status, parent
agency, tenant and permissions are checked again
before sending. No financial records are written by this feature.

## Deployment

- Configure existing `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
  `SMTP_PASS` and `SMTP_FROM`. The provider must accept the sender address.
- Keep `SESSION_SECRET` stable and at least 32 characters. It protects code hashes.
- Install Chrome/Edge/Chromium, or set `PUPPETEER_EXECUTABLE_PATH` to its executable.
  PDF rendering reuses the application's existing report browser service.
- Daily sending starts only with `NODE_ENV=production` and unless
  `AGENT_REPORT_EMAIL_ENABLED=false`. It is independent of financial settlement
  switches and does not enable financial schedulers or make money movements.
- Startup creates the two new collections' indexes. Check application logs if
  database permissions prevent index creation. No financial migration is required.

## Verification and delivery

Codes contain six random digits, expire after ten minutes, and allow five failed
attempts. New requests have a durable 60-second cooldown and an authenticated
account rate limit. Codes are stored as HMAC hashes, are single-use, and do not
activate email until confirmed. Changing an address preserves the old verified
recipient until the replacement is confirmed. Disabling email stops queued sends.

The worker checks every minute. At or after 00:05 Libya time it schedules the
previous local day, for subscriptions verified by that day's end. A restart can
catch up the previous day's unsent report. There is no retroactive daily series
for days when the service was offline. A unique subscription/day delivery key and
atomic claims protect against parallel processes. Definite failures retry up to
three times, fifteen minutes apart. SMTP timeouts or interrupted sends can have
unknown outcomes and are marked `uncertain`; they are not automatically resent.
SMTP acceptance indicates submission to the provider, not proof of inbox delivery.

The test button sends the previous day's statement to the verified recipient,
with a ten-minute cooldown. It never accepts an arbitrary destination address.

The administration loader is called in read-only mode: it reads existing day
closures but does not generate settlements from an email task. Financial totals,
opening/ending balances, operation status treatment and PDF layout therefore use
the same code as the administration download. No independent email totals or
silent row limit is applied. The generated-at timestamp reflects when the email
attachment was produced; later edits can also change a later administration
download for the same date.

Local static previews do not send real mail. Verify an actual delivery on the
configured server before considering the SMTP integration operational.

## Shared email design (2026-10-28)

Company and agency mailers now use `services/reportEmailTemplate.js` and the RTL table-based `views/emails/report-email.ejs`. Both send HTML plus a plain-text alternative and a local CID logo, with no external image fetch. Verification messages show the six-digit code in left-to-right order, its existing ten-minute validity and the account name; the inbox preheader does not reveal the code. Daily messages identify the report day in Libya, the company/agency account and the PDF attachment filename. Test deliveries are explicitly labelled.

The attachment remains the exact administration PDF buffer; no totals, dates, schedule or consent checks were replaced. The CTA opens the relevant account's notification settings over HTTPS; the PDF is opened through the mail application's actual attachment control, not a fabricated download URL. Dynamic HTML is escaped and invalid codes/dates are rejected. Account names come from the authorized workspace, including its final pre-send permission check.

Validation: 35 tests in five suites passed with SMTP mocked, plus browser previews at 320/390/1366px without horizontal overflow. No real messages were sent. A browser preview does not establish rendering in every mail client or actual SMTP deliverability.

Additional MIME verification uses Nodemailer's real in-memory stream transport, with no SMTP connection. It verifies the HTML/plain-text alternatives, inline JPEG Content-ID, PDF filename/type and exact original PDF bytes in the assembled message for both account types. The focused template/subscription/delivery/source suite passed all 31 tests across four suites after these checks were added.
