# التقرير النهائي — PR #76

مسودة فقط. لا دمج، لا نشر، لا ترحيل على قاعدة حقيقية، لا إنشاء فهرس، ولا تفعيل أي علم.

لا تُملأ نتيجة Staging أو Production من هذا الملف. كل نتيجة هنا مصنّفة في فئة واحدة من ثلاث:

1. **Proven by tests** — اختبار وحدة أو تكامل شُغّل في هذه المراجعة.
2. **Proven on a real MongoDB Replica Set and Redis** — قياس داخل بيئة المراجعة فقط، مع الإصدارات أدناه. ليس Staging وليس Production.
3. **Pending manual execution** — ينفّذه المشغّل. الخلايا فارغة عمدًا.

## قرارات المشغّل

1. لا حساب مقاصة في هذا الطلب.
2. المنظومة منظمة واحدة. `TENANT_MODE=single`.
3. تحويل الشركة والوكيل بكود الحساب يبقى مسموحًا.
4. الخزينة والإدارة والمنفذ يحركون الحسابات حسب الصلاحيات الحالية.
5. `FINANCIAL_TENANT_GUARD` و`FINANCIAL_BLOCK_MASTER_SUB_TENANT_MISMATCH` مطفآن ولا يُفعَّلان في الإنتاج. في وضع `single` لا أثر لهما.
6. لا دمج ولا نشر.

حركة التحويل المشروع لا تتغير والأعلام مطفأة. ما ينشط بلا أعلام، وثبت باختبارات لا بقياس إنتاج: إلحاق `AuditLog` في `NODE_ENV=production`، وتوسيع حجب الأسرار، وختم `tenantId` الاختياري.

## 1. Proven by tests

Node المستخدم في Jest: v22.14.0. هذه الاختبارات لا تقرأ Production ولا Staging.

| الإثبات | الاختبار |
| --- | --- |
| شركة إلى وكيل، ووكيل إلى شركة، والخزينة، وخصم نقطة البيع مع الوكيل، وتمويل المنفذ، وإلغاء مرة واحدة، وكل الأعلام محذوفة و`TENANT_MODE=single` | `tests/financialTenantSafety.test.js` |
| غياب Redis مع `FINANCIAL_REDIS_FAIL_CLOSED` و`REDIS_REQUIRED` يرفض قبل الخصم برمز `REDIS_LOCK_FAILED`. العلم مطفأ والتحويل ينجح رغم `REDIS_REQUIRED` | نفس الملف. Redis هنا غير مشغّل؛ الفئة 2 لا تغطي هذا السلوك |
| فشل `Ledger.create` أو `Transaction.create` على `MongoMemoryReplSet` يرجع الرصيد. فشل حفظ التدقيق داخل الجلسة يرجع الرصيد والقيد والتدقيق فقط عندما `FINANCIAL_AUDIT_IN_TRANSACTION=true` داخل الاختبار | نفس الملف |
| `NODE_ENV=test` بلا `MONGO_TRANSACTIONS_REQUIRED` وبلا رد replica set: التحويل يكتمل | نفس الملف |
| نفس `Idempotency-Key` لا يخصم مرتين، والطلب المختلف يعيد 409، و36 طلبًا متزامنًا تخصم مرة واحدة، وذلك عندما العلم مفعّل داخل الاختبار. العلم محذوف فيخصم مرتين | نفس الملف |
| الإلغاء مرتين لا يرد المبلغ مرتين. مقارنة `ReversalService` مع `main`: مبلغ الرد ورفض النداء الثاني لم يتغيرا. الصف الجديد قد يحمل `tenantId` اختياريًا فقط | نفس الملف و`07-active-without-flags.md` |
| مطابقة مجموعة الاختبار: drift = 0 بعد طرح رأس المال الافتتاحي 1297. هذا ليس مساواة مطلقة بين الرصيد ومجموع القيود، ولا يُنقل إلى Production | `docs/financial-safety/reconciliation-test.json` |
| التعبئة الجافة على القاعدة المقلَّدة: Transaction 1/1/1 وLedger 1/1/0 وJournalEvent 0/0/1 وAuditLog 1/0/1 (determined / ambiguous / legacy) و`modified=0`. الفهرس لم يُنشأ | `migration-dry-run-report.json` و`account-code-index-scan.json` |
| `deleteMany` و`updateMany` على `AuditLog` يرميان في الإنتاج | `tests/financialRecordImmutability.test.js` |
| سكربت الفحص يرفض `--apply`، ويطلب `--app-dir` حتى لا يقرأ SHA نسخة الفحص، ويقبل Node 18/20/22 ويرفض غيرها بسبب `NODE_VERSION`، ويبقي مسبار قفل Redis مطفأ، ويفصل رصيد الافتتاح بلا قيد عن الفجوات الأخرى، وفي `single` يعدّ الصف بلا منظمة `legacy_single_tenant_assignable` ولا يوقفه إلا `ambiguous` | `tests/financialSafetyReadOnlyCheck.test.js` |
| الاختباران الفاشلان موجودان على `527c7821` بلا تعديل للملفين: تسجيل دخول المنفذ 500 بدل 200، وT014/T015 يتجاوز 5000ms | `tests/mobileConsolidation.test.js` و`tests/mobileAuthContract.test.js` |

