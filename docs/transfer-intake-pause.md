# Pause new transfer intake

The admin `isManualClosed` switch means **stop accepting new transfers**. Existing transactions continue through routing, execution, provider polling, callbacks, receipt generation and completion. It does not pause BullMQ or change runtime switches, transaction statuses or balances.

Web and mobile creation already checked this setting. Merchant API creation now also checks it inside the financial transaction, before routing or wallet/ledger writes. Rejections return HTTP 403 with `SYSTEM_CLOSED` and explain that existing transactions continue. Web form requests receive a response even without AJAX headers. Turning the switch off permits normal creation again.

The settings label describes this intake-only behavior. No production setting is toggled by the software update.

Validation: web requests with and without AJAX headers, mobile creation and merchant API creation reject new transfers while closed without financial writes. A real isolated Mongo/provider integration test closes intake after a Kenan operation is recorded and verifies polling through every waiting status to exactly one successful completion/debit without another provider payment request.
