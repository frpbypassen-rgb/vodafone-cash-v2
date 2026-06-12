const axios = require('axios');

/**
 * خدمة إرسال رسائل الواتساب عبر WP Sender
 */
exports.sendWhatsAppMessage = async (phone, message, bypassOtp = false) => {
    try {
        const apiUrl = process.env.WPSENDER_API_URL;
        const apiKey = process.env.WPSENDER_API_KEY;

        if (!apiUrl || !apiKey || apiUrl === '') {
            console.warn('⚠️ إعدادات WP Sender غير مكتملة في ملف .env');
            return false;
        }

        // 🔒 حماية أمنية صارمة: لا يسمح بإرسال أي رسائل واتساب غير كود التحقق (OTP) إلا عند تمرير bypassOtp = true
        if (!bypassOtp) {
            const isOtp = message.includes('رمز') || message.includes('كود') || message.includes('OTP') || message.includes('تحقق');
            if (!isOtp) {
                console.warn('⚠️ تم حظر إرسال رسالة واتساب غير مخصصة للتحقق (غير OTP):', message);
                return false;
            }
        }

        // تنظيف الرقم وإضافة مفتاح الدولة (مصر أو ليبيا) إذا لم يكن معرف مجموعة أو رابطاً
        let cleanedPhone = phone.toString().trim();
        const isGroupOrLink = cleanedPhone.includes('@') || cleanedPhone.includes('http') || cleanedPhone.includes('/');

        if (!isGroupOrLink) {
            cleanedPhone = cleanedPhone.replace(/\D/g, '');
            if (cleanedPhone.startsWith('00')) {
                cleanedPhone = cleanedPhone.substring(2);
            }
            
            // إذا كان الرقم مصرياً ويبدأ بـ 01 وطوله 11 رقماً
            if (cleanedPhone.startsWith('01') && cleanedPhone.length === 11) {
                cleanedPhone = '2' + cleanedPhone; // يصبح 201xxxxxxxxx
            } 
            // إذا كان مصرياً ويبدأ بـ 1 وطوله 10 أرقام (بدون الصفر الأول)
            else if (cleanedPhone.startsWith('1') && cleanedPhone.length === 10) {
                cleanedPhone = '20' + cleanedPhone; // يصبح 201xxxxxxxxx
            }
            // إذا كان ليبياً ويبدأ بـ 09 وطوله 10 أرقام
            else if (cleanedPhone.startsWith('09') && cleanedPhone.length === 10) {
                cleanedPhone = '218' + cleanedPhone.substring(1); // يصبح 2189xxxxxxxxx
            }
            // إذا كان ليبياً ويبدأ بـ 9 وطوله 9 أرقام (بدون الصفر الأول)
            else if (cleanedPhone.startsWith('9') && cleanedPhone.length === 9) {
                cleanedPhone = '218' + cleanedPhone; // يصبح 2189xxxxxxxxx
            }
        }

        const payload = {
            number: cleanedPhone,
            message: message
        };

        console.log('📱 Sending WhatsApp to:', cleanedPhone);

        const response = await axios.post(apiUrl, payload, {
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            }
        });

        console.log(`✅ تم إرسال رسالة واتساب إلى ${cleanedPhone}. استجابة الخادم:`, response.data);
        return true;
    } catch (error) {
        console.error('❌ خطأ في إرسال رسالة الواتساب:', error.message);
        if (error.response) {
            console.error('تفاصيل خطأ API الواتساب:', error.response.data);
        }
        return false;
    }
};

/**
 * إرسال التفاصيل المالية والتشغيلية للمعاملة إلى مجموعة الواتساب
 */
exports.sendWhatsAppAlert = async (tx, apiResult) => {
    try {
        const groupTarget = process.env.WHATSAPP_GROUP_JID || 'https://chat.whatsapp.com/BP5E7X25o5zHVvs5DmTVrR?s=cl&p=a&ilr=4';
        
        const message = `[ التفاصيل المالية والتشغيلية للعملية ]
- رقم الموبايل   : ${tx.vodafoneNumber || tx.accountNumber || '---'}
- القيمة         : ${tx.amount} EGP
- الرصيد قبل     : ${apiResult.balance_before !== undefined ? apiResult.balance_before : '---'} EGP
- الرصيد بعد     : ${apiResult.balance_after !== undefined ? apiResult.balance_after : '---'} EGP
- الحالة         : ${apiResult.status || 'عمليه ناجحه'}
- رقم العملية    : ${apiResult.external_transaction_id || '---'}
- وقت العملية    : ${apiResult.transaction_time || new Date().toLocaleString('ar-EG')}
- الرقم المرجعي  : ${apiResult.sender_number || '---'}`;

        await exports.sendWhatsAppMessage(groupTarget, message, true);
        return true;
    } catch (err) {
        console.error('❌ خطأ في إرسال تنبيه الواتساب للمجموعة:', err.message);
        return false;
    }
};

/**
 * يمكنك إضافة دالة إرسال الصورة هنا مستقبلاً إذا دعت الحاجة
 * وتأكدت أن المنصة تدعم رفع الصور
 */
exports.sendWhatsAppImage = async (phone, imageBase64, caption) => {
    // TODO: 구현 إرسال الوسائط حسب توثيق WP Sender
    console.warn('إرسال الصور عبر الواتساب غير مفعل حالياً.');
    return false;
};
