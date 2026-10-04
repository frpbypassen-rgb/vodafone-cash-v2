# عقود بوابة المنفذ المالية (السلوك الحالي)

هذا الوصف يثبت سلوك المسارات كما هي اليوم في `routes/executorPortal.js` و`controllers/executorTransactionController.js`. ليس وصفًا للسلوك المطلوب بعد أي إعادة تصميم.

البادئة: `/executor-portal`. كل المسارات أدناه `POST`. الحماية: جلسة منفذ (`isExecutorLoggedIn` + `executorId`) ثم `requireExecutorTaskAccess` (يرفض دور `accountant`). رمز CSRF إلزامي في `x-csrf-token` أو `_csrf`، وإلا `403` والنص `Invalid CSRF token`، ومن دون أي أثر مالي.

لا تستخدم هذه المسارات مفتاح idempotency المخزّن على `Transaction` (`idempotencyKey` / `editIdempotencyKey` / `zaynpayIdempotencyKey`). لا يُمرَّر `tenantId` إلى خدمات القبول أو الإنهاء، فالعزل الفعلي هو مجموعة المنفذ وملكية `operatorId` فقط.

مجموعة `Ledger` لا تُكتب من هذه المسارات. أثر الرصيد يكون على `User` / `ClientCompany` (تعديل وإلغاء) أو على `ExecutorGroup.balance` و`serviceBalances` (إنهاء يدوي أو ZaynPay).

## قبول المهمة

- المسار: `/api/accept-task/:id`
- الدور: `operator` أو `external` أو `manager`. المدير يُرفض بـ `400` والكود `ROUTING_REQUIRED` عندما `manualTaskRoutingEnabled` مفعّل.
- الجسم: فارغ.
- النجاح: `200` `{ success: true, replayed: boolean }`. لا يتغير مبلغ العملية ولا رصيد العميل ولا رصيد المجموعة ولا `Ledger`.
- الانتقال: `processing` أو `pending` → `accepted`، مع ضبط `operatorId` و`executorName` و`assignedExecutorId` و`assignedExecutorName`.
- إعادة نفس المنفذ بعد النجاح: `replayed: true` ومن دون حدث قبول ثانٍ.
- منفذ آخر بعد القبول: `409` والكود `TASK_TAKEN`.
- مهمة مجموعة أخرى: `409` والكود `TASK_GROUP_MISMATCH`.
- مهمة مستأجر آخر ضمن نفس المجموعة: تُقبل. المسار لا يقارن `tenantId`.
- منفذ لديه مهمة `accepted` أخرى: `409` والكود `ACTIVE_TASK_EXISTS`، والمهمة الجديدة تبقى كما هي.
- القفل على المنفذ لا على المهمة. طلبان متزامنان من نفس المنفذ: أحدهما ينجح والآخر `500` إذا كان القفل ما زال محجوزًا (`تعذر سحب العملية.`). طلبان من منفذين مختلفين: تحديث Mongo الذري يترك مالكًا واحدًا.
- الحدث: `executor:task-accepted` عند القبول الأول فقط. لا إشعار محفظة ولا قيد دفتر.

## تعديل المبلغ

- المسار: `/api/edit-amount/:id`
- الجسم: `newAmount` (رقم أكبر من صفر)، `reason` (يُسجَّل في الملاحظة فقط).
- الشرط: `status === accepted` و`operatorId` يساوي معرف الموظف في الجلسة. لا فحص مجموعة ولا مستأجر.
- السعر: `exchangeRate`، أو يُشتق من `costLYD / amount` (أو العكس لسعر `source_to_lyd` مثل سيفا). ثم `calculateTransferCostLYD`.
- مثال ثابت (فودافون، اتجاه `lyd_to_source`): مبلغ `1000`، سعر `50`، تكلفة `20`، عمولة مخزّنة `1.5` لا تُعاد حسابها.
  - رفع المبلغ إلى `2500` يجعل التكلفة `50` ويخصم `30` من رصيد `User` أو `ClientCompany`.
  - خفض المبلغ إلى `500` يجعل التكلفة `10` ويعيد `10`.
