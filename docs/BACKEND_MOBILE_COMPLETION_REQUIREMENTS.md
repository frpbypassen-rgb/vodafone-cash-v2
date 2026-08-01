# متطلبات استكمال Mobile API لتطبيق Flutter

هذا المستند موجه لفريق/موديل الباك إند لاستكمال ما ينقص تطبيق Flutter فقط. الهدف ليس إعادة بناء ما تم إنجازه، بل تثبيت العقد النهائي للواجهات غير الواضحة أو غير المكشوفة للموبايل حتى يتم ربط التطبيق بالكامل دون تخمين أو تعطيل.

## 1. النطاق والهدف

### 1.1 الهدف

تطبيق Flutter يحتاج عقد Mobile API كامل وواضح لكل شاشة أو صلاحية تظهر داخل التطبيق، مع الحفاظ على المسارات الموجودة حالياً وعدم كسرها.

المطلوب من الباك إند:

- توضيح الموجود فعلاً كموبايل API.
- استكمال غير الموجود تحت `/api/mobile`.
- عدم مطالبة Flutter باستخدام Web routes.
- عدم ترك Flutter يخمن الأدوار أو الصلاحيات.
- توفير حسابات Staging تغطي كل شخصية مدعومة فعلياً.
- تقديم request/response نهائي لكل Endpoint.

### 1.2 خارج النطاق

فريق Flutter لا يطلب:

- تعديل صفحات الويب.
- تغيير لوحة الإدارة إلا إذا كان ذلك ضرورياً لدعم Mobile API.
- نقل منطق مالي إلى Flutter.
- حساب أرصدة أو خصومات أو صلاحيات داخل Flutter.
- التعامل مع قواعد بيانات مباشرة.
- استخدام Web session routes بدلاً من JWT Mobile API.

## 2. الموجود حالياً ولا نطلب إعادة تنفيذه

تمت مراجعة الكود الحالي، وهذه الأجزاء موجودة بوضوح ويجب الحفاظ عليها كما هي، مع السماح بإضافات متوافقة فقط.

### 2.1 Prefixes

- `/api/mobile`
- `/api/v1/mobile`

### 2.2 Auth

- `POST /login`
- `POST /refresh-token`
- `POST /logout`

### 2.3 Registration

- `POST /client/register/direct`
- `POST /client/register/new`
- `POST /client/register/company`
- `POST /client/register/agent`

### 2.4 Client

- `GET /client/home`
- `POST /client/exchange-rate`
- `POST /client/new-transfer`
- `GET /client/transactions`
- `GET /client/transactions/:id`

### 2.5 Executor

- `GET /executor/live-tasks`
- `POST /executor/accept-task/:id`
- `POST /executor/cancel-task/:id`
- `POST /executor/complete-task/:id`

### 2.6 Media / Receipts

- `GET /transaction/image/:id`
- `GET /transaction/image/content`

### 2.7 Support Tickets

- `POST /client/tickets`
- `GET /client/tickets`
- `GET /client/tickets/:id`
- `POST /client/tickets/:id/reply`

### 2.8 KYC

- `POST /client/kyc/submit`
- `GET /client/kyc/status`

## 3. قواعد عامة ملزمة لكل Mobile API

### 3.1 لا Web Routes للموبايل

أي وظيفة يستخدمها تطبيق Flutter يجب أن تكون تحت:

```text
/api/mobile/...
```

أو:

```text
/api/v1/mobile/...
```

ممنوع أن يعتمد Flutter على:

- `/client/...` web portal
- `/executor-portal/...`
- `/reports`
- `/settings`
- أي route يعتمد على session/cookies بدلاً من JWT

### 3.2 التوافق الخلفي

ممنوع كسر هذه المسارات الحالية أو تغيير أسماء حقولها بدون توافق:

- `POST /login`
- `POST /refresh-token`
- `POST /logout`
- `GET /client/home`
- `POST /client/new-transfer`
- `GET /client/transactions`
- `GET /client/transactions/:id`
- `GET /executor/live-tasks`
- `POST /executor/accept-task/:id`
- `POST /executor/cancel-task/:id`
- `POST /executor/complete-task/:id`
- `POST /client/tickets`
- `GET /client/tickets`
- `GET /client/tickets/:id`
- `POST /client/tickets/:id/reply`

لو هناك حاجة لإضافة حقول جديدة، تتم إضافتها بدون إزالة الحقول القديمة.

### 3.3 Envelope موحد للأخطاء

كل الأخطاء يجب أن ترجع بهذا الشكل:

```json
{
  "success": false,
  "code": "ERROR_CODE",
  "message": "رسالة واضحة للمستخدم",
  "correlationId": "optional-correlation-id"
}
```

ممنوع إرجاع:

- Stack trace
- Mongoose raw error
- Validation object خام
- HTML error page
- Internal file paths

### 3.4 حماية البيانات الخام

كل Mobile response يجب ألا يحتوي على:

