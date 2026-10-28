(() => {
    'use strict';
    const root = document.querySelector('[data-merchant-integrations]');
    if (!root) return;
    const get = (name) => root.querySelector('[data-mi-' + name + ']');
    let loading = false;
    const sync = async () => {
        if (loading) return;
        loading = true;
        get('refresh').disabled = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(
                root.dataset.base + '/api/integrations',
                {
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                    signal: controller.signal,
                },
            );
            if (
                response.redirected ||
                !response.headers
                    .get('content-type')
                    ?.includes('application/json')
            )
                throw new Error();
            const payload = await response.json();
            if (!response.ok || !payload.success) throw new Error();
            const status = payload.data;
            get('api-state').textContent = status.apiEnabled
                ? status.keyActive
                    ? 'نشط'
                    : 'بدون مفتاح نشط'
                : '🔒 غير مفعل';
            get('api-description').textContent = status.apiEnabled
                ? 'إدارة المفتاح ودليل الربط وآخر عمليات API.'
                : 'تحتاج خدمة API إلى تفعيل من الإدارة.';
            get('api-link').hidden = !status.apiEnabled;
            get('key-meta').textContent = status.keyHint
                ? 'آخر أحرف المفتاح: …' + status.keyHint
                : '';
            get('webhook-state').textContent = status.webhooksEnabled
                ? 'مفعل'
                : '🔒 غير مفعل';
            get('webhook-description').textContent = status.webhooksEnabled
                ? 'إعداد الرابط والأحداث ومفتاح التوقيع ومراجعة سجل التسليم.'
                : 'تحتاج Webhooks إلى تفعيل من الإدارة.';
            get('webhook-link').hidden = !status.webhooksEnabled;
            get('result').textContent = '';
        } catch {
            get('result').textContent = 'تعذر تحديث الحالة. أعد المحاولة.';
            get('result').classList.add('is-error');
            get('api-link').hidden = true;
            get('webhook-link').hidden = true;
        } finally {
            clearTimeout(timer);
            loading = false;
            get('refresh').disabled = false;
        }
    };
    get('refresh').addEventListener('click', sync);
    window.setInterval(() => {
        if (
            document.visibilityState === 'visible' &&
            !root.closest('.bw-settings-panel')?.hidden
        )
            sync();
    }, 15000);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) sync();
    });
    sync();
})();