- سيفا (`source_to_lyd`): التكلفة = المبلغ × السعر. من `100` بسعر `0.25` (تكلفة `25`) إلى `40` (تكلفة `10`) يُعاد `15`.
- حد الائتمان في شرط الخصم: `balance >= diffCost - creditLimit`. مثال شركة: رصيد `5` وحد `10` وفرق `12` ينجح ويصبح الرصيد `-7`.
- النجاح: `200` `{ success: true, newAmount }`. الحالة تبقى `accepted`. لا صف `Ledger` ولا `AuditLog`.
- فشل الرصيد: `200` `{ success: false, error: 'رصيد العميل لا يكفي لتغطية الزيادة' }` ومن دون تغيير.
- مبلغ غير صالح أو سعر متعذر: `200` و`success: false` ومن دون تغيير.
- نفس المبلغ مرة ثانية: الفرق صفر، لا حركة رصيد، وتُضاف ملاحظة إدارية مرة أخرى.
- لا قفل ولا معاملة Mongo. تعديلان متزامنان يقرآن التكلفة القديمة ويخصمان الفرق مرتين. فشل `save` بعد الخصم يُبقي الرصيد متغيرًا والمبلغ القديم، والرد `200` مع `success: false`.
- تمويل متزامن بـ `$inc` يُجمع مع فرق التعديل؛ التحديثان ذرّيان على حقل الرصيد.
- منفذ آخر أو مهمة غير مقبولة: `200` `{ success: false, error: 'العملية غير صالحة أو لا تملك صلاحية تعديلها' }`.

## إلغاء المهمة

- المسار: `/api/cancel-task/:id`
- الجسم: `reason` نص غير فارغ. غيابه: `400` `{ success: false, error: 'سبب الإلغاء مطلوب.' }`.
- حجز نتيجة المزود (`refundBlockedByUnresolvedProvider`) يعيد `409` والكود `PROVIDER_RESULT_UNRESOLVED` والنص الذي يطلب مراجعة يدوية. لا استرجاع ولا إعادة إرسال ولا إيصال. ينطبق على:
  - `apiResultData.providerResultUnresolved === true`
  - `providerDispatchResult === pending_reference`
  - وجود علامة إرسال (`providerDispatchStartedAt` أو `providerDispatchAttemptId`) من دون نتيجة محسومة
- `providerDispatchResult === accepted` أو `rejected` لا يمنع الإلغاء. نتيجة `accepted` ما زالت تسمح باسترجاع `costLYD`.
- النجاح يشترط `accepted` ومطابقة `operatorId`.
- الأثر: `status = rejected` (وليس `cancelled`)، تعبئة سبب الإلغاء والمنفّذ والوقت، وإضافة `costLYD` إلى رصيد الشركة إن وُجد `companyId` وإلا إلى `User` المطابق لـ `phone` أو `webUsername`. لا صف `Ledger`. لا حدث `transfer:cancelled`، لذلك لا يُكتب `AgencyJournal` من نوع `TRANSFER_REVERSED`.
- مثال: رصيد `500` وتكلفة `20` يصبح الرصيد `520`. العمولة والسعر والمبلغ لا تتغير.
- afterward: إيصال إلغاء محلي (`*_cancellation_receipt.jpg`) ثم `sendCancelledTransactionReceipt` مرة واحدة، وإشعار `Notification` لكل مدير (غير منتظَر في الرد).
- إلغاء ثانٍ: `200` `{ success: false, error: 'العملية غير صالحة' }` ومن دون استرجاع ثانٍ.
- طلبان متزامنان يمران من فحص الحالة قبل الحفظ: كل واحد ينفّذ `$inc`، فيُسترجع المبلغ مرتين. فشل `save` بعد `$inc` يُبقي الاسترجاع والحالة `accepted`، والرد `200`.
- حساب فرعي (`isSubAccountTx`): الرصيد المُعاد هو رصيد المستخدم/الشركة بقيمة `costLYD`، ورصيد `SubAccount` لا يتغير.
- منفّذ آخر: لا استرجاع.

## إرجاع المهمة للإدارة

