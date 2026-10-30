# Customer account documents

The retail page is `/client/settings?section=documents`. It reads account metadata and the canonical `verificationDocuments` array on User/SubAccount. Upload receipt is pending; approval requires an explicit master-admin review. An approved identity document is required for the page to show verified documents. This display does not alter account status, login factors, transfer eligibility or financial records.

New files are stored outside public/static uploads in `private/account-documents`, with generated names. Include this directory in private server backups and restrict filesystem access to the application/service administrator. Do not publish it through IIS or a static file mapping. Each download checks an authenticated account's document reference; admins use a master-protected route. Downloads use attachment disposition, no-store, nosniff and sandbox headers. Existing supported administrator-uploaded files remain accessible through the owner-scoped proxy.

Uploads accept one PDF/JPEG/PNG/WebP up to 5 MiB with matching file signature. They require CSRF, active customer ownership and an upload rate limit. User input never sets owner, file path or review result. File names are escaped in the UI. The server rejects replacing pending/approved documents; rejected documents may be replaced and return to pending. Revision checks reject stale upload/review forms. Failed persistence removes only the newly written file; previous files are retained for review/audit retention.

Master admins review documents in the account editor's separate review section. Rejection requires a reason. Saving a review increments the same document revision used by the customer upload form. Administrator document replacements also increment it. The customer can refresh the displayed result without leaving the page.

Browser-selected drafts remain local until upload. The page previews images, labels PDFs without embedding them, warns on navigation/unload, and retains drafts after failures. Clearing the choice or a confirmed successful upload removes the warning. The feature has no financial side effects.