- `__v`
- `webPassword`
- `password`
- `refreshToken` خارج Auth response
- `telegramId` إلا لو مطلوب ومصرح به بعقد واضح
- `telegramToken`
- `botToken`
- `adminMessages`
- `proofImage` raw path
- `proofImages` raw paths
- `idempotencyFingerprint`
- `idempotencyResponse`
- أي ObjectId داخلي غير مخصص للعرض إلا إذا كان `id` آمن مطلوب للتنقل

### 3.5 الصلاحيات لا تحدد من Flutter

Flutter لا يقرر صلاحيات المستخدم من نفسه. الباك إند يجب أن يعيد:

- الشخصية الفعلية.
- الدور.
- الصلاحيات.
- السياق.

Flutter يستخدم ذلك فقط للعرض والتوجيه، لكن الباك إند يظل مسؤولاً عن Enforcement.

### 3.6 العمليات المالية

أي Endpoint يغير مال أو رصيد أو حد ائتماني يجب أن يحتوي على:

- JWT auth.
- Authorization server-side.
- `Idempotency-Key` إجباري.
- Audit log.
- Ledger/double-entry أو نفس نظام القيد المالي المعتمد.
- Atomic transaction أو آلية lock آمنة.
- Response لا يحتوي على بيانات خام.

## 4. Login Contract النهائي المطلوب

### 4.1 المشكلة الحالية

الحالي يرجع غالباً:

```json
{
  "success": true,
  "token": "...",
  "refreshToken": "...",
  "expiresIn": 3600,
  "refreshExpiresIn": 2592000,
  "id": "...",
  "accountType": "client_user",
  "name": "Test User",
  "balance": 500,
  "exchangeRate": 6.5,
  "isOpen": true,
  "serverTime": "...",
  "context": {}
}
```

هذا يكفي للعميل البسيط والمنفذ، لكنه لا يكفي للشخصيات المتقدمة داخل التطبيق.

### 4.2 المطلوب إضافته بدون كسر القديم

يجب أن يظل `accountType` موجوداً كما هو، ويضاف عليه:

- `persona`
- `role`
- `permissions`
- `context` موسع حسب الشخصية

### 4.3 accountType المسموح

يظل `accountType` broad category:

```text
client_user
client_company
executor
```

ولا يتم استخدام `accountType` وحده لتحديد شاشة متقدمة.

### 4.4 persona المطلوب

حقل `persona` يجب أن يكون واحداً من:

```text
direct_client
agent_client
company_owner
company_employee
company_accountant
agent_owner
agent_employee
agent_accountant
executor
```

لو الباك إند يرفض اسم `persona`، يجب تقديم اسم بديل ثابت يؤدي نفس الغرض، مع توثيقه صراحة.

### 4.5 role المطلوب

حقل `role` يستخدم داخل نفس الشخصية:

```text
owner
employee
accountant
executor
client
```

ويجب توضيح العلاقة بين `persona` و`role`.

### 4.6 permissions المطلوبة

`permissions` يجب أن تكون مصفوفة Strings.

أمثلة مطلوبة:

```text
profile.read
profile.update
auth.logout
client.home.read
client.transfer.create
client.transactions.read
client.transactions.details.read
support.tickets.read
support.tickets.create
support.tickets.reply
company.dashboard.read
company.employees.read
company.employees.create
company.employees.update_status
company.employees.update_permissions
company.reports.read
company.reports.read_all
agent.dashboard.read
agent.join_requests.read
agent.join_requests.approve
agent.join_requests.reject
agent.clients.read
agent.clients.details.read
agent.clients.deposit
agent.clients.credit_limit.update
agent.reports.overview.read
agent.reports.personal.read
executor.tasks.read
executor.tasks.accept
executor.tasks.cancel
executor.tasks.complete
executor.receipts.upload
```

لا يشترط استخدام نفس الأسماء حرفياً إذا كان لديكم Naming Convention مختلف، لكن يجب تقديم قائمة نهائية ثابتة ومكتوبة.

### 4.7 context المطلوب حسب الشخصية

#### direct_client

```json
{
  "clientId": "safe-id",
  "accountCode": "optional",
  "agentId": null,
  "agentName": null,
  "clientCompanyId": null,
  "executorGroupId": null
}
```

#### agent_client

```json
{
  "clientId": "safe-id",
  "accountCode": "optional",
  "agentId": "safe-agent-id",
  "agentCode": "12345678",
  "agentName": "اسم الوكيل",
  "creditLimit": 0,
  "debt": 0
}
```

#### company_owner / company_employee / company_accountant

```json
{
  "clientCompanyId": "safe-company-id",
  "clientCompanyName": "اسم الشركة",
  "companyEmployeeId": "safe-employee-id",
  "canViewAllReports": true,
  "canManageEmployees": true
}
```

#### agent_owner / agent_employee / agent_accountant

```json
{
  "agentId": "safe-agent-id",
  "agentCode": "12345678",
  "agentName": "اسم الوكالة",
  "agentEmployeeId": "safe-employee-id-or-null",
  "canManageClients": true,
  "canApproveJoinRequests": true,
  "canViewOverviewReports": true
}
```

#### executor

```json
{
  "executorGroupId": "safe-group-id",
  "executorGroupName": "اسم مجموعة التنفيذ",
  "executorBotId": "legacy-compatible-id",
  "executorBotName": "legacy-compatible-name"
}
```

