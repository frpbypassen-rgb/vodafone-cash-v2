(function () {
    'use strict';

    const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

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
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) {
            window.location.assign('/login');
            throw new Error('انتهت جلسة الدخول.');
        }
        if (!response.ok || data.success === false) {
            throw new Error(data.message || data.error || 'تعذر إكمال الطلب.');
        }
        return data;
    };
})();
