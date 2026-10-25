(() => {
    'use strict';
    const readResponse = async (response) => {
        const failure = (error) => ({ success: false, error });
        if (response.status === 401) return failure('انتهت جلسة الدخول. سجل الدخول مرة أخرى.');
        try {
            const text = await response.text();
            const data = JSON.parse(text);
            if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('INVALID_RESPONSE');
            if (data.code === 'MFA_ENROLLMENT_REQUIRED') {
                window.location.assign('/security/mfa-enroll');
                return failure(data.error || 'أكمل إعداد التحقق الإضافي.');
            }
            return data;
        } catch (_error) {
            return failure(
                response.ok
                    ? 'استجابة غير متوقعة من الخادم. تحقق من حالة العملية قبل المحاولة مجدداً.'
                    : 'تعذر تنفيذ الطلب.'
            );
        }
    };
    window.businessPortalApi = Object.freeze({ readResponse });
})();
