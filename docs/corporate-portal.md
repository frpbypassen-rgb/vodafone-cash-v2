# بوابة الشركات

بوابة الشركات الرسمية هي واجهة العميل على **`/client/services`** (غرفة التنفيذ / معرض الخدمات: اختر · راجع · أرسل).

- تسجيل دخول الشركة من `/login?portal=client` يفتح `/client/services`.
- الروابط القديمة `/corporate` و`/corporate/*` و`/client/company-next` تُحوَّل بـ 302 إلى `/client/services`.
- الصفحات المرتبطة بنفس بوابة الشركات تبقى تحت `/client/*` (التحويل الذكي، عمليات اليوم، بيانات المنشأة، أمان الحساب، الدعم، المالية، التقارير).
- نفس الهيكل لكل الأدوار (مدير / محاسب / موظف). الفرق في البطاقات والإجراءات الظاهرة فقط.
- سطح المكتب: شريط جانبي + شريط علوي + محتوى. الهاتف: غلاف تطبيقي مع إرساء سفلي وأهداف لمس ≥ 44px وحشوة safe-area.

## المظاهر الثلاثة

البوابة تستخدم `data-theme` على عنصر `html` (ويُنسخ إلى `body.bw-company-os`) بقيم:

| القيمة | الاسم | الاستخدام |
| --- | --- | --- |
| `day` | نهاري | فاتح، نظيف، تباين عالٍ |
| `night` | ليلي | حجر داكن وإضاءة منخفضة |
| `pharaonic` | فرعوني | هوية رمل/ذهب/فيروز/طوب كاملة مع زخرفة متحركة خفيفة |

المصدر بالترتيب: `localStorage.ahram_company_theme` ثم تفضيل الحساب (`ClientEmployee.uiTheme` / الجلسة) ثم `prefers-color-scheme` (ليلي إن كان الجهاز داكناً، وإلا نهاري). بعد اختيار المستخدم لا يُعاد تطبيق تفضيل النظام.

الملفات:

- الرموز: `public/css/company-portal.tokens.css` (`--cp-*` وربط `--bw-*`)
- الهيكل والحركة والأيقونات: `public/css/company-portal.css`
- المبدّل: `views/client/partials/company_theme_switcher.ejs`
- الأيقونات الفرعونية: `views/client/partials/company_icons.ejs` و`public/icons/pharaonic/sprite.svg`
- الحفظ الاختياري على الخادم: `POST /client/api/theme`

### إضافة مظهر رابع

1. أضف المفتاح إلى `COMPANY_PORTAL_THEMES` في `utils/companyPortalTheme.js` وإلى `ClientEmployee.uiTheme`.
2. انسخ كتلة `html[data-theme="..."]` في `company-portal.tokens.css` وعدّل `--cp-*`.
3. أضف زراً في `company_theme_switcher.ejs` وخياراً في صفحة بيانات المنشأة.
4. أضف القيمة إلى مصفوفة `THEMES` في `public/js/company-portal.js`.
5. لا تضع ألواناً ثابتة في صفحات `/client/*`؛ استخدم `var(--cp-surface)` و`var(--cp-ink)` ونظائرها.

الحركة الزخرفية (وميض الهيروغليف وغبار الرمل وعلامة حورس) تظهر في المظهر الفرعوني فقط وتتوقف مع `prefers-reduced-motion`.

## الإشعارات وWeb Push

- جرس الإشعارات داخل البوابة يقرأ صندوقاً محفوظاً على الخادم (`/client/api/notifications`) مع تعليم كمقروء.
- Web Push يستخدم مفاتيح VAPID الموجودة: `WEB_PUSH_PUBLIC_KEY` و`WEB_PUSH_PRIVATE_KEY` و`WEB_PUSH_SUBJECT` (نفس مسار بوابة التنفيذ، بدون المساس بـ FCM).
- التفعيل من `/client/security`. اختبار QA: `POST /client/api/web-push/test`.
- أحداث مربوطة حالياً: اكتمال تحويل الشركة، تنبيه الرصيد المنخفض، ورد الدعم.
- على iOS قد يلزم «إضافة إلى الشاشة الرئيسية» ثم فتح البوابة من الأيقونة.

## فجوات الأدوار

- الحقول المستخدمة: `ClientEmployee.role` (`owner` / `employee` / `accountant`) مع `canManageCompany` و`canViewAllReports` و`canCreateCompanyStaff`.
- الحقل المتبقي `corporateRole` يُحترم كاحتياط إذا وُجد (`manager` / `accountant`) ولا توجد صفحة موافقات على `/client/*`. مجموعة «موافقات» في الجرس جاهزة إذا ظهرت تلك الأحداث لاحقاً.

لا توجد واجهة موازية على `/corporate` ولا «واجهة جديدة» منفصلة عن هذه البوابة.