### 4.8 أمثلة Login Response مطلوبة من الباك إند

يجب تسليم أمثلة حقيقية لكل شخصية مدعومة:

- direct client
- agent client
- company owner
- company employee
- company accountant
- agent owner
- agent employee
- agent accountant
- executor

لو شخصية غير مدعومة حالياً، يجب كتابتها صراحة في الرد:

```text
agent_accountant: غير مدعومة حالياً / مؤجلة
```

## 5. Company Mobile API المطلوب

هذا الجزء لا يجب ربطه بـ Web routes. المطلوب Mobile endpoints رسمية.

### 5.1 GET /company/employees

الغرض: عرض موظفي الشركة لمالك الشركة أو من لديه صلاحية.

Method:

```text
GET /api/mobile/company/employees?page=1&limit=20&search=&status=
```

Allowed personas:

- `company_owner`

Optional:

- `company_accountant` للقراءة فقط إذا قرر الباك ذلك.

Response:

```json
{
  "success": true,
  "page": 1,
  "limit": 20,
  "total": 2,
  "totalPages": 1,
  "hasMore": false,
  "employees": [
    {
      "id": "safe-employee-id",
      "name": "اسم الموظف",
      "phone": "0912345678",
      "username": "employee_user",
      "role": "employee",
      "status": "active",
      "permissions": [
        "client.transfer.create",
        "client.transactions.read"
      ],
      "createdAt": "2026-06-15T00:00:00.000Z"
    }
  ]
}
```

ممنوع:

- إرجاع كلمة مرور.
- إرجاع hash.
- إرجاع refresh token.

### 5.2 POST /company/employees

الغرض: إنشاء موظف تابع للشركة.

Method:

```text
POST /api/mobile/company/employees
```

Headers:

```text
Authorization: Bearer <token>
Idempotency-Key: <uuid-v4>
Content-Type: application/json
```

Allowed personas:

- `company_owner`

Request:

```json
{
  "name": "اسم الموظف",
  "phone": "0912345678",
  "username": "employee_user",
  "password": "temporaryStrongPassword",
  "role": "employee",
  "permissions": [
    "client.transfer.create",
    "client.transactions.read"
  ]
}
```

Allowed roles:

```text
employee
accountant
```

Response:

```json
{
  "success": true,
  "message": "تم إنشاء الموظف بنجاح",
  "employee": {
    "id": "safe-employee-id",
    "name": "اسم الموظف",
    "phone": "0912345678",
    "username": "employee_user",
    "role": "employee",
    "status": "active",
    "permissions": [
      "client.transfer.create",
      "client.transactions.read"
    ]
  },
  "serverTime": "2026-06-15T00:00:00.000Z"
}
```

Security:

- كلمة المرور لا ترجع في response.
- يجب تشفير كلمة المرور في الباك.
- يجب منع username مكرر.
- يجب عمل Audit log.

### 5.3 PATCH/POST /company/employees/:id/status

الغرض: تفعيل/تعطيل موظف شركة.

Request:

```json
{
  "status": "active",
  "reason": "اختياري"
}
```

Allowed status:

```text
active
banned
suspended
```

Response:

```json
{
  "success": true,
  "employee": {
    "id": "safe-employee-id",
    "status": "active"
  }
}
```

### 5.4 PATCH/POST /company/employees/:id/permissions

الغرض: تعديل صلاحيات موظف الشركة.

Request:

```json
{
  "role": "accountant",
  "permissions": [
    "client.transactions.read",
    "company.reports.read_all"
  ]
}
```

Response:

```json
{
  "success": true,
  "employee": {
    "id": "safe-employee-id",
    "role": "accountant",
    "permissions": [
      "client.transactions.read",
      "company.reports.read_all"
    ]
  }
}
```

### 5.5 GET /company/reports

الغرض: تقارير الشركة.

Method:

```text
GET /api/mobile/company/reports?from=2026-06-01&to=2026-06-15&employeeId=&status=&page=1&limit=20
```

Allowed personas:

- `company_owner`: تقارير الشركة بالكامل.
- `company_accountant`: تقارير الشركة بالكامل للقراءة فقط.
- `company_employee`: تقارير اليوم الحالي فقط، إذا كان هذا هو منطق العمل المطلوب.

Response:

```json
{
  "success": true,
  "summary": {
    "totalTransactions": 20,
    "totalAmountEGP": 100000,
    "totalCostLYD": 15384.615,
    "completedCount": 15,
    "pendingCount": 5
  },
  "page": 1,
  "limit": 20,
  "total": 20,
  "totalPages": 1,
  "hasMore": false,
  "transactions": [
    {
      "id": "safe-transaction-id",
      "txId": "ATT-2606-0001",
      "employeeName": "اسم الموظف",
      "transferType": "vodafone",
      "status": "completed",
      "amount": 1000,
      "costLYD": 153.846,
      "exchangeRate": 6.5,
      "createdAt": "2026-06-15T00:00:00.000Z"
    }
  ]
}
```

## 6. Agent Mobile API المطلوب

هذا الجزء مطلوب لأن تطبيق Flutter يحتوي واجهات وكيل، لكن المسارات الرسمية للموبايل غير مثبتة حالياً بشكل كاف.

