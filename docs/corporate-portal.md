# Corporate Portal / بوابة الشركات

Arabic and English onboarding for the Al-Ahram Pay corporate module. The portal reuses the existing company session (`ClientEmployee` + `ClientCompany`), the double-entry `walletService` ledger, and the chained `AuditLog`. It does **not** add a second login stack.

---

## English

### What it is

A company-scoped workspace at `/corporate` (pages) and `/api/corporate` (JSON). Three roles, always isolated by `companyId`:

| Role | Arabic | Can do |
|---|---|---|
| `manager` | مدير | Approve/reject above employee limits, add beneficiaries, assign roles/limits |
| `employee` | موظف | Pay **approved** beneficiaries only; submit requests; export own history |
| `accountant` | محاسب | View all company ops, annotate, reconcile, export ledger/recon CSV |

Cross-role access returns **403**. Company A cannot read company B.

### Onboard a company

1. Company staff must already exist as `ClientEmployee` rows (same as the client portal).
2. Enable the portal (non-production demo helper or admin script):

```bash
NODE_ENV=development ALLOW_CORPORATE_DEMO_SEED=true npm run seed:corporate
```

Or in code / a Mongo shell-equivalent script:

```js
const { enableCompanyPortal, assignCorporateRole } = require('./services/corporateOnboardingService');
await enableCompanyPortal({
  companyId,
  brandingName: 'Acme Egypt',
  sharedDailyLimit: 100000,           // EGP major units, 0 = unlimited
  defaultEmployeeApprovalLimit: 500,
  defaultManagerApprovalLimit: 20000
});
await assignCorporateRole({
  employeeId,
  companyId,
  corporateRole: 'manager',           // manager | employee | accountant
  approvalLimit: 20000,
  enabled: true
});
```

3. Flags that must be true (fail-closed):
   - `ClientCompany.corporatePortal.enabled` **or** `CompanyProfile.enabled`
   - `ClientEmployee.corporatePortalEnabled` must not be `false`
4. Log in through the existing client login (`/login?portal=client`) with the company username, then open `/corporate`.

### Approval limits

Amounts use the same EGP major units as `Transaction.amount` (not piasters), so they match the existing ledger.

- If `amount > actor.approvalLimit` (or the company default for that role) the request becomes `pending_approval`.
- Only a **manager other than the requester** can approve.
- Approval posts a `TRANSFER` debit on `ClientCompany` via `updateBalanceWithLedger` and is idempotent on `reference`.

### Demo locally

```bash
# 1. App running with Mongo + session store as usual
# 2. Seed only outside production
NODE_ENV=development ALLOW_CORPORATE_DEMO_SEED=true npm run seed:corporate

# Demo password (not a production secret): CorpDemo!234
# corp.manager@ahram.com      manager
# corp.employee@ahram.com     employee
# corp.accountant@ahram.com   accountant

# 3. Sign in as a company user, then:
# Desktop command center:  http://localhost:3000/corporate?view=desktop
# Mobile on-the-go:        http://localhost:3000/corporate?view=mobile
```

Force override is stored on the session (`?view=mobile|desktop`). UA detection is the default.

Insights, OCR, and invoice matching are **rule-based / DEMO** unless `CORPORATE_OCR_ENDPOINT` is set. The UI labels them as قواعد/تقديرات.

---

## العربية

### ما هي البوابة؟

مساحة عمل للشركات على `/corporate` وواجهة JSON على `/api/corporate`. ثلاثة أدوار دائماً داخل `companyId` واحد. لا يوجد تسجيل دخول موازٍ: تُستخدم جلسة بوابة العميل الحالية (`accountType=company`).

### ضم شركة وتعيين الأدوار

1. أنشئ موظفي الشركة كالعادة في `ClientEmployee`.
2. فعّل البوابة عبر `enableCompanyPortal` ثم `assignCorporateRole` لكل مستخدم.
3. حد الاعتماد `approvalLimit` بالمبلغ نفسه المستخدم في دفتر النظام (جنيه وليس قروش).
4. سجّل الدخول من `/login?portal=client` ثم افتح `/corporate`.

البذرة التجريبية (`npm run seed:corporate`) **لا تعمل في الإنتاج** وتتطلب `ALLOW_CORPORATE_DEMO_SEED=true`.

### حدود الاعتماد

- الموظف يحوّل فقط لمستفيد بحالة `approved`.
- إذا تجاوز المبلغ حدّه يذهب الطلب إلى `pending_approval`.
- المدير يعتمد/يرفض مع سجل تدقيق غير قابل للتعديل (سلسلة AuditLog).
- المحاسب يضيف ملاحظات ويطابق ويصدّر CSV كاملاً.

---

## Schema notes

| Collection | Purpose |
|---|---|
| `ClientEmployee` | `corporateRole`, `approvalLimit`, `corporatePortalEnabled` |
| `ClientCompany.corporatePortal` | company-level enable + shared limits + branding |
| `CompanyProfile` | 1:1 settings + linked user ids |
| `CorporateBeneficiary` | approved payees; account numbers AES-GCM encrypted |
| `CorporatePaymentRequest` | `draft \| pending_approval \| approved \| rejected \| executed` + ledger id |
| `CorporateInvoice` | accountant uploads + match metadata |
| `AuditLog.companyId` | company-scoped immutable append |

Indexes: `companyId + status + createdAt` on requests and beneficiaries.
