(function () {
    'use strict';

    const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

    const redirectForSecurityCode = (code) => {
        const normalized = String(code || '').trim();
        if (!normalized) return false;
        if (normalized === 'MFA_ENROLLMENT_REQUIRED') {
            window.location.assign('/security/mfa-enroll');
            return true;
        }
        if (
            normalized === 'DEVICE_BINDING_MISMATCH' ||
            normalized === 'SECURITY_SESSION_EXPIRED' ||
            normalized === 'ADMIN_SESSION_REVOKED'
        ) {
            window.location.assign(`/login?security=${encodeURIComponent(normalized)}`);
            return true;
        }
        return false;
    };

    window.executorApiFetch = function executorApiFetch(url, options) {
        const requestOptions = { ...(options || {}) };
        const method = String(requestOptions.method || 'GET').toUpperCase();
        const headers = new Headers(requestOptions.headers || {});

        headers.set('Accept', 'application/json');
        if (!safeMethods.has(method)) {
            headers.set('x-csrf-token', window.executorCsrfToken || '');
        }

        requestOptions.headers = headers;
        return window.fetch(url, requestOptions);
    };

    window.readExecutorApiResponse = async function readExecutorApiResponse(response) {
        const data = await response.json().catch(() => null);
        if (response.status === 401) {
            window.location.assign('/login');
            throw new Error('انتهت جلسة الدخول.');
        }
        if (redirectForSecurityCode(data?.code)) {
            throw new Error(data.error || data.message || 'انتهت جلسة الدخول.');
        }
        if (!response.ok || data?.success === false) {
            throw new Error(data?.message || data?.error || 'تعذر إكمال الطلب.');
        }
        if (!data || typeof data !== 'object') {
            throw new Error(
                'استجابة الخادم غير صالحة. حدّث الصفحة ثم تحقق من حالة العملية قبل إعادة المحاولة.'
            );
        }
        return data;
    };
})();
