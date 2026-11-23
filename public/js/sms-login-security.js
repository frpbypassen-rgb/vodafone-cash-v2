(() => {
    'use strict';
    const panel = document.querySelector('[data-sms-login]');
    if (!panel) return;
    const find = (selector) => panel.querySelector(selector);
    const passwordForm = find('[data-sms-password]');
    const codeForm = find('[data-sms-code]');
    const message = find('[data-sms-message]');
    let state = {};
    let busy = false;

    const note = (text, error = false) => {
        message.textContent = text;
        message.hidden = !text;
        message.classList.toggle('error', error);
    };
    const render = () => {
        const badge = find('[data-sms-state]');
        const active = state.verified && state.selected;
        const pending = state.stage === 'sms';
        badge.textContent = state.selected && !state.verified ? 'يحتاج تأكيد الرقم'
            : !state.eligible || !state.configured ? 'غير متاح'
            : active ? 'مفعّل للدخول'
                : pending ? 'بانتظار التأكيد'
                    : state.verified ? 'رقم مؤكّد' : 'غير مفعّل';
        badge.classList.toggle('ready', Boolean(active && state.configured));
        find('[data-sms-phone]').textContent = state.phone ? 'رقم الحساب: \u2066' + state.phone + '\u2069' : '';
        passwordForm.hidden = !state.eligible || !state.configured || state.selected || pending;
        codeForm.hidden = !pending || !state.configured;
        if (state.selected && !state.verified)
            note('تغير الرقم المرتبط بالتحقق. تواصل مع الدعم لتحديث طريقة الدخول.');
        else if (!state.eligible)
            note('يلزم رقم مسجّل يبدأ بـ091 أو 092 أو 093 أو 094 ويتبعه سبعة أرقام.');
        else if (!state.configured)
            note('إرسال رسائل SMS غير متاح حاليًا.');
        else if (pending)
            note('أدخل الرمز المرسل إلى رقم حسابك. صالح لمدة خمس دقائق.');
        else if (active)
            note('الرسائل النصية جاهزة لاختيارها عند تسجيل الدخول.');
        else note('');
    };
    const request = async (action = '', body) => {
        const response = await fetch((panel.dataset.base || '/client') + '/api/security/sms-login' + action, {
            method: body ? 'POST' : 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': panel.dataset.csrf },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success)
            throw new Error(data.error || 'تعذر الاتصال. حدّث الصفحة وحاول مجددًا.');
        return data;
    };
    const run = async (task) => {
        if (busy) return;
        busy = true;
        panel.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
            await task();
        } catch (error) {
            note(error.message, true);
        } finally {
            busy = false;
            panel.querySelectorAll('button').forEach(button => { button.disabled = false; });
        }
    };
    const load = async () => {
        state = await request();
        render();
    };
    const act = (action, form, field) => run(async () => {
        const value = form.elements[field].value;
        form.reset();
        const result = await request(action, { [field]: value });
        if (result.stage === 'complete') {
            await load();
            document.dispatchEvent(new Event('login-security-changed'));
        } else {
            state = { ...state, ...result };
            render();
            codeForm.elements.code.focus();
        }
    });
    passwordForm.addEventListener('submit', event => {
        event.preventDefault();
        act('/start', passwordForm, 'password');
    });
    codeForm.addEventListener('submit', event => {
        event.preventDefault();
        act('/confirm', codeForm, 'code');
    });
    codeForm.elements.code.addEventListener('input', event => {
        event.target.value = event.target.value
            .replace(/[٠-٩]/g, char => String(char.charCodeAt(0) - 1632))
            .replace(/[۰-۹]/g, char => String(char.charCodeAt(0) - 1776))
            .replace(/\D/g, '');
    });
    find('[data-sms-restart]').addEventListener('click', () => {
        state.stage = null;
        codeForm.reset();
        render();
        passwordForm.elements.password.focus();
    });
    run(async () => {
        try {
            await load();
        } catch (error) {
            find('[data-sms-state]').textContent = 'تعذر التحقق';
            throw error;
        }
    });
    document.addEventListener('login-security-changed', () => run(load));
})();
