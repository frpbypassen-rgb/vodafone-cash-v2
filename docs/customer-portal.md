# بوابة العملاء

بوابة العملاء (غير الشركات) هي واجهة ما بعد تسجيل الدخول على **`/client/dashboard`** عندما `accountType !== company`.

- تسجيل دخول العميل/الوكيل من `/login?portal=client` يفتح `/client/dashboard`.
- الشركات تبقى على `/client/services` بقشرة `cp-app` — لا تُحمَّل ملفات العملاء هناك.
- صفحات العمل للوكلاء تبقى تحت `/client/*` داخل `workspace.ejs` بقشرة `cl-app`.
- صفحات التجزئة (تحويل، حساب، إعدادات، دعم) تستخدم قشرة المحفظة مع نفس رموز `cl-*`.
- سطح المكتب: شريط جانبي + شريط علوي + محتوى. الهاتف: إرساء سفلي وأهداف لمس ≥ 44px وحشوة safe-area.
- لا تُستعاد `/corporate`. الإدارة والمنفّذ خارج هذا النطاق.

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
- الهيكل: `public/css/client-portal-layout.css` (قشرة `cl-app` / `cl-sidebar` / `cl-topbar` / `cl-dock`)
- المظاهر: `theme-day` و`theme-night` و`theme-pharaonic`
- المبدّل: `views/client/partials/customer_theme_switcher.ejs`
- الحفظ: `POST /client/settings/theme` و`POST /client/api/theme` (فرع غير الشركة)

لا تحمّل `company-portal*.css` على صفحات العملاء. لا تحمّل `client-portal*.css` على صفحات الشركة.