- المسار: `/api/return-task/:id`
- نفس حجز المزود أعلاه (`409` ومن دون تغيير رصيد).
- النجاح: الحالة تعود إلى `pending` وتُمسح حقول التعيين والمجموعة. لا استرجاع رصيد ولا دفتر ولا إيصال. الرد `200` `{ success: true }`.

## إنهاء يدوي

- المسار: `/api/complete-task/:id`
- الجسم المعتاد: `executionNumber` من 11 رقمًا أو آخر 3 أو 4 أرقام (`2258` تُخزَّن مقنّعة `01*****2258`). الصور اختيارية ما لم تُفرض سياسة الإثبات.
- القفل: `executor-complete:{id}`. الطلب المتداخل يحصل على `409` `{ success: false, error: 'العملية قيد المعالجة حالياً.' }` أو، بعد انتهاء الأول، `409` `{ success: false, error: 'العملية غير متاحة للإنهاء أو تم إنهاؤها مسبقاً.' }`.
- الملكية: `findOwnedAcceptedExecutorTask` (مجموعة المنفذ + `operatorId` أو `assignedExecutorId`). لا فلتر مستأجر من البوابة.
- النجاح: `200` `{ success: true, message: 'تم إنهاء العملية وحفظ الإيصال بنجاح.' }`.
- الانتقال: `accepted` → `completed`. يُحفظ إيصال نظامي واحد في `proofImages` ومرجع `manualExecutorReceiptReference` بالشكل `{prefix}{sequence}` (البادئة `321` تعطي `321001` ثم تتزايد). صور المنفذ تذهب إلى `executorProofImages` ولا تستبدل إيصال النظام.
- رصيد العميل لا يتغير في الإنهاء. `commission` و`exchangeRate` و`costLYD` تبقى. لا صف `Ledger`.
- رصيد المجموعة يُعاد حسابه في `syncBotBalance` من عمليات `completed` و`deposit` و`deduction` (يُستبعد `external_balance`): الإيداع يجمع والمكتمل يطرح **مبلغ العملية بعملة المصدر** لا التكلفة بالدينار. مجموعة رصيدها الابتدائي لا يُحفظ؛ الناتج يستبدل `balance` و`serviceBalances`.
  - إيداع فودافون `5000` ثم إكمال `1000`: `balance` و`serviceBalances.vodafone` يصبحان `4000`.
  - المجموعة الأب تُزامن أيضًا. إن لم تكن لها عمليات مطابقة يصبح رصيدها `0` حتى لو كان أعلى قبل الإنهاء.
  - `bank_account` يُطرح من مفتاح `bank_account` لا من رصيد فودافون الأساسي. `bank_transfer` ليس مفتاح خدمة معروفًا فيُحسب على فودافون.
- التحويل البنكي (`bank_account` / `bank_transfer`): إثبات الصورة إجباري (`400` بالنص `إرفاق صورة إثبات التحويل البنكي إجباري.`). لا مرجع إيصال يدوي. الصورة المرفوعة هي `proofImages[0]`. الرسالة: `تم إنهاء التحويل البنكي وإرسال إثبات التحويل للعميل.`
- بعد الحفظ: `AuditLog` بإجراء `TRANSFER_COMPLETED` (قديم `accepted`، جديد `completed`). الحدث `transfer:completed` مرة واحدة، ومنه إشعار داخلي بمفتاح `{customId}:{userId}:transfer_complete` واستدعاء إرسال إيصال واتساب مرة واحدة (المزوّد موقوف في الاختبار).
- إن كانت العملية حسابًا فرعيًا: يُضاف `AgencyJournal` حدث `TRANSFER_REALIZED` ببنود فارغة، ومن دون حركة رصيد للحساب الفرعي. لا يُنشأ هذا القيد عند الإلغاء لأن مسار البوابة لا ينشر `transfer:cancelled`.
- فشل الحفظ بعد توليد الإيصال: تُحذف ملفات الإثبات، وتبقى الحالة `accepted`، ولا يتغير رصيد المجموعة، لكن عدّاد مرجع الإيصال يكون قد زاد. الرد `500` `{ success: false, error: 'تعذر إنهاء العملية.' }`.
- إثبات غير صالح: `400`. أكثر من 5 صور: `400` والنص `الحد الأقصى 5 صور.`

