(() => {
    'use strict';
    const root = document.querySelector('[data-agent-telegram]');
    if (!root) return;
    const find = name => root.querySelector('[data-telegram-' + name + ']');
    const list = find('list'), setup = find('setup'), addForm = find('add-form'), result = find('result');
    let state = null, pending = null, busy = false, pollTimer, editingId = null;
    const tell = (text, error = false) => { result.textContent = text; result.classList.toggle('is-error', error); };
    const api = async (path = '', body) => {
        const response = await fetch('/client/api/telegram' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': window.businessPortal?.csrfToken || '' }) }, ...(body === undefined ? {} : { body: JSON.stringify({ ...body, revision: state?.connections?.find(row => row.id === decodeURIComponent(path.split('/')[2] || body?.id || ''))?.revision }) }) });
        if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('انتهت الجلسة. حدّث الصفحة.');
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تنفيذ طلب تيليجرام.');
        return payload.data;
    };
    const element = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
    const actionButton = (action, label, id, className = '') => {
        const button = element('button', label, 'bw-button ghost ' + className);
        button.type = 'button'; button.dataset.telegramAction = action; button.dataset.connectionId = id;
        return button;
    };
    const date = value => new Date(value).toLocaleString('ar-LY', { timeZone: 'Africa/Tripoli' });
    const render = data => {
        state = data;
        const rows = Array.isArray(data.connections) ? data.connections : [];
        find('status').textContent = !data.available ? 'الربط الفعلي يتطلب تهيئة بوت Ahrampay_bot على الخادم.' : rows.length ? 'تصل الإيصالات إلى الحسابات المفعّلة فقط.' : 'لا توجد حسابات تيليجرام مرتبطة بعد.';
        list.replaceChildren();
        rows.forEach(row => {
            const card = element('article', '', 'agent-telegram-card'); card.dataset.telegramConnectionId = row.id;
            const header = element('div', '', 'agent-telegram-card-header'), identity = element('div');
            identity.append(element('h4', row.name));
            const account = element('p', row.username ? '@' + row.username : row.telegramName || row.chatHint);
            if (row.username) account.dir = 'ltr';
            identity.append(account); header.append(identity);
            if (row.linked) {
                const label = element('label', '', 'agent-telegram-card-toggle'), toggle = element('input');
                toggle.type = 'checkbox'; toggle.checked = row.enabled; toggle.dataset.telegramAction = 'toggle'; toggle.dataset.connectionId = row.id;
                toggle.setAttribute('aria-label', 'استقبال الإيصالات: ' + row.name);
                label.append(toggle, element('span', row.enabled ? 'مفعّل' : 'متوقف')); header.append(label);
            }
            card.append(header);
            if (row.linked) {
                const dates = element('div', '', 'agent-telegram-dates');
                if (row.linkedAt) dates.append(element('span', 'تاريخ الربط: ' + date(row.linkedAt)));
                if (row.lastInteractionAt) dates.append(element('span', 'آخر تفاعل مع البوت: ' + date(row.lastInteractionAt)));
                card.append(dates);
            } else card.append(element('span', row.status === 'expired' ? 'انتهت صلاحية الرابط' : 'بانتظار التفعيل', 'agent-telegram-state'));
            const actions = element('div', '', 'agent-email-actions');
            actions.append(actionButton('rename', 'تعديل الاسم', row.id));
            actions.append(row.linked ? actionButton('test', 'رسالة اختبار', row.id) : actionButton('link', 'إصدار رابط تفعيل', row.id));
            actions.append(actionButton('remove', row.linked ? 'حذف الربط' : 'حذف', row.id, 'agent-telegram-remove'));
            card.append(actions);
            const form = element('form', '', 'agent-telegram-rename'); form.dataset.telegramRename = row.id; form.hidden = true;
            const label = element('label', '', 'bw-field'), input = element('input'); input.type = 'text'; input.name = 'name'; input.maxLength = 60; input.required = true; input.value = row.name;
            label.append(element('span', 'اسم الحساب'), input);
            const save = element('button', 'حفظ الاسم', 'bw-button secondary'); save.type = 'submit';
            form.append(label, save, actionButton('cancel-rename', 'إلغاء', row.id)); card.append(form); list.append(card);
        });
        if (pending) {
            const row = rows.find(item => item.id === pending.id);
            if (!row || row.linked || Date.now() >= new Date(pending.expiresAt).getTime()) {
                setup.hidden = true; pending = null; find('code').value = ''; find('open').removeAttribute('href'); clearTimeout(pollTimer);
            }
        }
    };
    const perform = async action => {
        if (busy) return;
        busy = true; root.querySelectorAll('button, input').forEach(node => { node.disabled = true; }); tell('جارٍ تنفيذ الطلب…');
        try { await action(); } catch (error) { editingId = null; try { render(await api()); } catch (_) {} tell(error.message, true); }
        finally { busy = false; root.querySelectorAll('button, input').forEach(node => { node.disabled = false; }); }
    };
    const poll = async () => {
        clearTimeout(pollTimer);
        if (!pending || document.hidden) return;
        if (!busy && !editingId) {
            try { render(await api()); if (!pending) tell('تم تحديث حالة الربط.'); } catch (_) { /* Manual refresh reports errors. */ }
        }
        if (pending) pollTimer = setTimeout(poll, 5000);
    };
    const showLink = data => {
        render(data); pending = { id: data.connectionId, expiresAt: data.expiresAt };
        find('pending-name').textContent = data.connections.find(row => row.id === data.connectionId)?.name || '';
        find('code').value = data.code; find('open').href = data.botUrl; setup.hidden = false; addForm.hidden = true;
        tell('الرابط جاهز. افتح تيليجرام واضغط Start للتفعيل.'); clearTimeout(pollTimer); pollTimer = setTimeout(poll, 5000);
    };
    find('add').addEventListener('click', () => { addForm.hidden = false; addForm.elements.name.focus(); });
    find('cancel').addEventListener('click', () => { addForm.hidden = true; });
    root.addEventListener('submit', event => {
        const form = event.target; if (form !== addForm && !form.hasAttribute('data-telegram-rename')) return;
        event.preventDefault(); const name = form.elements.name.value;
        if (form === addForm) { void perform(async () => { showLink(await api('/link', { name })); form.reset(); }); return; }
        const id = form.dataset.telegramRename;
        void perform(async () => { const data = await api('/connections/' + encodeURIComponent(id) + '/name', { name }); editingId = null; render(data); tell('تم حفظ الاسم.'); });
    });
    root.addEventListener('change', event => {
        const input = event.target; if (input.dataset.telegramAction !== 'toggle') return;
        const enabled = input.checked, id = input.dataset.connectionId;
        void perform(async () => { render(await api('/connections/' + encodeURIComponent(id) + '/preferences', { enabled })); tell(enabled ? 'تم تفعيل استقبال الإيصالات لهذا الحساب.' : 'تم إيقاف استقبال الإيصالات لهذا الحساب فقط.'); }).then(() => { if (state) render(state); });
    });
    root.addEventListener('click', event => {
        const button = event.target.closest('[data-telegram-action]'); if (!button) return;
        const action = button.dataset.telegramAction, id = button.dataset.connectionId;
        if (action === 'toggle') return;
        const card = button.closest('.agent-telegram-card'), form = card.querySelector('[data-telegram-rename]');
        if (action === 'rename') { editingId = id; form.hidden = false; form.elements.name.focus(); return; }
        if (action === 'cancel-rename') { editingId = null; form.hidden = true; return; }
        void perform(async () => {
            if (action === 'link') { showLink(await api('/connections/' + encodeURIComponent(id) + '/link', {})); return; }
            const data = await api('/connections/' + encodeURIComponent(id) + '/' + action, {});
            editingId = null; render(data); tell(action === 'test' ? 'تم إرسال رسالة الاختبار لهذا الحساب.' : 'تم حذف الربط المحدد.');
        });
    });
    find('check').addEventListener('click', () => { void perform(async () => { render(await api()); tell(pending ? 'لم يكتمل التفعيل بعد. اضغط Start في تيليجرام.' : 'تم تحديث الحسابات المرتبطة.'); }); });
    find('copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(find('code').value); tell('تم نسخ الكود.'); }
        catch (_) { find('code').select(); tell('حدّد الكود وانسخه يدويًا.'); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(pollTimer); else void poll(); });
    window.addEventListener('pagehide', () => clearTimeout(pollTimer));
    const refreshState = () => { if (!busy && !editingId && addForm.hidden && !document.hidden) api().then(render).catch(() => {}); };
    window.setInterval(refreshState, 15000);
    window.addEventListener('focus', refreshState);
    document.addEventListener('visibilitychange', refreshState);
    void perform(async () => { render(await api()); tell(''); });
})();
