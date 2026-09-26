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
| الإلغاء مرتين لا يرد المبلغ مرتين | نفس الملف |
| مطابقة مجموعة الاختبار: drift = 0 بعد طرح رأس المال الافتتاحي 1297. هذا ليس مساواة مطلقة بين الرصيد ومجموع القيود، ولا يُنقل إلى Production | `docs/financial-safety/reconciliation-test.json` |
| التعبئة الجافة على القاعدة المقلَّدة: Transaction 1/1/1 وLedger 1/1/0 وJournalEvent 0/0/1 وAuditLog 1/0/1 (determined / ambiguous / legacy) و`modified=0`. الفهرس لم يُنشأ | `migration-dry-run-report.json` و`account-code-index-scan.json` |
| `deleteMany` و`updateMany` على `AuditLog` يرميان في الإنتاج | `tests/financialRecordImmutability.test.js` |
| سكربت الفحص يرفض `--apply` قبل أي قاعدة، ويحجب `user:secret@` إلى `***@` | `tests/financialSafetyReadOnlyCheck.test.js` (3 اختبارات) |
| الاختباران الفاشلان موجودان على `527c7821` بلا تعديل للملفين: تسجيل دخول المنفذ 500 بدل 200، وT014/T015 يتجاوز 5000ms | `tests/mobileConsolidation.test.js` و`tests/mobileAuthContract.test.js` |

`npx jest --forceExit --runInBand` في هذه الجولة: 185 مجموعة (183 ناجحة، 2 فاشلة)، 1151 اختبارًا (1149 ناجحة، 2 فاشلة). الفشلان هما الاختباران السابقان على `main` فقط. لا تُستنتج من ذلك حالة Windows.

## 2. Proven on a real MongoDB Replica Set and Redis

القياس في بيئة المراجعة بتاريخ 2026-09-26. الملف `docs/financial-safety/review-environment-measurement.json`. `stagingMeasured=false` و`productionMeasured=false`.

| المكوّن | الإصدار المقاس |
| --- | --- |
| Node.js | v22.14.0 |
| MongoDB | 7.0.14 عبر `mongodb-memory-server` 10.1.4، عضو واحد، `wiredTiger` |
| replica set | `setNamePresent=true` و`transactionsCapable=true` و`msg` فارغ |
| Redis | 7.0.15 على `127.0.0.1:6399`، `PING` = `PONG` |
| Redlock | الحزمة `v5.0.0-beta.2`. حجز المفتاح `locks:financial-safety-readonly-probe` ثم تحريره نجح |

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
| تعبئة `tenantId` الجافة: determined / legacy / ambiguous | | |
| تكرار `account code` بلا إنشاء فهرس | | |
| مسار كتابة `AuditLog` | | |

### شروط التشغيل

- مجلد Production: `C:\Users\Administrator\Desktop\vodafone-cash-v2`
- مجلد Staging: `C:\Users\Administrator\Desktop\vodafone-cash-v2-staging` (شجرة أو نسخة بيئة منفصلة، لا ملف إنتاج)
- Node: الإصدار الرئيسي 22. المراجعة استخدمت v22.14.0. الفحص يفشل إذا لم يكن `v22`.
- الصلاحيات: قراءة مجلد التطبيق، و`GET` محلي لـ `/health`، ومستخدم Mongo للقراءة وأمر `hello`. لا يُشترط Administrator.
- SHA المطلوب: انسخه أنت من الالتزام الذي تريد أن يطابقه الخادم. هذا الملف لا يضع SHA إنتاج.

الكتابة الوحيدة خارج Mongo هي مفتاح Redis `locks:financial-safety-readonly-probe` لخمس ثوانٍ ثم يُحرَّر. ليس رصيدًا ولا قيدًا ولا فهرسًا.

### Staging

```powershell
Set-Location 'C:\Users\Administrator\Desktop\vodafone-cash-v2-staging'; node scripts/financialSafetyReadOnlyCheck.js --env staging --required-sha PASTE_REQUIRED_SHA --env-file .env --base-url http://127.0.0.1:3000
```

### Production

```powershell
Set-Location 'C:\Users\Administrator\Desktop\vodafone-cash-v2'; node scripts/financialSafetyReadOnlyCheck.js --env production --required-sha PASTE_REQUIRED_SHA --env-file .env --base-url http://127.0.0.1:3000
```

كل سطر كامل وقابل للصق. لا يُستخدم اسم المتغير `$pid`. استبدل `PASTE_REQUIRED_SHA` بالتزام من 40 خانة. إذا كان منفذ Staging غير 3000 فغيّر `--base-url` فقط.

المخرج لكل فحص: `CHECK <name> PASS` أو `CHECK <name> FAIL <reason>`. ثم `RESULT PASS` أو `RESULT FAIL`. السبب لا يحتوي كلمة السر ولا سلسلة الاتصال؛ الشكل `mongodb://***@host`.

الملف: `evidence\financial-safety\YYYYMMDD-HHmmss-<env>-summary.json`. فيه النتائج والعدّات بلا عينات حسابات وبلا أسرار. لا تُنشأ قيمة هذا الملف من هنا.

معاني العدّ في التعبئة الجافة: `determined` = واثق، `legacy` = بلا منظمة يمكن استنتاجها، `ambiguous` = مصادر متعارضة. `modified` يجب أن يبقى 0 لأن الأمر لا يمرر `--apply`. `--apply` مرفوض ويخرج فورًا بالرمز 2.

مطابقة الرصيد: `entityGaps` هو عدد حسابات `User` و`ClientCompany` و`SubAccount` التي لا يساوي رصيدها مجموع قيودها. أي فرق يفشل الفحص، بما في ذلك رصيد افتتاح بلا قيد. هذا متعمد في قائمة الإيقاف، وهو أضيق من drift مجموعة الاختبار الذي طرح رأس المال الافتتاحي.

## إيقاف فوري

أوقف أي طرح إذا ظهر أي بند:

- أي فرق بين رصيد وحساب القيود (`reconciliation` = FAIL).
- أي سجل بلا منظمة لا يمكن تحديدها (`legacy` أو `ambiguous` أكبر من صفر).
- MongoDB ليس replica set (`mongo-replica` = FAIL).
- Redis أو Redlock غير جاهز (`redis-redlock` = FAIL).
- فشل الجاهزية (`health-ready` = FAIL).
- SHA الخادم يختلف عن SHA المطلوب (`git-sha` = FAIL)، أو شجرة العمل ليست نظيفة.

هذه القائمة لا تعني أن البنود ظهرت. لم تُقاس على Staging ولا Production.
