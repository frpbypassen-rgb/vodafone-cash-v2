# Corporate portal user guide / دليل المستخدم

Short per-role guide. Insights marked **قواعد/تقديرات** or **DEMO** are heuristics, not an LLM.

---

## Manager / المدير

**Goal:** oversight, final approval, team admin.

- Open `/corporate` (desktop = command center, mobile = thumb CTAs).
- **اعتماد المعلق:** review pending transfers. You can open several desktop modals side by side.
- Approve posts to the company ledger once; reject stores a reason and an audit row.
- **المستفيدون:** add approved payees. Employees cannot pay anyone else.
- **الفريق:** set `manager | employee | accountant` and each person's `approvalLimit`.
- Keyboard (desktop): `Ctrl/Cmd+1` home, `+2` transfers, `+3` approvals, `+4` reports.
- You cannot approve your own request when it is above your limit — another manager must.

## Employee / الموظف

**Goal:** fast daily payouts to the approved list only.

- Home CTA on mobile is **تحويل سريع**.
- Two steps: pick beneficiary → amount, then confirm sheet.
- Confirm uses WebAuthn / `PublicKeyCredential` when a passkey exists; otherwise password/PIN. **The password or WebAuthn assertion is sent on the create/approve request itself** — a prior UI-only confirm is not enough.
- Amounts above your limit go to the manager (`pending_approval`).
- You cannot add beneficiaries, approve others, or export the full company ledger — only your own history CSV.
- Hitting accountant or manager APIs returns **403**.

## Accountant / المحاسب

**Goal:** review, reconcile, tax/audit.

- Home CTA on mobile is **مراجعة اليوم**.
- See every company request. Add immutable-style audit notes (append only).
- Mark executed lines as reconciled.
- Desktop: drag-and-drop invoice/docs. Duplicate-invoice and ledger-match panels are **rule-based**.
- Export CSV includes requests + company ledger lines.
- You cannot create or approve transfers.

---

## Shared / مشترك

| Topic | Behavior |
|---|---|
| Offline | Last balance + recent ops cached; banner **بيانات مخزّنة** |
| OCR | Camera capture on mobile; without `CORPORATE_OCR_ENDPOINT` you get a labeled DEMO parse — confirm manually |
| Device | `?view=mobile` or `?view=desktop` overrides User-Agent |
| Client portal | Still available at `/client/dashboard` for the existing company workspace |