### 6.1 GET /agent/join-requests

الغرض: عرض طلبات العملاء الذين سجلوا كعميل جديد باستخدام كود الوكيل أو طلبوا الانضمام للوكالة.

Method:

```text
GET /api/mobile/agent/join-requests?page=1&limit=20&status=pending
```

Allowed personas:

- `agent_owner`

Optional:

- `agent_employee` إذا لديه صلاحية `agent.join_requests.read`.

Response:

```json
{
  "success": true,
  "page": 1,
  "limit": 20,
  "total": 3,
  "totalPages": 1,
  "hasMore": false,
  "requests": [
    {
      "id": "safe-request-id",
      "refCode": "REG-2606-123456",
      "fullName": "اسم العميل الثلاثي",
      "phone": "0912345678",
      "storeName": "اسم المحل",
      "address": "العنوان",
      "username": "client_user",
      "status": "pending",
      "createdAt": "2026-06-15T00:00:00.000Z"
    }
  ]
}
```

### 6.2 POST /agent/join-requests/:id/approve

الغرض: موافقة الوكيل على انضمام العميل للوكالة.

Headers:

```text
Authorization: Bearer <token>
Idempotency-Key: <uuid-v4>
```

Request:

```json
{
  "note": "اختياري"
}
```

Response:

```json
{
  "success": true,
  "message": "تم قبول طلب الانضمام",
  "client": {
    "id": "safe-client-id",
    "name": "اسم العميل",
    "phone": "0912345678",
    "status": "active",
    "creditLimit": 0,
    "debt": 0
  }
}
```

### 6.3 POST /agent/join-requests/:id/reject

Request:

```json
{
  "reason": "سبب الرفض"
}
```

Response:

```json
{
  "success": true,
  "message": "تم رفض طلب الانضمام"
}
```

### 6.4 GET /agent/clients

الغرض: عرض عملاء الوكيل.

Method:

```text
GET /api/mobile/agent/clients?page=1&limit=20&search=&status=
```

Response:

```json
{
  "success": true,
  "page": 1,
  "limit": 20,
  "total": 10,
  "totalPages": 1,
  "hasMore": false,
  "clients": [
    {
      "id": "safe-client-id",
      "name": "اسم العميل",
      "phone": "0912345678",
      "username": "client_user",
      "storeName": "اسم المحل",
      "status": "active",
      "balance": 100,
      "creditLimit": 500,
      "debt": 0,
      "lastActivityAt": "2026-06-15T00:00:00.000Z"
    }
  ]
}
```

### 6.5 GET /agent/clients/:id

الغرض: تفاصيل عميل تابع للوكيل.

Response:

```json
{
  "success": true,
  "client": {
    "id": "safe-client-id",
    "name": "اسم العميل",
    "phone": "0912345678",
    "username": "client_user",
    "storeName": "اسم المحل",
    "address": "العنوان",
    "status": "active",
    "balance": 100,
    "creditLimit": 500,
    "debt": 0,
    "createdAt": "2026-06-15T00:00:00.000Z"
  },
  "recentTransactions": [
    {
      "id": "safe-transaction-id",
      "txId": "ATT-2606-0001",
      "status": "completed",
      "amount": 1000,
      "costLYD": 153.846,
      "createdAt": "2026-06-15T00:00:00.000Z"
    }
  ]
}
```

### 6.6 POST /agent/clients/:id/deposit

الغرض: إيداع رصيد لعميل تابع للوكيل من رصيد الوكيل.

هذا Endpoint مالي ويجب أن يكون محمياً بقوة.

Headers:

```text
Authorization: Bearer <token>
Idempotency-Key: <uuid-v4>
```

Request:

```json
{
  "amountLYD": 100,
  "note": "تمويل حساب العميل"
}
```

Rules:

- المبلغ بالدينار الليبي إذا كان هذا هو مصدر الحقيقة الحالي.
- يجب خصم المبلغ من رصيد الوكيل.
- يجب زيادة رصيد العميل.
- يجب إنشاء Ledger entries للطرفين.
- يجب إنشاء Transaction/Journal واضح.
- يجب منع الرصيد السالب للوكيل إلا إذا كان ذلك مسموحاً بعقد واضح.

Response:

```json
{
  "success": true,
  "message": "تم الإيداع بنجاح",
  "txId": "ATT-2606-0002",
  "agentBalance": 900,
  "clientBalance": 200,
  "serverTime": "2026-06-15T00:00:00.000Z"
}
```

### 6.7 PATCH/POST /agent/clients/:id/credit-limit

الغرض: تحديد حد ائتماني بالسالب لعميل تابع للوكيل.

Headers:

```text
Authorization: Bearer <token>
Idempotency-Key: <uuid-v4>
```

Request:

```json
{
  "creditLimitLYD": 500,
  "note": "حد ائتماني للعميل"
}
```

Response:

```json
{
  "success": true,
  "client": {
    "id": "safe-client-id",
    "creditLimit": 500,
    "debt": 0
  }
}
```

Rules:

