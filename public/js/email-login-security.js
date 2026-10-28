(() => {
    'use strict';
    const panel = document.querySelector('[data-email-login]');
    if (!panel) return;
    const find = (selector) => panel.querySelector(selector);
    const passwordForm = find('[data-email-password]'),
        codeForm = find('[data-email-code]');
    const message = (text) => {
        find('[data-email-message]').textContent = text;
        find('[data-email-message]').hidden = !text;
    };
    let busy = false;
    const normalizeCode = (value) =>
        value
            .replace(/[٠-٩]/g, (char) => String(char.charCodeAt(0) - 1632))
            .replace(/[۰-۹]/g, (char) => String(char.charCodeAt(0) - 1776))
            .replace(/[\s-]/g, '');
    codeForm.elements.code.addEventListener('input', () => {
        codeForm.elements.code.value = normalizeCode(codeForm.elements.code.value);
    });
    const request = async (action = '', body) => {
        const response = await fetch(panel.dataset.base + '/api/security/email-login' + action, {
            method: body ? 'POST' : 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'x-csrf-token': panel.dataset.csrf,
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success)
            throw new Error(data.error || 'تعذر الاتصال. حدّث الصفحة وحاول مجددًا.');
        return data;
    };
    const load = async () => {
        const state = await request();
        find('[data-email-state]').textContent = state.enabled
            ? 'مفعّل للدخول'
            : state.verified
              ? 'بريد مؤكّد'
              : 'غير مفعّل';
        find('[data-email-state]').classList.toggle('ready', state.enabled);
        find('[data-email-address]').textContent = state.enabled
            ? 'بريد الدخول: ' + state.email
            : 'بريد التفعيل: ' + (state.targetEmail || 'غير مسجل');
        find('[data-email-profile]').hidden = state.hasEmail || !state.isOwner;
        passwordForm.hidden = !state.hasEmail || !state.canSend || (state.verified && !state.canChangeEmail);
        codeForm.hidden = true;
        if (!state.canSend) message('إرسال البريد غير متاح حاليًا. تواصل مع الإدارة.');
        else if (!state.hasEmail)
            message(
                state.isOwner
                    ? 'أضف بريدًا إلى بيانات الحساب ثم أكّده هنا بكود.'
                    : 'اطلب من الإدارة إضافة بريدك الخاص لحساب الموظف.'
            );
        else
            message(
                state.enabled && !state.verified
                    ? 'الحماية مفعّلة من الإدارة. أكّد كلمة المرور والبريد بكود لإتمام تأكيد البريد من حسابك.'
                    : state.enabled && state.canChangeEmail
                      ? 'تغير بريد بيانات الحساب. أكّد كلمة المرور والبريد الجديد هنا لتغيير بريد الدخول بأمان.'
                      : state.enabled
                        ? 'سيُطلب الكود عند كل تسجيل دخول. الحالة متزامنة مع الإدارة.'
                        : state.verified
                          ? 'البريد مؤكّد. يمكنك اختياره من قائمة قناة كود الدخول أدناه.'
                          : 'أكّد كلمة مرورك ثم أدخل الكود المرسل لتفعيل الحماية.'
            );
    };
    const run = async (task) => {
        if (busy) return;
        busy = true;
        panel.querySelectorAll('button').forEach((node) => {
            node.disabled = true;
        });
        try {
            await task();
        } catch (error) {
            message(error.message);
        } finally {
            busy = false;
            panel.querySelectorAll('button').forEach((node) => {
                node.disabled = false;
            });
        }
    };
    passwordForm.addEventListener('submit', (event) => {
        event.preventDefault();
        run(async () => {
            const password = passwordForm.elements.password.value;
            passwordForm.reset();
            const data = await request('/start', { password });
            passwordForm.hidden = true;
            codeForm.hidden = false;
            message('أرسلنا كودًا إلى ' + data.email + '. صالح لخمس دقائق. إعادة الإرسال بعد دقيقة.');
            codeForm.elements.code.focus();
        });
    });
    codeForm.addEventListener('submit', (event) => {
        event.preventDefault();
        run(async () => {
            const code = codeForm.elements.code.value;
            codeForm.reset();
            await request('/confirm', { code });
            await load();
            document.dispatchEvent(new Event('login-email-verified'));
        });
    });
    find('[data-email-restart]').addEventListener('click', () => {
        codeForm.hidden = true;
        passwordForm.hidden = false;
        passwordForm.elements.password.focus();
    });
    run(async () => {
        try {
            await load();
        } catch (error) {
            find('[data-email-state]').textContent = 'تعذر التحقق';
            throw error;
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !busy && codeForm.hidden && !passwordForm.elements.password.value) run(load);
    });
    document.addEventListener('login-security-changed', () => {
        if (!busy) run(load);
    });
})();
