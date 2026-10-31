# Customer home operation dialog

Recent home operations open an accessible native dialog. The original report URL remains as a fallback when JavaScript/dialog support is absent. Each open fetches fresh details using the operation's database ID. Closing aborts pending requests and releases transient image URLs; a subsequent selection cannot be replaced by an older response.

The retail GET endpoints require an active User/SubAccount context and parent/tenant validation. Details and proof reads apply an exact owner/tenant filter, exclude other company/subordinate activity, and return only allowlisted customer fields. Subordinate pricing uses its customer charge/rate. Receipt selection reuses the existing customer receipt policy, including cancellation/split receipts, and excludes executor-only attachments. Provider file references never appear in the response.

Image download uses an authenticated image fetch and a temporary local blob. Sharing sends the prepared image File through the device's native share sheet rather than sharing an authenticated server link. Unsupported browsers show a download alternative; cancellation is distinct from failure. Generated SVG receipts are rasterized to PNG for download/sharing. Missing or unreadable proofs never produce a fabricated receipt. All endpoints are read-only: no dispatch, accounting, status or balance mutations are introduced.