`npx jest --forceExit --runInBand` في هذه الجولة: 185 مجموعة (183 ناجحة، 2 فاشلة)، 1155 اختبارًا (1153 ناجحة، 2 فاشلة). الفشلان هما الاختباران السابقان على `main` فقط. لا تُستنتج من ذلك حالة Windows.

## 2. Proven on a real MongoDB Replica Set and Redis

القياس في بيئة المراجعة بتاريخ 2026-09-26. الملف `docs/financial-safety/review-environment-measurement.json`. `stagingMeasured=false` و`productionMeasured=false`.

| المكوّن | الإصدار المقاس |
| --- | --- |
| Node.js | v22.14.0 |
| MongoDB | 7.0.14 عبر `mongodb-memory-server` 10.1.4، عضو واحد، `wiredTiger` |
| replica set | `setNamePresent=true` و`transactionsCapable=true` و`msg` فارغ |
| Redis | 7.0.15 على `127.0.0.1:6399`، `PING` = `PONG` |
| Redlock | الحزمة `v5.0.0-beta.2`. في هذا القياس المحلي فقط حُجز المفتاح `locks:financial-safety-readonly-probe` ثم حُرّر. أمر المشغّل الافتراضي لا يحجز قفلًا |

ما لا يثبته هذا القياس: تحويل رصيد عبر Redis الإنتاج، جاهزية `/health` على Windows، مطابقة أرصدة حقيقية، أو عدد صفوف بلا `tenantId`. اختبارات الفئة 1 التي تتحدث عن Redis شغّلت القفل بينما لا يوجد خادم Redis، فلا تُنسب إلى Redis 7.0.15.

## 3. Pending manual execution

لا قيم. Staging وProduction كلٌّ بأمر مستقل. الفحص قراءة فقط: لا يعدل `.env` ولا البيانات ولا الفهارس ولا الأرصدة، ولا يعيد تشغيل الخدمة.

| الفحص | Staging | Production |
| --- | --- | --- |
| git SHA مقابل SHA المطلوب | | |
| `/health` | | |
| `/health/ready` | | |
| Mongo replica set | | |
| Redis / Redlock | | |
| الرصيد مقابل القيود | | |
| تعبئة `tenantId` الجافة: determined / legacy_single_tenant_assignable / legacy / ambiguous | | |
| `node -v` و`npm -v` و`pm2 -v` وعدد `porcelain` | | |
| تكرار `account code` بلا إنشاء فهرس | | |
| مسار كتابة `AuditLog` | | |

