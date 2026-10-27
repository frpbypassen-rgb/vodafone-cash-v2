(() => {
    'use strict';
    const root = document.querySelector('[data-merchant-integrations]');
    if (!root) return;
    const get = (name) => root.querySelector('[data-mi-' + name + ']');
    const form = get('key-form'),
        secret = get('secret'),
        result = get('result');
    let busy = false;
    const tell = (message, error = false) => {
        result.textContent = message;
        result.classList.toggle('is-error', error);
    };
    const api = async (action = '', body) => {
        const response = await fetch(root.dataset.base + '/api/integrations' + action, {
            method: body ? 'POST' : 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
                Accept: 'application/json',
                ...(body
                    ? {
                          'Content-Type': 'application/json',
                          'X-CSRF-Token': (window.agentPortal || window.businessPortal)?.csrfToken || '',
                      }
                    : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.headers.get('content-type')?.includes('application/json'))
            throw new Error('تعذر الاتصال. حدّث الصفحة.');
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تنفيذ الطلب.');
        return payload.data;
    };
    const sync = async () => {
        const status = await api();
        get('api-state').textContent = status.apiEnabled
            ? status.keyActive
                ? 'نشط'
                : 'المفتاح متوقف'
            : '🔒 غير مفعل';
        get('api-description').textContent = status.apiEnabled
            ? 'تغيير المفتاح يُبطل السابق فورًا. إيقافه يمنع الطلبات حتى إنشاء مفتاح جديد.'
            : 'تحتاج خدمة API إلى تفعيل من الإدارة.';
        form.hidden = !status.apiEnabled;
        if (!status.apiEnabled) {
            secret.value = '';
            get('secret-box').hidden = true;
            form.reset();
        }
        get('key-meta').textContent = status.keyHint
            ? 'آخر أحرف المفتاح: …' +
              status.keyHint +
              (status.keyCreatedAt ? ' · ' + new Date(status.keyCreatedAt).toLocaleDateString('ar-LY') : '')
            : 'لم يتم إنشاء مفتاح حالي.';
        get('rotate').textContent = status.keyActive ? 'تغيير المفتاح' : 'إنشاء مفتاح';
        get('revoke').hidden = !status.keyActive;
        get('webhook-state').textContent = status.webhooksEnabled ? 'مفعل' : '🔒 غير مفعل';
        get('webhook-description').textContent = status.webhooksEnabled
            ? 'إعداد الرابط والأحداث ومفتاح التوقيع ومراجعة سجل التسليم.'
            : 'تحتاج Webhooks إلى تفعيل من الإدارة.';
        get('webhook-link').hidden = !status.webhooksEnabled;
    };
    const mutate = async (action) => {
        if (busy || !form.reportValidity()) return;
        if (
            !window.confirm(
                action === '/rotate'
                    ? 'سيتم إيقاف المفتاح القديم فورًا. متابعة؟'
                    : 'إيقاف المفتاح الحالي ومنع طلباته؟'
            )
        )
            return;
        busy = true;
        root.querySelectorAll('button').forEach((button) => {
            button.disabled = true;
        });
        secret.value = '';
        get('secret-box').hidden = true;
        try {
            const data = await api(action, { currentPassword: form.elements.currentPassword.value });
            form.reset();
            if (data.token) {
                secret.value = data.token;
                get('secret-box').hidden = false;
            }
            tell(data.token ? 'تم إصدار المفتاح الجديد وإبطال السابق.' : 'تم إيقاف المفتاح.');
            await sync();
        } catch (error) {
            tell(error.message, true);
        } finally {
            form.elements.currentPassword.value = '';
            busy = false;
            root.querySelectorAll('button').forEach((button) => {
                button.disabled = false;
            });
        }
    };
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        mutate('/rotate');
    });
    get('revoke').addEventListener('click', () => mutate('/revoke'));
    get('copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(secret.value);
            tell('تم نسخ المفتاح.');
        } catch (_) {
            secret.focus();
            secret.select();
            tell('حدد المفتاح وانسخه.');
        }
    });
    get('refresh').addEventListener('click', () => sync().catch((error) => tell(error.message, true)));
    // Refresh administrative gates while this panel is in use. Enforcement
    // remains on the server even before the next display refresh.
    window.setInterval(() => {
        if (!busy && document.visibilityState === 'visible' && !root.closest('.bw-settings-panel')?.hidden)
            sync().catch(() => {});
    }, 15000);
    window.addEventListener('pagehide', () => {
        secret.value = '';
        get('secret-box').hidden = true;
        form.reset();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) sync().catch(() => {}); });
    window.addEventListener('focus', () => { if (!busy) sync().catch(() => {}); });
    sync().catch((error) => tell(error.message, true));
})();
