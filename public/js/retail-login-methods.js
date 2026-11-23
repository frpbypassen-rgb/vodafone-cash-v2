(() => {
    'use strict';
    const panel = document.querySelector('[data-retail-login-methods]');
    if (!panel) return;
    const find = selector => panel.querySelector(selector);
    const titles = { email: 'البريد الإلكتروني', telegram: 'تليجرام', sms: 'SMS', authenticator: 'تطبيق المصادقة' };
    const preferences = find('[data-retail-preferences]');
    const preferenceForm = find('[data-retail-preference-form]');
    const feedback = find('[data-retail-method-status]');
    const dialog = find('[data-retail-disable-dialog]');
    const disableForm = find('[data-retail-disable-form]');
    const disableError = find('[data-retail-disable-error]');
    const warning = find('[data-retail-disable-warning]');
    let enabled = [];
    let target = '';
    const note = (element, text) => {
        element.textContent = text;
        element.hidden = !text;
    };
    const request = async body => {
        const response = await fetch((panel.dataset.base || '/client') + '/api/security/login-methods', {
            method: body ? 'POST' : 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': panel.dataset.csrf },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success)
            throw new Error(data.error || 'تعذر تحديث طرق التحقق. حاول مجددًا.');
        return data;
    };
    const render = data => {
        enabled = data.enabled;
        preferences.hidden = !enabled.length && feedback.hidden;
        preferenceForm.hidden = enabled.length === 0;
        const select = preferenceForm.elements.method;
        select.replaceChildren(new Option('بدون تفضيل', ''), ...enabled.map(method => new Option(titles[method], method)));
        select.value = enabled.includes(data.preferred) ? data.preferred : '';
        panel.querySelectorAll('[data-retail-disable-method]').forEach(button => {
            button.hidden = !enabled.includes(button.dataset.retailDisableMethod);
        });
    };
    const load = () => request().then(render).catch(error => {
        preferences.hidden = false;
        preferenceForm.hidden = true;
        note(feedback, error.message);
    });
    preferenceForm.addEventListener('submit', async event => {
        event.preventDefault();
        const submit = preferenceForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
            render(await request({ action: 'prefer', method: preferenceForm.elements.method.value }));
            note(feedback, 'تم حفظ التفضيل.');
        } catch (error) {
            note(feedback, error.message);
        } finally {
            submit.disabled = false;
        }
    });
    panel.querySelectorAll('[data-retail-disable-method]').forEach(button => {
        button.addEventListener('click', () => {
            target = button.dataset.retailDisableMethod;
            find('[data-retail-disable-title]').textContent = 'إيقاف التحقق عبر ' + titles[target];
            warning.hidden = enabled.length !== 1;
            note(disableError, '');
            disableForm.reset();
            dialog.showModal();
        });
    });
    find('[data-retail-disable-cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => disableForm.reset());
    disableForm.addEventListener('submit', async event => {
        event.preventDefault();
        const submit = disableForm.querySelector('button[type="submit"]');
        const password = disableForm.elements.password.value;
        submit.disabled = true;
        disableForm.reset();
        try {
            const data = await request({ action: 'disable', method: target, password, confirmLast: !warning.hidden });
            dialog.close();
            note(feedback, 'تم إيقاف طريقة التحقق.');
            render(data);
            document.dispatchEvent(new Event('login-security-changed'));
        } catch (error) {
            note(disableError, error.message);
        } finally {
            submit.disabled = false;
        }
    });
    for (const event of ['login-email-verified', 'login-security-changed'])
        document.addEventListener(event, load);
    load();
})();