- Flutter لا يحسب المديونية.
- الباك هو مصدر الحقيقة.
- يجب توضيح هل `debt` موجب أم سالب في Response.
- يجب توضيح هل الحد الائتماني يؤثر على `client/new-transfer` تلقائياً.

### 6.8 GET /agent/reports/overview

الغرض: تقارير عامة للوكيل عن عملائه أو موظفيه.

Query:

```text
from
to
clientId
employeeId
status
page
limit
```

Response:

```json
{
  "success": true,
  "summary": {
    "totalClients": 20,
    "activeClients": 18,
    "totalDepositsLYD": 1000,
    "totalDebtLYD": 250,
    "totalTransfersEGP": 50000,
    "totalCostLYD": 7692.307
  },
  "items": [
    {
      "id": "safe-row-id",
      "clientName": "اسم العميل",
      "txId": "ATT-2606-0001",
      "type": "transfer",
      "status": "completed",
      "amount": 1000,
      "costLYD": 153.846,
      "createdAt": "2026-06-15T00:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1,
  "totalPages": 1,
  "hasMore": false
}
```

### 6.9 GET /agent/reports/personal

الغرض: التقارير الشخصية للوكيل نفسه، منفصلة عن تقارير العملاء.

Response shape يكون مثل overview، لكن خاص بعمليات الوكيل نفسه فقط.

## 7. Reports المطلوبة بالتفصيل

يجب الرد على كل نوع تقرير:

| التقرير | مطلوب للموبايل؟ | Endpoint مطلوب | صلاحيات |
|---|---|---|---|
| سجل عمليات العميل العادي | موجود | `/client/transactions` | client |
| تفاصيل عملية العميل | موجود | `/client/transactions/:id` | client |
| تقرير الشركة الكامل | مطلوب توضيح/إضافة | `/company/reports` | company_owner/company_accountant |
| تقرير موظف الشركة اليومي | مطلوب توضيح/إضافة | `/company/reports` مع تقييد | company_employee |
| تقرير محاسب الشركة | مطلوب توضيح/إضافة | `/company/reports` | company_accountant |
| تقرير الوكيل العام | مطلوب توضيح/إضافة | `/agent/reports/overview` | agent_owner |
| تقرير عملاء الوكيل | مطلوب توضيح/إضافة | `/agent/reports/overview` | agent_owner |
| التقرير الشخصي للوكيل | مطلوب توضيح/إضافة | `/agent/reports/personal` | agent_owner/agent_accountant |
| تقارير المنفذ | مطلوب توضيح هل موجودة للموبايل | يحددها الباك | executor |

## 8. Profile / Account API المطلوب

التطبيق يحتوي شاشة حساب. نحتاج توضيح هل هي قراءة فقط أم قابلة للتعديل.

### 8.1 GET /account/profile

Method:

```text
GET /api/mobile/account/profile
```

Response:

```json
{
  "success": true,
  "profile": {
    "id": "safe-id",
    "name": "اسم المستخدم",
    "phone": "0912345678",
    "username": "username",
    "persona": "direct_client",
    "accountType": "client_user",
    "role": "client",
    "status": "active",
    "context": {}
  }
}
```

### 8.2 PATCH/POST /account/profile

إذا كان تعديل البيانات مسموحاً:

Request:

```json
{
  "name": "اسم جديد",
  "phone": "0912345678",
  "storeName": "اسم المحل",
  "address": "العنوان"
}
```

يجب تحديد الحقول المسموح تعديلها لكل شخصية.

### 8.3 POST /account/change-password

Request:

```json
{
  "currentPassword": "old-password",
  "newPassword": "new-strong-password"
}
```

Response:

```json
{
  "success": true,
  "message": "تم تغيير كلمة المرور بنجاح"
}
```

Security:

- عدم إرجاع كلمة المرور.
- إبطال الجلسات القديمة أو توضيح السياسة.
- Audit log.
- Rate limiting.

## 9. Support Tickets لكل الأدوار

المسار الحالي اسمه `/client/tickets` لكنه يعمل حسب العقد الحالي لعدة أنواع.

المطلوب تأكيد صريح:

هل هذه المسارات تعمل لكل الشخصيات التالية؟

- direct_client
- agent_client
- company_owner
- company_employee
- company_accountant
- agent_owner
- agent_employee
- agent_accountant
- executor

لو لا، يجب تحديد:

- من المدعوم.
- من غير المدعوم.
- هل نحتاج `/support/tickets` كمسار عام بديل.

Response الرسائل يجب أن يكون بهذا الشكل:

```json
{
  "success": true,
  "ticket": {
    "id": "safe-ticket-id",
    "ticketId": "TCK-123456",
    "subject": "عنوان التذكرة",
    "status": "open",
    "messages": [
      {
        "id": "safe-message-id",
        "sender": "user",
        "senderName": "اسم المستخدم",
        "text": "نص الرسالة",
        "imageUrl": null,
        "createdAt": "2026-06-15T00:00:00.000Z"
      }
    ],
    "createdAt": "2026-06-15T00:00:00.000Z",
    "updatedAt": "2026-06-15T00:00:00.000Z"
  }
}
```

## 10. قواعد الرصيد وسعر الصرف والعملة

