# Leaked seed account rotation

This runbook is for the repository owner. It checks, read-only, whether the operator account seeded by `seed-accounts.js` exists, and rotates that account if it does.

The account identifier is the executor employee `zaynapi@ahram.com` (role `operator`).

## Why rotation is mandatory

`seed-accounts.js` in this public repository contained a hard-coded password for that account and opened the production database name `vodafone_cash_system`. Deleting the value from the current files does not remove it from Git history. History rewriting is not planned and is forbidden on the production branch. If the account exists in production, its password must be rotated.

Do not paste the old password into tickets, chat, shell history, or this repository.

## What the rotation command changes

Default mode is a dry run. It only reads the employee and reports whether that username exists. It prints no password, no password hash, and no connection string.

`--apply` changes only that one employee:

- replaces `webPassword` with a bcrypt hash from the application's password service (12 rounds);
- increments `sessionVersion`;
- clears that account's refresh token and one-time-password fields;
- marks that account's active executor mobile device sessions revoked, using the existing `password_reset` reason;
- deletes web session documents that belong to that account, using the same session-store approach as password reset;
- appends one new `AuditLog` row through the existing audit service.

It does not delete or rewrite existing `AuditLog`, `Ledger`, or `Transaction` records. It does not change balances, other accounts, indexes, or migrations. It does not restart PM2. The production process name is `Ahram_Core_API`; leave it running. Active tokens pick up the new `sessionVersion` from the database on the next request.

`scripts/rotateAdminCredentials.js` is a different tool. It can remove other administrator accounts and every session. Do not use it for this operator account.

## Read-only check on the production host (PowerShell)

Work in `C:\Users\Administrator\Desktop\vodafone-cash-v2`. Load `MONGO_URI` from the existing `.env` without printing it.

```powershell
Set-Location C:\Users\Administrator\Desktop\vodafone-cash-v2
Get-Content .\.env | ForEach-Object {
  if ($_ -match '^\s*MONGO_URI=(.*)$') {
    $env:MONGO_URI = $Matches[1].Trim().Trim('"').Trim("'")
  }
  if ($_ -match '^\s*REDIS_URL=(.*)$') {
    $env:REDIS_URL = $Matches[1].Trim().Trim('"').Trim("'")
  }
}
node .\scripts\rotateLeakedSeedAccount.js
```

Do not run `Write-Host $env:MONGO_URI`, `echo $env:MONGO_URI`, or any `pm2 restart` / `pm2 reload` / `pm2 delete` command.

A successful dry run prints `mode: dry-run`, `exists: yes` or `exists: no`, and `writes: none`. If it prints `exists: no`, stop. There is nothing to rotate.

## Rotate

Generate a new password and store it only in a local file. The command does not print the password.

```powershell
node .\scripts\rotateLeakedSeedAccount.js --apply
```

The file is created under `.secrets\leaked-seed-account-rotation-<timestamp>.txt` with restricted permissions. `.secrets/` is gitignored. Copy the value into a password manager, then delete the file. Do not commit it.

To type a new password instead of generating one, use a hidden prompt. Nothing is written to a file and nothing is printed:

```powershell
node .\scripts\rotateLeakedSeedAccount.js --apply --prompt
```

`ROTATION_PASSWORD` in the environment is also accepted and is not printed. Prefer the generated file or the hidden prompt so the value is not stored in the shell history.

If `--apply` fails, the database transaction is aborted and the password hash is not changed. Do not restart PM2. Fix the reported error and run the dry run again before another `--apply`.

## Password reuse

After this account is rotated, review whether the same password was copied to anywhere else: the administrator `PANEL_PASS`, mailboxes, hosting panels, MongoDB users, VPN accounts, or other employees. Do not search Git history for the value and do not put it in a command line. A login that still accepts the previously published value, on this account or another system, still needs its own rotation. This procedure does not change those other systems.

## Git history

The leaked value remains in older commits. Removing it here does not erase those commits. Rewriting history on the production branch is forbidden and is not part of this work. Rotation is the remediation.

## Rollback

A dry run writes nothing, so there is nothing to undo.

Do not put the old password back. If the new password file is lost after a successful `--apply`, run `--apply` again. That sets another password, invalidates sessions again, and appends another audit row. Audit rows are append-only; do not delete them.

Reverting the code change does not restore the previous password hash.

---

# تدوير حساب البذرة المسرّب

هذا الإجراء لمالك المستودع. يفحص بشكل قراءة فقط هل حساب المنفذ الذي أنشأه `seed-accounts.js` موجود، ويدوّر كلمة مروره إن وُجد.

معرّف الحساب هو موظف التنفيذ `zaynapi@ahram.com` (الدور `operator`).

## لماذا التدوير إلزامي

احتوى `seed-accounts.js` في هذا المستودع العام على كلمة مرور ثابتة لهذا الحساب وعلى اسم قاعدة الإنتاج `vodafone_cash_system`. حذف القيمة من الملفات الحالية لا يحذفها من تاريخ Git. إعادة كتابة التاريخ غير مخطط لها وممنوعة على فرع الإنتاج. إذا كان الحساب موجوداً في الإنتاج فيجب تدوير كلمة مروره.

لا تلصق كلمة المرور القديمة في التذاكر أو المحادثات أو سجل الأوامر أو هذا المستودع.

## ماذا يغيّر أمر التدوير

الوضع الافتراضي تجريبي (dry-run). يقرأ الموظف فقط ويطبع هل اسم المستخدم موجود. لا يطبع كلمة المرور ولا بصمتها ولا سلسلة الاتصال.

