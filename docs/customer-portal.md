# بوابة العملاء

بوابة العملاء (غير الشركات) هي واجهة ما بعد تسجيل الدخول على **`/client/dashboard`** عندما `accountType !== company`.

- تسجيل دخول العميل/الوكيل من `/login?portal=client` يفتح `/client/dashboard`.
- الشركات تبقى على `/client/services` بقشرة `cp-app` — لا تُحمَّل ملفات العملاء هناك.
- صفحات العمل للوكلاء تبقى تحت `/client/*` داخل `workspace.ejs` بقشرة `cl-app`.
- صفحات التجزئة (تحويل، حساب، إعدادات، دعم) تستخدم قشرة المحفظة مع نفس رموز `cl-*`.
- سطح المكتب: شريط جانبي + شريط علوي + محتوى. الهاتف: إرساء سفلي + ورقة «المزيد» وأهداف لمس ≥ 44px وحشوة safe-area.
- لا تُستعاد `/corporate`. الإدارة والمنفّذ خارج هذا النطاق.

## قشرة واحدة

الخادم يضع `data-portal="customer"` و`data-theme` على HTML. لا توجد قشرة عميل موازية بعد تسجيل الدخول.

| الطبقة | الملفات |
| --- | --- |
| الدخول | `customer_portal_styles.ejs` → `client-portal.tokens.css` + `client-portal-layout.css` + ثلاث مظاهر |
| الوكلاء | `workspace.ejs` + `workspace_sidebar` / `workspace_topbar` / `customer_mobile_dock` |
| التجزئة | `dashboard.ejs` + `hub/*.ejs` + `wallet_hub_sidebar_hub` + `wallet_hub_bottom_nav` |
| الإشعارات | `customer_notifications.ejs` + `client-portal.js` → `/client/api/notifications` |
| المزيد | `customer_more_sheet.ejs` (ورقة واحدة للتجزئة والوكيل) |

ملفات `wallet_shell_*` و`wallet_hub_sidebar` (CLIENT OS) مُعطّلة (`LEGACY_GATED`) ولا تُرسم على صفحات `cl-app`. CSS القديم (nile / os / hub-pages) إن وُجد فهو لمحتوى الصفحة فقط؛ القشرة تُخفي أي شريط سفلي ليس `.cl-dock`.

لا تحمّل `company-portal*.css` على صفحات العملاء. لا تحمّل `client-portal*.css` على صفحات الشركة.

## خريطة التنقل على الهاتف

### تجزئة (عميل مباشر / نقطة بيع)

شريط جانبي سطح المكتب → مكافئ الهاتف:

| سطح المكتب | الهاتف |
| --- | --- |
| الرئيسية `/client/dashboard` | الإرساء: الرئيسية |
| إرسال وتحويل `/client/transfers` | الإرساء: تحويل |
| الخدمات والمدفوعات `/client/services` | الإرساء: الخدمات |
| الأمان والإعدادات `/client/settings` | الإرساء: حسابي |
| الحساب والعمليات | المزيد |
| إضافة رصيد | المزيد |
| الدعم والشكاوى | المزيد |
| تسجيل الخروج | المزيد |

### وكيل (`workspace.ejs`)

| سطح المكتب | الهاتف |
| --- | --- |
| الرئيسية | الإرساء |
| الخدمات والتحويل | الإرساء: تحويل |
| المعاملات | الإرساء: العمليات |
| الدعم الفني | الإرساء: الدعم |
| الحركات المالية، محاسبة الوكالة، العملاء، الموظفون، التقارير، الإعدادات | المزيد |

## المظاهر الثلاثة

الخادم يضع `data-portal="customer"` و`data-theme` على HTML. JavaScript يعزّز المبدّل فقط.

| القيمة | الاسم |
| --- | --- |
| `day` | نهاري — نيلي وفيروز على لوحة زرقاء باردة، بطاقات بيضاء |
| `night` | ليلي — كحلي داكن بتباين عالٍ ولمسات سماوية/بنفسجية |
| `pharaonic` | فرعوني — رمل وذهب وفيروز. الزخرفة الثقيلة تنتظر `cl-art-ready` وتتوقف مع `prefers-reduced-motion` |

المصدر بعد تسجيل الدخول: `preferences.clientTheme` على User / SubAccount / AgentEmployee. لا يُكتب `preferences.companyTheme`. `localStorage.ahram_client_theme` للرسم الفوري؛ قيمة الخادم تفوز بعد الدخول.

الملفات:

- الرموز: `public/css/client-portal.tokens.css`
- الهيكل: `public/css/client-portal-layout.css` (قشرة `cl-app` / `cl-sidebar` / `cl-topbar` / `cl-dock` / `cl-bell` / `cl-more`)
- المظاهر: `theme-day` و`theme-night` و`theme-pharaonic`
- المبدّل: `views/client/partials/customer_theme_switcher.ejs`
- الحفظ: `POST /client/settings/theme` و`POST /client/api/theme` (فرع غير الشركة)
- التنقل: `utils/customerPortalNav.js`

## الإشعارات

صندوق وارد داخل التطبيق (`data-customer-bell`) على الشريط العلوي وصفحات المحور. نفس واجهات `/client/api/notifications*`. تنبيهات السعر (`rate-alert-overlay`) تبقى كما هي. Web Push الخاص بالشركات (`COMPANY_PUSH_ONLY`) لم يُفتح للعملاء.