السكربت موجود على هذا الفرع فقط. تشغيله من مجلد الإنتاج وهو على `main` يفشل، لذلك تُنشأ نسخة منفصلة ولا تُمس شجرة الإنتاج.

### أول أمر: الإصدارات فقط

لا يشغّل سكربت الفحص. لا يكتب. إصدار Node على Windows غير مقاس هنا؛ الخانات تبقى فارغة حتى يُشغَّل هذا السطر.

Production:

```powershell
Set-Location 'C:\Users\Administrator\Desktop\vodafone-cash-v2'; Write-Output ('node ' + (node -v)); Write-Output ('npm ' + (npm -v)); Write-Output ('pm2 ' + (pm2 -v)); Write-Output ('HEAD ' + (git rev-parse HEAD)); Write-Output ('porcelain ' + (@(git status --porcelain).Count))
```

Staging:

```powershell
Set-Location 'C:\Users\Administrator\Desktop\vodafone-cash-v2-staging'; Write-Output ('node ' + (node -v)); Write-Output ('npm ' + (npm -v)); Write-Output ('pm2 ' + (pm2 -v)); Write-Output ('HEAD ' + (git rev-parse HEAD)); Write-Output ('porcelain ' + (@(git status --porcelain).Count))
```

### نسخة الفحص

تُنشأ مرة واحدة بجانب مجلد الإنتاج ولا تستبدله. `npm ci --omit=dev` لأن السكربت يحتاج اعتمادات التشغيل فقط (`mongoose` و`ioredis` و`dotenv` و`redlock`).

```powershell
Set-Location 'C:\Users\Administrator\Desktop'; if (-not (Test-Path 'financial-safety-check')) { git clone --depth 1 --branch fix/financial-tenant-safety https://github.com/frpbypassen-rgb/vodafone-cash-v2.git financial-safety-check }; Set-Location 'financial-safety-check'; npm ci --omit=dev
```

الصلاحيات: قراءة مجلد التطبيق وملفه `.env`، و`GET` محلي لـ `/health`، ومستخدم Mongo للقراءة وأمر `hello`. لا يُشترط Administrator. Node 18 أو 20 أو 22. المراجعة شغّلت Jest على v22.14.0 فقط؛ قبول 18 و20 و22 أُثبت بدالة الإصدار لا بتشغيل تلك النسخ. غير ذلك يفشل الفحص والسبب يبدأ بـ `NODE_VERSION`.

`--app-dir` هو مجلد التطبيق الذي يُقرأ `HEAD` منه. `--env-file` مساره للقراءة فقط. الدليل يُكتب داخل `financial-safety-check` لا داخل مجلد التطبيق. SHA المطلوب تلصقه أنت. هذا الملف لا يضع SHA إنتاج.

Redis الافتراضي: `PING` و`INFO server` وبناء Redlock دون حجز. `--redis-lock-probe` اختياري ويكتب مفتاحًا لخمس ثوانٍ؛ لا تستخدمه في هذا الفحص.

### Staging

```powershell
Set-Location 'C:\Users\Administrator\Desktop\financial-safety-check'; node scripts/financialSafetyReadOnlyCheck.js --env staging --required-sha PASTE_REQUIRED_SHA --env-file 'C:\Users\Administrator\Desktop\vodafone-cash-v2-staging\.env' --app-dir 'C:\Users\Administrator\Desktop\vodafone-cash-v2-staging' --base-url http://127.0.0.1:3000
```

### Production

```powershell
Set-Location 'C:\Users\Administrator\Desktop\financial-safety-check'; node scripts/financialSafetyReadOnlyCheck.js --env production --required-sha PASTE_REQUIRED_SHA --env-file 'C:\Users\Administrator\Desktop\vodafone-cash-v2\.env' --app-dir 'C:\Users\Administrator\Desktop\vodafone-cash-v2' --base-url http://127.0.0.1:3000
```