`--apply` يغيّر هذا الموظف فقط:

- يستبدل `webPassword` ببصمة bcrypt من خدمة كلمات المرور في التطبيق (12 جولة)؛
- يزيد `sessionVersion`؛
- يمسح رمز التحديث وحقول رمز الدخول لمرة واحدة لهذا الحساب؛
- يلغي جلسات أجهزة الموبايل النشطة لهذا المنفذ بسبب `password_reset` كما يفعل مسار تغيير كلمة المرور الحالي؛
- يحذف مستندات جلسة الويب الخاصة بهذا الحساب بالطريقة نفسها المستخدمة في إعادة تعيين كلمة المرور؛
- يضيف سطراً جديداً في `AuditLog` عبر خدمة التدقيق الحالية.

لا يحذف ولا يعيد كتابة سجلات `AuditLog` أو `Ledger` أو `Transaction` الموجودة. لا يغيّر الأرصدة ولا الحسابات الأخرى ولا الفهارس ولا الترحيلات. لا يعيد تشغيل PM2. اسم عملية الإنتاج هو `Ahram_Core_API`؛ اتركها تعمل. الرموز النشطة تقرأ `sessionVersion` الجديد من قاعدة البيانات في الطلب التالي.

`scripts/rotateAdminCredentials.js` أداة مختلفة. قد تحذف حسابات مديرين أخرى وكل الجلسات. لا تستخدمها لهذا الحساب.

## فحص قراءة فقط على خادم الإنتاج (PowerShell)

اعمل داخل `C:\Users\Administrator\Desktop\vodafone-cash-v2`. حمّل `MONGO_URI` من ملف `.env` الحالي دون طباعته.

```powershell
Set-Location C:\Users\Administrator\Desktop\vodafone-cash-v2
Get-Content .\.env | ForEach-Object {
  if ($_ -match '^\s*MONGO_URI=(.*)$') {
    $env:MONGO_URI = $Matches[1].Trim().Trim('"').Trim("'")
  }
  if ($_ -match '^\s*REDIS_URL=(.*)$') {
    $env:REDIS_URL = $Matches[1].Trim().Trim('"').Trim("'")
  }
}
node .\scripts\rotateLeakedSeedAccount.js
```

لا تشغّل `Write-Host $env:MONGO_URI` ولا `echo $env:MONGO_URI` ولا أي أمر `pm2 restart` أو `pm2 reload` أو `pm2 delete`.

الفحص الناجح يطبع `mode: dry-run` و`exists: yes` أو `exists: no` و`writes: none`. إذا ظهرت `exists: no` فتوقف. لا يوجد ما يُدوَّر.

## التدوير

ولّد كلمة مرور جديدة واحفظها في ملف محلي فقط. الأمر لا يطبع كلمة المرور.

```powershell
node .\scripts\rotateLeakedSeedAccount.js --apply
```

يُنشأ الملف تحت `.secrets\leaked-seed-account-rotation-<timestamp>.txt` بصلاحيات مقيّدة. المجلد `.secrets/` مُتجاهَل من Git. انسخ القيمة إلى مدير كلمات مرور ثم احذف الملف. لا ترفعه إلى Git.

لكتابة كلمة المرور بنفسك عبر مطالبة مخفية، دون ملف ودون طباعة:

```powershell
node .\scripts\rotateLeakedSeedAccount.js --apply --prompt
```

يمكن أيضاً تمرير `ROTATION_PASSWORD` في البيئة ولن تُطبع. الأفضل هو الملف المولَّد أو المطالبة المخفية حتى لا تبقى القيمة في سجل PowerShell.

إذا فشل `--apply` تُلغى معاملة قاعدة البيانات ولا تتغير بصمة كلمة المرور. لا تعِد تشغيل PM2. عالج الخطأ ثم أعد الفحص التجريبي قبل `--apply` آخر.

## إعادة استخدام كلمة المرور

بعد تدوير هذا الحساب، راجع هل نُسخت كلمة المرور نفسها إلى مكان آخر: `PANEL_PASS` للمدير، أو البريد، أو لوحات الاستضافة، أو مستخدمي MongoDB، أو VPN، أو موظفين آخرين. لا تبحث في تاريخ Git عن القيمة ولا تضعها في سطر أوامر. أي دخول ما زال يقبل القيمة المنشورة سابقاً، على هذا الحساب أو على نظام آخر، يحتاج تدويراً مستقلاً. هذا الإجراء لا يغيّر تلك الأنظمة.

## تاريخ Git

القيمة المسرّبة تبقى في الالتزامات الأقدم. حذفها هنا لا يمسح تلك الالتزامات. إعادة كتابة التاريخ على فرع الإنتاج ممنوعة وليست جزءاً من هذا العمل. التدوير هو المعالجة.

## التراجع

الفحص التجريبي لا يكتب شيئاً، فلا شيء يُتراجع عنه.

لا تُعد كلمة المرور القديمة. إذا فُقد ملف كلمة المرور الجديدة بعد نجاح `--apply`، شغّل `--apply` مرة أخرى. ذلك يضبط كلمة مرور أخرى ويُبطل الجلسات مرة أخرى ويضيف سطر تدقيق جديد. سطور التدقيق تُضاف فقط؛ لا تحذفها.

التراجع عن تغيير الشيفرة لا يسترجع بصمة كلمة المرور السابقة.
