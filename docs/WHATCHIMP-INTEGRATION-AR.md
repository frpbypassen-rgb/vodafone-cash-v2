# ربط WhatsApp عبر WhatChimp

## النتيجة بعد الإعداد

- رموز OTP لتسجيل دخول العملاء، الشركات، الوكلاء، وموظفيهم تصل عبر WhatsApp.
- عند اكتمال التحويل، يرسل النظام إيصال العملية للجهة التي أنشأت العملية.
- الإيصال في WhatsApp يعتمد رابطاً موقّعاً لصورة الإيصال؛ الرابط لا يعمل بعد انتهاء صلاحيته.
- فشل إرسال WhatsApp لا يغيّر الحالة المالية للعملية، لكنه يسجل في سجل التدقيق.

## ما يلزم من حساب WhatChimp

1. اربط رقم WhatsApp Business في WhatChimp.
2. من `Settings > API Developer Console` انسخ `API Token` و `Phone Number ID`.
3. أنشئ قالبين من نوع `Utility` وانتظر اعتمادهما من Meta.

### قالب OTP المقترح

اسم مقترح: `power_pay_otp`

```text
رمز الدخول إلى Power Pay AL-Ahram هو {{1}}.
صالح لمدة {{2}} دقائق.
لا تشارك الرمز مع أي شخص.
```

اجعل ترتيب المتغيرات في البيئة:

```dotenv
WHATCHIMP_OTP_VARIABLE_ORDER=otp,expiresMinutes
```

### قالب إيصال العملية المقترح

الخيار الأفضل هو قالب Utility يحتوي على رأس صورة (Image Header) ومن دون متغيرات في النص، مثل:

```text
تم تنفيذ حوالتك بنجاح.
الإيصال مرفق في هذه الرسالة.
```

بعد اعتماد القالب، استخرج قيمة `id` الداخلية للقالب من قائمة قوالب WhatChimp، وليس `template_id` الخاص بـ Meta، وضعها في `WHATCHIMP_RECEIPT_MEDIA_TEMPLATE_ID`.

بديل ممكن: قالب نصي بستة متغيرات، ترتيبه:

```dotenv
WHATCHIMP_RECEIPT_VARIABLE_ORDER=accountName,reference,amount,currency,completedAt,receiptUrl
```

## متغيرات البيئة

ضع القيم في ملف `.env` على الخادم فقط. لا ترفعها إلى Git:

```dotenv
# تفعيل OTP الحقيقي
FORCE_CLIENT_OTP=true
BYPASS_OTP=false
BYPASS_CLIENT_OTP=false

# WhatChimp
WHATCHIMP_ENABLED=true
WHATCHIMP_API_TOKEN=ضع_رمز_API_هنا
WHATCHIMP_PHONE_NUMBER_ID=ضع_معرف_رقم_واتساب_هنا
WHATCHIMP_OTP_TEMPLATE=power_pay_otp
WHATCHIMP_OTP_TEMPLATE_LANGUAGE=ar
WHATCHIMP_OTP_VARIABLE_ORDER=otp,expiresMinutes

# إيصال بصورة مرفقة في قالب WhatChimp
WHATCHIMP_RECEIPT_MEDIA_TEMPLATE_ID=ضع_معرف_القالب_الداخلي_هنا

# رابط عام HTTPS ليتمكن WhatChimp من جلب صورة الإيصال
PUBLIC_APP_URL=https://your-domain.example
RECEIPT_SHARE_SECRET=ضع_سراً_طويلاً_عشوائياً_هنا
WHATCHIMP_RECEIPT_URL_TTL_HOURS=720
```

إذا استخدمت قالب إيصال نصياً بدلاً من رأس الصورة، أضف:

```dotenv
WHATCHIMP_RECEIPT_TEMPLATE=power_pay_receipt
WHATCHIMP_RECEIPT_TEMPLATE_LANGUAGE=ar
WHATCHIMP_RECEIPT_VARIABLE_ORDER=accountName,reference,amount,currency,completedAt,receiptUrl
```

## الاختبار

1. أعد تشغيل الخدمة بعد تعديل `.env`.
2. افتح `الإعدادات > ربط WhatsApp عبر WhatChimp` واضغط `اختبار الاتصال`.
3. سجّل الدخول بحساب تجريبي وتأكد من وصول OTP.
4. أكمل عملية تحويل تجريبية، ثم تحقق من وصول الإيصال في WhatsApp.

تتطلب رسائل WhatsApp الاستباقية قالب Meta معتمداً. WhatChimp يرسل القوالب من خلال `/api/v1/whatsapp/send`، ويعيد معرف الرسالة الذي يمكن استخدامه لتتبع التسليم. راجع وثائق WhatChimp الرسمية قبل تغيير أسماء القوالب أو ترتيب متغيراتها.