## تنفيذ ZaynPay

- المسار: `/api/zaynpay-execute/:id`
- إذا `EXTERNAL_API_ENABLED` مطفأ: `200` `{ success: false, code: 'API_EXECUTION_UNAVAILABLE', error: 'تنفيذ ZaynPay متوقف. لم يُرسل الطلب إلى المزود ولم يتغير الرصيد.' }` ومن دون استدعاء المزود.
- وإلا يجب أن يكون `webUsername` للجلسة هو `zaynapi@ahram.com`. غير ذلك: `{ success: false, error: 'غير مصرح لك باستخدام بوابة ZaynPay' }`.
- الملكية قبل أي مطالبة أو اتصال بالمزود: `executorGroupId` يجب أن يساوي مجموعة الموظف (نفس كود قبول البوابة `TASK_GROUP_MISMATCH` وحالة `409`). انتماء `managerGroupId` وحده لا يكفي. إذا كان `tenantId` مضبوطًا على الموظف والعملية معًا ويختلفان: `409` والكود `TASK_TENANT_MISMATCH`. الطلب المرفوض لا يستدعي المزود ولا يغيّر رصيدًا ولا معاملة ولا دفترًا.
- الحالة القابلة للتنفيذ: `accepted` أو `processing`. المكتمل مسبقًا: `{ success: false, error: 'الطلب مكتمل مسبقاً' }` ومن دون خصم ثانٍ.
- مطالبة إرسال ذرّية (`claimProviderDispatch`) قبل `inquiry` و`pay`. الفائز وحده يتصل بالمزود. الخاسر: `409` والكود `PROVIDER_DISPATCH_IN_PROGRESS` ومن دون خصم.
- فشل دفع محسوم من المزود يحرر المطالبة ويبقي الحالة والرصيد. مهلة أو نتيجة غير معروفة: `pending_reference` مع `providerResultUnresolved`، بلا استرجاع وبلا إعادة إرسال، والرد `409` والكود `PROVIDER_RESULT_UNRESOLVED`.
- بعد نجاح المزود: خصم المجموعة (والأب إن وُجد) وإكمال العملية في معاملة Mongo واحدة. الرصيد عبر `$inc` بقيمة `-amount` على `balance` و`serviceBalances.{service}` لمجموعة المهمة، وهي مجموعة الموظف بعد فحص الملكية، وليس إعادة حساب `syncBotBalance`.
  - رصيد مجموعة `5000` من دون `serviceBalances` ومبلغ `1000`: يصبح `balance = 4000` و`serviceBalances.vodafone = -1000`.
- إذا فشل الحفظ بعد نجاح المزود: تُسجَّل مرجعية المزود وتبقى المطالبة، فلا تُعاد الدفعة عند إعادة المحاولة، ويُرجع `500` والكود `ZAYNPAY_COMPLETION_UNCONFIRMED` من دون نص الخطأ الداخلي. الرصيد لا يتغير لأن المعاملة تُلغى.
- النجاح: `200` `{ success: true, transactionNumber }` من رد المزود. الحالة `completed`. ملف الإثبات `{customId}_zaynpay.jpg`.
- لا `AuditLog` ولا `transfer:completed` ولا إشعار إكمال ولا دفتر `Ledger`.

## ما يرفضه الوسطاء قبل أي أثر

| الحالة | الحالة HTTP | الجسم |
| --- | --- | --- |
| بلا جلسة | 401 | `success: false` ونص انتهاء الجلسة كما هو مخزّن في `routes/executorPortal.js` |
| دور `accountant` | 403 | `success: false` ونص انعدام صلاحية التنفيذ كما هو مخزّن في الملف نفسه |
| CSRF ناقص أو مختلف | 403 | `{ success: false, error: 'Invalid CSRF token' }` |

رسائل 401/403 في ملف المسار مخزّنة اليوم بنص مشوّه (UTF-8 قُرئ كـ Windows-1256 ثم أُعيد حفظه). الاختبار يثبت النص الفعلي للرد، لا الترجمة المقصودة.
