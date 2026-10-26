(() => {
    'use strict';
    document.querySelectorAll('[data-permission-panel]').forEach(panel => {
        const form = panel.closest('form');
        const mode = panel.querySelector('[data-permission-mode]');
        const options = panel.querySelector('[data-permission-options]');
        const checkboxes = Array.from(options.querySelectorAll('[data-permission-key]'));
        const summary = panel.querySelector('[data-permission-summary]');
        const roleInput = form.querySelector('[data-create-role]');
        const refresh = () => {
            const role = roleInput?.value || panel.dataset.role;
            options.hidden = mode.value !== 'custom';
            checkboxes.forEach(input => {
                const key = input.dataset.permissionKey;
                if (mode.value === 'basic') input.checked = role === 'accountant' ? key === 'canViewAllReports' : key === 'canCreateTransfer';
                input.disabled = input.dataset.grantable !== 'true';
            });
            const selected = checkboxes.filter(input => input.checked).map(input => input.dataset.permissionLabel);
            summary.textContent = selected.length ? 'الصلاحيات: ' + selected.join('، ') + '. بقية الصلاحيات غير مسموحة.' : 'عرض عملياته وتقاريره فقط، دون تنفيذ أو إدارة.';
        };
        mode.addEventListener('change', refresh);
        roleInput?.addEventListener('change', refresh);
        checkboxes.forEach(input => input.addEventListener('change', refresh));
        refresh();
    });
    document.querySelectorAll('[data-permission-edit-form]').forEach(form => {
        const submit = form.querySelector('[type="submit"]');
        const result = form.querySelector('[data-permission-result]');
        const fingerprint = () => Array.from(form.querySelectorAll('[data-permission-key]')).map(input => `${input.dataset.permissionKey}:${input.checked && !input.disabled}`).join('|');
        const initial = fingerprint();
        let busy = false;
        let stale = false;
        const refreshSubmit = () => { submit.disabled = busy || stale || fingerprint() === initial; };
        form.addEventListener('change', () => { if (!stale) result.hidden = true; refreshSubmit(); });
        refreshSubmit();
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (busy || stale || fingerprint() === initial) return;
            busy = true;
            submit.disabled = true;
            result.hidden = false;
            result.textContent = 'جارٍ حفظ الصلاحيات…';
            try {
                const response = await fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'x-csrf-token': window.businessPortal?.csrfToken || '' }, body: new URLSearchParams(new FormData(form)) });
                const payload = await response.json();
                if (response.ok && payload.success) { window.location.assign('/client/staff?staffSuccess=permissions'); return; }
                stale = payload.code === 'changed';
                result.textContent = payload.code === 'changed' ? 'تغيّر الحساب. حدّث الصفحة قبل تعديل الصلاحيات.' : ['permissions','forbidden'].includes(payload.code) ? 'لا تملك صلاحية تنفيذ هذا التعديل أو منح إحدى الصلاحيات.' : 'تعذر تأكيد الحفظ. حدّث الصفحة للتحقق من الصلاحيات.';
            } catch (_) { result.textContent = 'تعذر تأكيد الحفظ. راجع الاتصال وحدّث الصفحة للتحقق.'; }
            finally { busy = false; refreshSubmit(); }
        });
    });
})();
