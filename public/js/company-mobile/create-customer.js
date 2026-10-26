(() => {
    'use strict';
    const form = document.querySelector('.agent-create-form[data-create-kind]');
    if (!form) return;
    const dialog = form.closest('dialog');
    const submit = form.querySelector('[data-create-submit]');
    const result = form.querySelector('[data-create-result]');
    const toggle = form.querySelector('[data-create-password]');
    const fields = Array.from(form.querySelectorAll('input[name]:not([type="hidden"]):not([type="checkbox"]), select[name]'));
    const isStaff = form.dataset.createKind === 'staff';
    const submitLabel = isStaff ? 'إنشاء حساب الموظف' : 'إنشاء حساب العميل';
    let busy = false;
    const messages = {
        name: 'اكتب اسمًا من 3 أحرف على الأقل.', phone: 'اكتب رقم هاتف من 8 إلى 15 رقمًا، ويمكن أن يبدأ بعلامة +.',
        webUsername: 'استخدم 3 إلى 40 حرفًا إنجليزيًا أو رقمًا أو شرطة سفلية.', webPassword: 'استخدم كلمة مرور من 8 إلى 128 حرفًا.',
        marginPiasters: 'اكتب عددًا صحيحًا من 0 إلى 500.', creditLimit: 'اكتب مبلغًا موجبًا أو صفرًا، بحد أقصى 3 منازل عشرية.', role: 'اختر موظف تنفيذ أو محاسب.'
    };
    const errorFor = (field, message) => {
        const error = form.querySelector(`[data-create-error="${field.name}"]`);
        if (!error) return;
        error.textContent = message;
        error.hidden = !message;
        field.setAttribute('aria-invalid', message ? 'true' : 'false');
        if (message) { const details = field.closest('details'); if (details) details.open = true; }
    };
    const focusError = () => form.querySelector('[aria-invalid="true"]')?.focus();
    const roleDescription = form.querySelector('[data-create-role-description]');
    const updateRole = () => {
        if (!roleDescription) return;
        roleDescription.textContent = form.elements.role.value === 'accountant'
            ? 'محاسب دون تنفيذ تحويلات، وتُضبط بقية صلاحياته من القسم أدناه.'
            : 'تُضبط صلاحيات التنفيذ والعرض والإدارة من القسم أدناه.';
    };
    form.querySelector('[data-create-role]')?.addEventListener('change', updateRole);
    fields.forEach(field => field.addEventListener('input', () => { errorFor(field, ''); result.hidden = true; }));
    toggle.addEventListener('click', () => {
        const password = form.elements.webPassword;
        const show = password.type === 'password';
        password.type = show ? 'text' : 'password';
        toggle.textContent = show ? 'إخفاء' : 'إظهار';
        toggle.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
        toggle.setAttribute('aria-pressed', String(show));
    });
    dialog.addEventListener('close', () => {
        form.elements.webPassword.type = 'password';
        toggle.textContent = 'إظهار';
        toggle.setAttribute('aria-label', 'إظهار كلمة المرور');
        toggle.setAttribute('aria-pressed', 'false');
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        ['name', 'phone', 'webUsername'].forEach(name => { form.elements[name].value = form.elements[name].value.trim(); });
        let valid = true;
        fields.forEach(field => { const message = field.checkValidity() ? '' : messages[field.name] || 'راجع هذا الحقل.'; errorFor(field, message); if (message) valid = false; });
        if (!valid) { focusError(); return; }
        busy = true;
        submit.disabled = true;
        submit.textContent = 'جارٍ إنشاء الحساب…';
        result.hidden = true;
        try {
            const response = await fetch(form.action, {
                method: 'POST', credentials: 'same-origin',
                headers: { Accept: 'application/json', 'x-csrf-token': window.businessPortal?.csrfToken || '' },
                body: new URLSearchParams(new FormData(form))
            });
            const payload = await response.json();
            if (response.ok && payload.success) {
                form.reset();
                dialog.close();
                window.location.assign(isStaff ? '/client/staff?staffSuccess=created' : '/client/customers?customerSuccess=created');
                return;
            }
            if (payload.code === 'duplicate') {
                errorFor(form.elements.phone, 'رقم الهاتف أو اسم المستخدم مستخدم مسبقًا.');
                errorFor(form.elements.webUsername, 'اسم المستخدم أو رقم الهاتف مستخدم مسبقًا.');
            } else if (isStaff && payload.code === 'username') errorFor(form.elements.webUsername, 'اسم المستخدم مستخدم مسبقًا.');
            else if (payload.code === 'username' || payload.code === 'username_format') errorFor(form.elements.webUsername, messages.webUsername);
            else if (payload.code === 'password') errorFor(form.elements.webPassword, messages.webPassword);
            else if (payload.code === 'permissions') { result.textContent = 'لا يمكنك منح صلاحية لا تملكها. راجع الاختيارات.'; result.hidden = false; form.querySelector('[data-permission-panel]')?.setAttribute('open', ''); }
            else if (payload.code === 'credit_limit') errorFor(form.elements.creditLimit, messages.creditLimit);
            else {
                result.textContent = payload.code === 'forbidden' ? 'لا تملك صلاحية إنشاء هذا الحساب.' : ['invalid', 'missing'].includes(payload.code) ? 'راجع البيانات الأساسية وكلمة المرور.' : 'تعذر تأكيد إنشاء الحساب. راجع قائمة الحسابات قبل إعادة المحاولة.';
                result.hidden = false;
            }
            focusError();
        } catch (_) {
            result.textContent = 'تعذر تأكيد إنشاء الحساب. راجع الاتصال وقائمة الحسابات قبل إعادة المحاولة.';
            result.hidden = false;
        } finally {
            busy = false;
            submit.disabled = false;
            submit.textContent = submitLabel;
        }
    });
})();