لا يُستخدم اسم المتغير `$pid`. إذا كان منفذ Staging غير 3000 فغيّر `--base-url` فقط. كل سطر كامل.

المخرج: `CHECK <name> PASS` أو `CHECK <name> FAIL <reason>` ثم `RESULT`. الأسرار تُحجب إلى `mongodb://***@host`. الملف `financial-safety-check\evidence\financial-safety\YYYYMMDD-HHmmss-<env>-summary.json` بلا معرفات حسابات. لا تُنشأ قيمته من هنا.

`git-sha` يمرر `git -C <app-dir>`. فشل `--app-dir` قبل أي قاعدة حتى لا يُقرأ SHA نسخة الفحص.

التعبئة الجافة لا تكتب (`modified` يبقى 0، و`--apply` مرفوض). في `TENANT_MODE=single`، أو إذا غاب المتغير فيُعامل كالافتراضي `single` ويُذكر `tenantModeSource=unset-default-single`: الصف بلا منظمة وغير المتعارض يُعد `legacy_single_tenant_assignable` ولا يوقف. `ambiguous` (مصادر متعارضة) يوقف دائمًا. `legacy` يوقف فقط عندما `TENANT_MODE=multi`.

المطابقة تفشل عند أي فرق. الدليل يصنّف بلا أسماء: `opening_balance_no_ledger` رصيد غير صفري بلا أي قيد (رأس مال افتتاح)، و`other` قيد موجود والمجموع لا يطابق الرصيد. لكل صنف `count` و`signedGapTotal` و`absoluteGapTotal`. عدم توازن تحويل `BTR-` يفشل أيضًا ويُعرض كعدّ وصافي مطلق بلا معرف. التصنيف يشرح الدليل ولا يلغي الإيقاف. drift مجموعة الاختبار الذي طرح رأس المال الافتتاحي لا يُستعمل هنا.

## إيقاف فوري

أوقف أي طرح إذا ظهر أي بند. لم يُقاس على Staging ولا Production:

- أي فرق بين رصيد ومجموع القيود، سواء صُنّف افتتاحًا بلا قيد أو فجوة أخرى (`reconciliation` = FAIL).
- أي `ambiguous` أكبر من صفر.
- أي `legacy` أكبر من صفر عندما `TENANT_MODE=multi`. في `single` لا يوقف `legacy_single_tenant_assignable`.
- MongoDB ليس replica set.
- Redis أو Redlock غير جاهز بفحص القراءة (`PING` وبناء Redlock). لا يُشترط مسبار الكتابة.
- فشل `/health/ready`.
- SHA مجلد `--app-dir` يختلف عن SHA المطلوب، أو شجرة ذلك المجلد ليست نظيفة.
- إصدار Node ليس 18 ولا 20 ولا 22 (`NODE_VERSION`).

## الإلغاء والأعلام مطفأة

مقارنة الفرق مع `527c7821`: مسار الإلغاء لا يغيّر مبلغ الرد ولا رفض الإلغاء الثاني. الرصيد يتحرك بنفس `costLYD`. العمليات الملغاة سابقًا لا تُعاد كتابتها. التقارير التي تجمع القيود بلا `tenantId` تبقى كما هي. القيد الجديد قد يحمل `tenantId` إذا كانت العملية الأصلية تحمله. التفصيل في جدول `07-active-without-flags.md`.

## طرح ورجوع وتحقق لاحق

لا يُنفَّذ الآن. الخطة في `docs/financial-safety/04-deployment-rollback.md`. الأعلام تبقى مطفأة، ولا فهرس، ولا `--apply`.

التحقق بعد قرار نشر لاحق قراءة فقط، من مجلد التطبيق، بلا إعادة تشغيل. لا يُستخدم `$pid`:

