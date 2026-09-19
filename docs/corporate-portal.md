# بوابة الشركات

بوابة الشركات الرسمية هي واجهة العميل على **`/client/services`** (غرفة التنفيذ / معرض الخدمات: اختر · راجع · أرسل).

- تسجيل دخول الشركة من `/login?portal=client` يفتح `/client/services`.
- الروابط القديمة `/corporate` و`/corporate/*` و`/client/company-next` تُحوَّل بـ 302 إلى `/client/services`.
- الصفحات المرتبطة بنفس بوابة الشركات تبقى تحت `/client/*` (التحويل الذكي، عمليات اليوم، بيانات المنشأة، أمان الحساب، الدعم، المالية، التقارير).
- نفس الهيكل لكل الأدوار. الفرق في الوحدات المسموحة فقط.
- سطح المكتب: شريط جانبي + شريط علوي + محتوى. الهاتف: غلاف تطبيقي مع إرساء سفلي وأهداف لمس ≥ 44px وحشوة safe-area.
- الخادم هو مصدر الصلاحيات الوحيد. خرائط التنقل في EJS/JS للعرض فقط.

## الأدوار مقابل الصلاحيات

الدور المخزّن على `ClientEmployee.role` هو واحد فقط:

| الدور | المعنى |
| --- | --- |
| `owner` | مالك الشركة. وحده يدير الفريق ويعيد تعيين كلمات المرور |
| `accountant` | محاسب. كشوف ورصيد بلا تحويل ما لم تُمنح صلاحية مستقلة |
| `employee` | موظف تنفيذ |

الحقل القديم `corporateRole` (`manager` / `accountant`) والحقول `canManageCompany` و`canCreateCompanyStaff` و`canViewAllReports === true` بدون `canManageCompany` (المالك القديم) تبقى أسماء مستعارة للتوافق. `manager` ليس دوراً مخزّناً؛ هو شخصية تشغيلية عندما يكون الدور `owner` أو `canManageCompany === true`.

صلاحيات مستقلة عن الدور (تُشتق إن لم تُضبط صراحة):

| الصلاحية | الافتراضي |
| --- | --- |
| `canCreateTransfer` | كل الأدوار إلا المحاسب |
| `canViewAllReports` | العلم المخزّن، ويُكمل المالك/المدير/المحاسب رؤية الكشوف |
| `canManageCompanyProfile` | المالك أو `canManageCompany` |
| `canManageTeam` / `canResetStaffPassword` | المالك فقط — لا تُرفع بصلاحية مصطنعة |

كل مسار/متحكم للشركة يعيد فحص `companyId` + الدور + الصلاحية. إخفاء بند القائمة ليس حماية.

## كلمات المرور والتدقيق

- تغيير كلمة مرور الحساب الحالي يتطلب الكلمة الحالية.
- إعادة تعيين موظف تتطلب كتابة اسم المستخدم و`RESET`، وتمنع المالك من استهداف نفسه، وتمنع أي هدف خارج الشركة الحالية.
- بعد إعادة التعيين: تُزاد `sessionVersion` (إبطال الجلسات) ويُفرض `mustChangePassword` عند الدخول التالي.
- `AuditLog` يسجّل الإجراء دون كلمة المرور.

## المظاهر الثلاثة

الخادم يضع `data-theme` و`data-company-role` على HTML. JavaScript يعزّز المبدّل فقط.

| القيمة | الاسم |
| --- | --- |
| `day` | نهاري — أسطح بيضاء/شبه بيضاء، نص أسود/رمادي، ظلال ناعمة، شريط جانبي فاتح |
| `night` | ليلي — فحم داكن وليس أسود صافياً، تباين نص عالٍ وحقول واضحة |
| `pharaonic` | فرعوني — أزرار معبد/مسلة، رمل وذهب وفيروز، أيقونات عائمة. الزخرفة الثقيلة تنتظر `cp-art-ready` وتتوقف مع `prefers-reduced-motion` |

المصدر بعد تسجيل الدخول: `preferences.companyTheme` (الحقل الكانوني). `uiTheme` اسم مستعار للقراءة فقط أثناء الترحيل. لا تُنشأ أعمدة مظهر منفصلة. `localStorage.ahram_company_theme` للرسم الفوري؛ قيمة الخادم تفوز بعد الدخول وتُكتب إلى المتصفح.

الملفات:

- الرموز المشتركة: `public/css/company-portal.tokens.css`
- الهيكل الجديد: `public/css/company-portal-layout.css` (قشرة `cp-app` / `cp-sidebar` / `cp-page-hero` / `cp-service-card`)
- المظاهر: `public/css/company-portal-theme-day.css` و`theme-night` و`theme-pharaonic` — ملفات كاملة وليست طبقات صغيرة فوق الواجهة القديمة
- المبدّل الظاهر: `views/client/partials/company_theme_switcher.ejs` (سكة ثلاث أزرار + نموذج POST يعمل بلا JS)
- الحفظ: `POST /client/settings/theme` و`POST /client/api/theme`

لا تحمّل `client-company-os.css` على بوابة الشركات. لا تضع ألواناً ثابتة في قوالب صفحات الشركة؛ استخدم `var(--cp-*)`.

## الإشعارات وWeb Push

- جرس الإشعارات داخل البوابة يقرأ صندوقاً محفوظاً على الخادم (`/client/api/notifications`) مع تعليم كمقروء.
- Web Push يستخدم مفاتيح VAPID الموجودة: `WEB_PUSH_PUBLIC_KEY` و`WEB_PUSH_PRIVATE_KEY` و`WEB_PUSH_SUBJECT`.
- التفعيل من `/client/security`. اختبار QA: `POST /client/api/web-push/test`.

لا توجد واجهة موازية على `/corporate` ولا «واجهة جديدة» منفصلة عن هذه البوابة.