هذه النقطة يجب تثبيتها لأنها تؤثر مباشرة على واجهة التحويل.

### 10.0 قاعدة مستوى العميل وأسعار الخدمة للموبايل

التطبيق لا يحتاج أن يعرض للعميل رقم المستوى صراحة مثل "Tier 1" أو "Tier 2" إلا إذا طلبت الإدارة ذلك في التصميم، لكنه يحتاج أن يعرف المستوى أو الأسعار النهائية المرتبطة بالمستوى برمجياً حتى يعرض سعر الصرف الصحيح لكل نوع خدمة.

المصدر الوحيد لمستوى العميل وسعر الصرف هو الباك إند. ممنوع أن يخمن Flutter مستوى العميل من الاسم أو الرصيد أو نوع الحساب أو أي قيمة ظاهرة، وممنوع تثبيت أسعار صرف داخل التطبيق كحقيقة إنتاجية.

المطلوب أن ترجع الاستجابات التي تغذي الصفحة الرئيسية والتحويل، خصوصاً `POST /login` و `GET /client/home` و `POST /client/exchange-rate`، حقولاً واضحة مثل:

```json
{
  "tier": 2,
  "tierLabel": "مستوى 2",
  "baseExchangeRate": 6.45,
  "exchangeRate": 6.45,
  "serviceRates": {
    "vodafone": 6.45,
    "post_account": 6.40,
    "post_card": 6.30
  }
}
```

قواعد هذا العقد:

- `tier` قيمة برمجية داخلية تساعد Flutter على معرفة مستوى العميل، ولا يلزم عرضها للمستخدم.
- `tierLabel` نص اختياري للعرض إذا قررت الإدارة إظهاره لاحقاً.
- `baseExchangeRate` هو سعر المستوى قبل تعديل نوع الخدمة.
- `exchangeRate` يبقى موجوداً للتوافق الخلفي، ويفضل أن يساوي سعر خدمة `vodafone` أو السعر الافتراضي للعميل.
- `serviceRates` هو المصدر الأفضل لواجهة التحويل؛ كل نوع خدمة يأخذ سعره النهائي منه مباشرة.
- Flutter يستخدم هذه القيم للعرض والحساب التقديري فقط، أما تنفيذ التحويل والخصم والتسعير النهائي فيظل داخل الباك إند.
- في حالة وجود قاعدة ثابتة حالية مثل `post_account = base - 0.05` و `post_card = base - 0.15` يجب توثيقها صراحة، لكن الأفضل إرسال `serviceRates` جاهزة حتى لا يحمل التطبيق منطق تسعير قابل للتغيير.
- لو لم يرسل الباك إند `serviceRates` مؤقتاً، يجب أن يوضح ذلك صراحة في العقد، ويكون أي fallback داخل Flutter مؤقتاً ومغطى باختبارات، وليس بديلاً دائماً عن العقد الرسمي.

### 10.1 المطلوب توضيحه

أجبوا بدقة:

1. الرصيد المعروض في التطبيق بأي عملة؟
2. حقل `balance` في Login و`client/home` يمثل ماذا؟
3. حقل `amount` في `/client/new-transfer` يمثل ماذا؟
4. هل `amount` هو قيمة بالجنيه المصري؟
5. هل `costLYD = amount / exchangeRate` دائماً؟
6. هل يمكن للعميل إدخال المبلغ بالدينار ويقوم الباك بحساب المصري؟
7. هل سعر الصرف يأتي حسب tier/level من الإدارة؟
8. هل فرق سعر الصرف للـ `post_account` و`post_card` ثابت كما في الكود الحالي أم قابل للإدارة؟
9. هل `creditLimit` يدخل في حساب الرصيد المتاح للتحويل؟
10. هل `agent_client` يستخدم رصيد مستقل أم رصيد/حد من الوكيل؟

### 10.2 عقد مقترح إن كان الباك يدعم إدخال عملتين

إذا أردتم دعم UI فيه خانة مصري وخانة ليبي، نحتاج أحد خيارين:

الخيار الأول: Flutter يرسل `amount` فقط بالجنيه المصري:

```json
{
  "transferType": "vodafone",
  "amount": 1000,
  "number": "01000000000",
  "name": null,
  "notes": "اختياري"
}
```

والباك يرجع:

```json
{
  "success": true,
  "txId": "ATT-2606-0001",
  "amount": 1000,
  "costLYD": 153.846,
  "exchangeRate": 6.5,
  "newBalance": 846.154
}
```

الخيار الثاني: الباك يقبل `amountEGP` أو `amountLYD` ويحدد العملة:

```json
{
  "transferType": "vodafone",
  "inputCurrency": "LYD",
  "amountLYD": 100,
  "number": "01000000000"
}
```

ويرجع المصري والليبي معاً.

يجب اختيار خيار واحد وتوثيقه. لا يترك Flutter يخمن.

## 11. Balance Transfer بين العملاء

ورد أن هناك نظام نقل أموال بين العملاء. نحتاج تحديد موقفه من تطبيق Flutter.

أجيبوا صراحة:

- هل هذه الميزة مطلوبة في Mobile V1؟
- هل لها Mobile API؟
- هل هي خاصة بعميل لعميل؟
- هل هي خاصة بوكيل وعميله؟
- هل تتطلب Idempotency-Key؟
- هل تظهر في سجل العمليات؟

إذا كانت مدعومة، نحتاج:

```text
GET /api/mobile/balance-transfer/lookup?accountCode=
POST /api/mobile/balance-transfer
GET /api/mobile/balance-transfer/:id
```

مع request/response وأكواد الأخطاء.

إذا كانت مؤجلة، يجب كتابتها صراحة.

## 12. Staging Accounts المطلوبة

لا يمكن اعتماد الربط بدون حسابات اختبار حقيقية.

يجب توفير حساب لكل شخصية مدعومة فعلياً:

| الشخصية | username/phone | password | بيانات مطلوبة |
|---|---|---|---|
| direct_client | مطلوب | مطلوب | رصيد، عمليات، تذاكر |
| agent_client | مطلوب | مطلوب | وكيل مرتبط، حد ائتماني، عمليات |
| company_owner | مطلوب | مطلوب | شركة، موظفين، تقارير |
| company_employee | مطلوب | مطلوب | عمليات اليوم فقط إذا هذا المنطق |
| company_accountant | مطلوب | مطلوب | تقارير كاملة قراءة فقط |
| agent_owner | مطلوب | مطلوب | عملاء، طلبات انضمام، تقارير |
| agent_employee | مطلوب | مطلوب | صلاحيات محددة |
| agent_accountant | مطلوب | مطلوب | تقارير قراءة فقط |
| executor | مطلوب | مطلوب | مهام حية، مهمة قابلة للقبول |

### 12.1 بيانات Staging المطلوبة

لكل حساب يجب أن تكون هناك بيانات مناسبة:

- رصيد قابل للعرض.
- 5 عمليات على الأقل بحالات مختلفة.
- تذكرة دعم مفتوحة.
- تذكرة دعم مغلقة.
- للمنفذ: مهام pending/accepted/completed.
- للوكيل: عميلان تابعان على الأقل.
- للوكيل: طلبا انضمام pending على الأقل.
- للشركة: موظف عادي ومحاسب.
- للشركة: تقارير فيها عمليات لأكثر من موظف.

### 12.2 تأكيد عدم وجود معاملات حقيقية

يجب تأكيد كتابي:

```text
Staging لا ينفذ أي تحويل أو خصم مالي حقيقي، وكل العمليات على دفاتر اختبار فقط.
```

## 13. Error Codes المطلوبة

يجب توحيد الأكواد التالية على الأقل:

```text
INVALID_CREDENTIALS
ACCOUNT_LOCKED
ACCOUNT_BANNED
TOKEN_INVALID
TOKEN_EXPIRED
SESSION_REVOKED
UNAUTHORIZED
FORBIDDEN
VALIDATION_ERROR
MALFORMED_RESPONSE
INSUFFICIENT_BALANCE
SYSTEM_CLOSED
DUPLICATE_IGNORED
IDEMPOTENCY_KEY_REQUIRED
IDEMPOTENCY_CONFLICT
NOT_FOUND
PERMISSION_DENIED
ACCOUNT_NOT_IN_AGENT_SCOPE
COMPANY_CONTEXT_REQUIRED
AGENT_CONTEXT_REQUIRED
UNSUPPORTED_PERSONA
BACKEND_BLOCKER
SERVER_ERROR
```

كل كود يجب أن يكون له رسالة عربية مناسبة للمستخدم.

## 14. Idempotency

هذه المسارات يجب أن تطلب `Idempotency-Key`:

- `POST /client/new-transfer`
- `POST /company/employees`
- `PATCH/POST /company/employees/:id/status` إذا ينتج أثر مهم
- `PATCH/POST /company/employees/:id/permissions`
- `POST /agent/join-requests/:id/approve`
- `POST /agent/join-requests/:id/reject`
- `POST /agent/clients/:id/deposit`
- `PATCH/POST /agent/clients/:id/credit-limit`
- أي balance transfer مستقبلي

إذا كان endpoint غير مالي لكن قابل للتكرار، يفضل دعمه كذلك.

Response عند التكرار:

```json
{
  "success": false,
  "code": "DUPLICATE_IGNORED",
  "message": "تم تجاهل الطلب المكرر"
}
```

أو يرجع نفس نتيجة الطلب الأول إذا كانت سياستكم كذلك. يجب توثيق السياسة.

## 15. Media Upload

### 15.1 صور التحويل

الموبايل قد يرسل:

- `idCardImage` لتحويل بريد بالبطاقة.
- `oldReceiptImage` لتحويل بريد على حساب.
- `imageBase64` عند إكمال المنفذ للمهمة.

المطلوب:

- قبول `data:image/jpeg;base64,...`.
- حد أقصى واضح للحجم.
- ضغط الصور في Flutter متوقع، لكن الباك يجب أن يرفض الأحجام الزائدة.
- عدم إرجاع path داخلي.
- الإرجاع يكون عبر proxy/ticket فقط.

### 15.2 Receipt/Image viewing

أي صورة يجب عرضها عبر:

