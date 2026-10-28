(() => {
    'use strict';
    const root = document.querySelector('[data-report-email]');
    if (!root) return;
    const panelActive = () => { const panel=root.closest('.bw-settings-panel'); return !document.hidden && (!panel || window.location.hash === '#' + panel.id); };
    let initialized=false;
    const initialize=()=>{ if(initialized || !panelActive()) return; initialized=true;
    const find = key => root.querySelector(`[data-report-email-${key}]`);
    const toggle = find('toggle'), setup = find('setup'), requestForm = find('request'), verifyForm = find('verify');
    const email = requestForm.elements.email, code = verifyForm.elements.code;
    const result = find('result'), sendButton = find('send');
    let status = null, busy = false, cooldownTimer;
    const message = (text, error = false) => { result.textContent = text; result.classList.toggle('is-error', error); };
    const request = async (action = '', data) => {
        const response = await fetch(`/agent-portal/api/report-email${action}`, {
            method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'Accept': 'application/json', ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': window.agentPortal?.csrfToken || '' }) },
            ...(data === undefined ? {} : { body: JSON.stringify({ ...data, revision: status?.revision ?? 0 }) }),
        });
        if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('انتهت الجلسة أو تعذر الاتصال. حدّث الصفحة.');
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تنفيذ الطلب.');
        return payload.data;
    };
    const syncCooldown = () => {
        clearTimeout(cooldownTimer);
        const seconds = Math.max(0, Math.ceil((new Date(status?.resendAt || 0).getTime() - Date.now()) / 1000));
        sendButton.disabled = busy || seconds > 0;
        sendButton.textContent = seconds ? `إعادة الإرسال بعد ${seconds} ثانية` : 'إرسال كود التفعيل';
        if (seconds) cooldownTimer = setTimeout(syncCooldown, 1000);
    };
    const render = data => {
        status = data;
        toggle.checked = data.enabled;
        toggle.disabled = busy;
        find('summary').hidden = !data.verified;
        find('summary').textContent = data.verified ? `البريد مؤكّد: ${data.email} — ${data.enabled ? 'الكشف اليومي مفعّل الساعة 00:05 بتوقيت ليبيا' : 'الإرسال متوقف'}` : '';
        find('actions').hidden = !data.verified;
        find('test').disabled = !data.enabled || busy;
        const deliveryLabels = { sent: 'أُرسل', test_sent: 'أُرسل كشف تجريبي', retrying: 'تعذر الإرسال؛ ستتم إعادة المحاولة', failed: 'تعذر الإرسال بعد المحاولات؛ راجع إعدادات البريد', uncertain: 'تعذر تأكيد التسليم؛ تحقّق من بريدك قبل إعادة الإرسال', cancelled: 'أُلغي الإرسال' };
        find('last').hidden = !data.lastSentAt && !data.lastDeliveryStatus;
        find('last').textContent = `${data.lastSentAt ? 'آخر إرسال: ' + new Date(data.lastSentAt).toLocaleString('ar-LY', { timeZone: 'Africa/Tripoli' }) + ' · ' : ''}${deliveryLabels[data.lastDeliveryStatus] || ''}`;
        if (!data.available) message('إرسال البريد غير مهيأ على الخادم حالياً.', true);
        syncCooldown();
    };
    const perform = async action => {
        if (busy) return;
        busy = true;
        root.querySelectorAll('button, input').forEach(element => { element.disabled = true; });
        message('جارٍ تنفيذ الطلب…');
        try { await action(); }
        catch (error) { try { render(await request()); } catch (_) {} message(error.message, true); }
        finally {
            busy = false;
            root.querySelectorAll('button, input').forEach(element => { element.disabled = false; });
            if (status) { toggle.checked = status.enabled; find('test').disabled = !status.enabled; }
            syncCooldown();
        }
    };
    const openSetup = () => {
        setup.hidden = false;
        email.value = status?.pendingEmail || status?.email || '';
        verifyForm.hidden = !status?.challengeId;
        email.focus();
    };
    toggle.addEventListener('change', () => {
        if (!status) return;
        if (toggle.checked && !status.verified) { toggle.checked = false; openSetup(); return; }
        void perform(async () => {
            render(await request('/preferences', { enabled: toggle.checked }));
            message(status.enabled ? 'تم تفعيل الكشف اليومي.' : 'تم إيقاف إرسال الكشوف.');
        });
    });
    find('change').addEventListener('click', openSetup);
    find('cancel').addEventListener('click', () => { setup.hidden = true; code.value = ''; message(''); });
    requestForm.addEventListener('submit', event => {
        event.preventDefault();
        const address = email.value;
        void perform(async () => {
            render(await request('/request-code', { email: address }));
            verifyForm.hidden = false;
            code.value = '';
            message('أُرسل كود التفعيل. راجع البريد الوارد والبريد غير المرغوب فيه.');
        }).then(() => { if (!verifyForm.hidden) code.focus(); });
    });
    verifyForm.addEventListener('submit', event => {
        event.preventDefault();
        const enteredCode = code.value;
        void perform(async () => {
            render(await request('/verify', { challengeId: status?.challengeId, code: enteredCode }));
            code.value = '';
            setup.hidden = true;
            message('تم تأكيد البريد وتفعيل الكشف اليومي بنجاح.');
        });
    });
    find('test').addEventListener('click', () => { void perform(async () => {
        await request('/test', {});
        render(await request());
        message('تم إرسال الكشف التجريبي إلى بريدك المؤكّد.');
    }); });
    const refreshState = () => { if (panelActive() && !busy && setup.hidden && document.visibilityState === 'visible') request().then(render).catch(() => {}); };
    window.setInterval(refreshState, 15000);
    document.addEventListener('visibilitychange', refreshState);
    window.addEventListener('focus', refreshState);
    window.addEventListener('hashchange', refreshState);
    void perform(async () => { render(await request()); if (status.available) message(''); });
    };
    window.addEventListener('hashchange',initialize);
    document.addEventListener('visibilitychange',initialize);
    initialize();
})();