```powershell
Set-Location 'C:\Users\Administrator\Desktop\vodafone-cash-v2'; Invoke-RestMethod http://127.0.0.1:3000/health; Invoke-RestMethod http://127.0.0.1:3000/health/ready; $core = pm2 jlist | ConvertFrom-Json | Where-Object { $_.name -eq 'Ahram_Core_API' } | Select-Object -First 1; $coreProcessId = $core.pid; $listen = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; $listenProcessId = $listen.OwningProcess; Write-Output ('pm2=' + $coreProcessId + ' listen=' + $listenProcessId + ' match=' + ($coreProcessId -eq $listenProcessId))
```

مطابقة الرصيد بعد ذلك هي أمر الفحص في النسخة المنفصلة، لا أمرًا داخل مجلد الإنتاج. الرجوع الموصوف في `04-deployment-rollback.md` يستخدم `git revert` ثم إعادة تشغيل لاحقة؛ تلك الإعادة ليست جزءًا من أوامر هذا الفحص ولا تُشغَّل الآن.

## قائمة الملفات

| الملف | سطر |
| --- | --- |
| `app.js` | حقول أعلام للعرض في `/health/ready` دون تغيير شرط الجاهزية |
| `controllers/clientTransactionController.js` | ختم ومنع تكرار وقفل محفظة خلف أعلام مطفأة |
| `models/AccountCode.js` | `tenantId` اختياري وفهرس غير فريد |
| `models/AuditLog.js` | `tenantId` خارج الهاش، وإلحاق في الإنتاج |
| `services/financialSafety.js` | الأعلام، وعزل المنظمة بلا أثر في `single` |
| `services/accountCodeService.js` | حصر البحث فقط إذا كان الحارس فعالًا في `multi` |
| `services/balanceTransferService.js` | تحويل الرصيد خلف الأعلام |
| `services/auditService.js` | حجب أسرار أوسع و`tenantId` خارج الهاش |
| `services/lockService.js` | بديل الذاكرة حتى لا يرفض المسار الجديد عند غياب Redis |
| `services/mobileWebParityService.js` | تمرير الطلب دون قفل مزدوج لمسار الموبايل |
| `routes/mobileApi.js` | خريطة أخطاء تحويل الرصيد فقط |
| `src/Application/Services/TransferService.ts` | ختم `tenantId` وحارس فقط إذا كان العلم فعالًا |
| `src/Application/Services/ReversalService.ts` | نسخ `tenantId` الاختياري إلى قيد العكس، بلا تغيير لمبلغ الرد |
| `public/js/client-workspace.js` | إرسال `Idempotency-Key` بلا أثر حتى يُشغَّل العلم |
| `views/client/dashboard.ejs` | نفس الترويسة |
| `views/client/partials/company_portal_scripts.ejs` | نفس الترويسة |
| `scripts/backfillFinancialTenantId.js` | تعبئة جافة افتراضيًا ولا تكتب رصيدًا |
| `scripts/prepareAccountCodeTenantIndex.js` | فحص تكرار فقط إلا مع `--apply` والعلم |
| `scripts/financialSafetyReadOnlyCheck.js` | فحص قراءة من نسخة منفصلة، و`--app-dir` لـ SHA التطبيق |
| `scripts/measureReviewDatastores.js` | قياس MongoDB وRedis في بيئة المراجعة فقط |
| `scripts/migrateTenantIsolation.js` | تحذير بعدم استخدامه على الدفتر أو التدقيق |
| `package.json` | سكربتا التعبئة والفحص، و`mongodb-memory-server` للاختبار |
| `package-lock.json` | قفل الاعتمادات |
| `tests/financialTenantSafety.test.js` | عزل وذرية ومطابقة وأعلام مطفأة |
| `tests/financialRecordImmutability.test.js` | منع تعديل وحذف `AuditLog` في الإنتاج |
| `tests/financialSafetyReadOnlyCheck.test.js` | حجب الأسرار و`--app-dir` وتصنيف الفجوات والمنظمة |
| `docs/financial-safety/*` | المراجعة العربية وهذا التقرير ونواتج القاعدة المقلَّدة |