```text
GET /api/mobile/transaction/image/:id
GET /api/mobile/transaction/image/content?ticket=...
```

ولا يتم إرجاع روابط تيليجرام مباشرة.

## 16. Security Acceptance Criteria

لن يعتبر العمل مكتملاً إلا إذا تحقق الآتي:

- كل Endpoint عليه JWT auth ما عدا Login/Register.
- كل Endpoint يفحص persona/permissions server-side.
- كل عملية مالية عليها Idempotency-Key.
- كل عملية مالية لها Audit log.
- كل عملية مالية تسجل Ledger/Journal مناسب.
- لا raw fields في الردود.
- لا passwords في الردود.
- لا Telegram direct URLs في الردود.
- لا Web sessions للموبايل.
- لا HTML responses للموبايل.
- لا stack traces.
- لا صلاحيات محسوبة في Flutter فقط.
- كل response موحد.
- كل pagination موحد.
- كل التاريخ بصيغة ISO 8601.
- كل الأرقام المالية Numbers وليست Strings إلا لو سبب موثق.

## 17. Automated Tests المطلوبة من الباك إند

يجب إضافة/تحديث اختبارات تغطي:

### 17.1 Auth Contract Tests

- كل persona ترجع `persona`, `role`, `permissions`, `context`.
- unsupported persona لا تفتح مسارات محمية.
- client_user لا يفتح company/agent endpoints بدون صلاحية.
- executor لا يفتح client endpoints.

### 17.2 Company Mobile Tests

- owner يرى الموظفين.
- owner ينشئ موظف.
- owner يغير status.
- owner يغير permissions.
- accountant يرى التقارير ولا يعدل موظفين.
- employee لا يرى إلا المسموح.

### 17.3 Agent Mobile Tests

- agent owner يرى join requests.
- approve/reject works with idempotency.
- agent يرى clients في نطاقه فقط.
- agent لا يرى عميل وكيل آخر.
- deposit يخصم من الوكيل ويزيد العميل.
- credit limit يطبق ويظهر في client transfer rules.

### 17.4 Reports Tests

- company reports scoped by company.
- employee daily report restricted.
- agent overview report scoped by agent.
- personal report منفصل عن overview.

### 17.5 Security Tests

- no raw fields.
- no password leakage.
- no token leakage except Auth.
- no web HTML responses.
- no missing idempotency for financial endpoints.
- permission denied returns `FORBIDDEN`.

## 18. Documentation المطلوبة للتسليم

يجب تسليم واحد من الآتي:

- تحديث `docs/Flutter-Mobile-API-Contract.md`
- أو ملف جديد واضح مثل `docs/Flutter-Mobile-API-Contract-v2.md`
- أو OpenAPI/Swagger محدث
- أو Postman collection محدثة

لكن يجب أن يحتوي على:

- endpoint
- method
- auth required
- allowed personas
- headers
- request
- success response
- error responses
- staging account يغطي endpoint

## 19. طريقة الرد المطلوبة من الباك إند

الرد يجب أن يكون endpoint-by-endpoint فقط. لا نحتاج رد عام.

لكل بند اكتب:

```text
Endpoint:
Status: جاهز كموبايل API / موجود في الويب فقط / غير موجود / مؤجل
Method:
Path:
Allowed personas:
Required permissions:
Request:
Response:
Errors:
Staging account:
Notes:
```

## 20. قائمة القرار النهائي

يجب أن يرد الباك إند على هذه الأسئلة تحديداً:

1. هل `persona` ستضاف في Login؟
2. هل `role` و`permissions` ستضاف في Login؟
3. ما هي كل personas المدعومة فعلياً الآن؟
4. هل agent owner يظهر كم `client_user` مع `persona=agent_owner`؟
5. هل agent client يظهر كم `client_user` مع `persona=agent_client`؟
6. هل company owner هو `client_company` مع `persona=company_owner`؟
7. هل company employee/accountant مدعومين كموبايل؟
8. هل agent employee/accountant مدعومين كموبايل؟
9. هل الوكيل يستطيع إدارة العملاء من الموبايل؟
10. هل الوكيل يستطيع الإيداع للعميل من الموبايل؟
11. هل الحد الائتماني مدعوم في Mobile API؟
12. هل تقارير الشركة والوكيل مدعومة في Mobile API؟
13. هل تغيير كلمة المرور مدعوم في Mobile API؟
14. هل tickets مدعومة لكل الأدوار؟
15. هل balance transfer بين العملاء داخل نطاق Flutter V1؟

## 21. تعريف الاكتمال

يعتبر الباك إند جاهزاً لتطبيق Flutter فقط عندما:

- كل Endpoint مطلوب إما جاهز أو مؤجل رسمياً.
- لا توجد شاشة Flutter حقيقية تعتمد على Web route.
- Login يحدد الشخصية والصلاحيات بوضوح.
- كل شخصية لها حساب Staging.
- كل حساب Staging يحتوي بيانات كافية للاختبار.
- كل الاختبارات تمر.
- العقد الرسمي محدث.
- لم يتم كسر المسارات الحالية.

إذا لم يتحقق بند من هذه البنود، يجب توضيحه كـ blocker وليس تركه لتخمين Flutter.
