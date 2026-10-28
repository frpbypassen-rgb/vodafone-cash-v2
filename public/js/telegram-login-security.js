(() => {
    'use strict';
    const panel = document.querySelector('[data-telegram-login]');
    if (!panel) return;
    const find = (selector) => panel.querySelector(selector);
    const linkForm = find('[data-tg-password]'),
        codeForm = find('[data-tg-code]'),
        channelForm = find('[data-channel-password]'),
        channelCode = find('[data-channel-code]');
    let busy = false,
        timer,
        linkUrl = '',
        state;
    const message = (text, error = false) => {
        const node = find('[data-tg-message]');
        node.textContent = text;
        node.hidden = !text;
        node.classList.toggle('error', error);
    };
    const request = async (action = '', body) => {
        const response = await fetch(panel.dataset.base + '/api/security/telegram-login' + action, {
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
            throw new Error(data.error || 'تعذر إكمال الطلب. حدّث الصفحة وحاول مجددًا.');
        return data;
    };
    const schedule = () => {
        clearTimeout(timer);
        if (!document.hidden && state && ['waiting', 'sending'].includes(state.stage))
            timer = setTimeout(async () => {
                if (busy) return schedule();
                try {
                    await load();
                } catch (error) {
                    message(error.message, true);
                }
            }, 3000);
    };
    const load = async () => {
        const previousSelected = state?.selected;
        state = await request();
        find('[data-tg-state]').textContent = state.linked
            ? 'مرتبط ومؤكد'
            : state.stage
              ? 'بانتظار التأكيد'
              : 'غير مرتبط';
        find('[data-tg-state]').classList.toggle('ready', state.linked);
        find('[data-tg-account]').textContent = state.accountLabel
            ? 'الحساب: \u2066' + state.accountLabel + '\u2069'
            : '';
        linkForm.querySelector('button[type="submit"]').textContent = state.linked
            ? 'تغيير حساب تليجرام المرتبط'
            : 'متابعة ربط تليجرام';
        const waiting = ['waiting', 'sending', 'delivered'].includes(state.stage);
        linkForm.hidden = !state.configured || waiting || (state.linked && state.selected === 'telegram');
        codeForm.hidden = state.stage !== 'delivered';
        find('[data-tg-restart]').hidden = !state.stage;
        find('[data-tg-open]').hidden = !linkUrl || !['waiting', 'sending'].includes(state.stage);
        find('[data-channel-state]').textContent =
            'القناة الحالية: ' +
            ({ email: 'البريد الإلكتروني', telegram: 'تليجرام', off: 'غير مفعّلة' }[state.selected] ||
                'غير مفعّلة');
        channelForm.elements.target.querySelector('[value=email]').disabled = !state.emailReady;
        channelForm.elements.target.querySelector('[value=telegram]').disabled = !state.telegramReady;
        channelForm.hidden = !state.emailReady && !state.telegramReady;
        if (previousSelected !== state.selected || !channelForm.elements.password.value)
            channelForm.elements.target.value =
                state.selected === 'email' && state.emailReady
                    ? 'email'
                    : state.selected === 'telegram' && state.telegramReady
                      ? 'telegram'
                      : state.emailReady
                        ? 'email'
                        : 'telegram';
        find('[data-tg-unlink]').hidden = !state.linked || state.selected === 'telegram';
        if (!state.configured)
            message('التحقق بتليجرام غير متاح حاليًا. تواصل مع الإدارة لتجهيز بوت أكواد الدخول.');
        else if (state.stage === 'delivered')
            message('وصل كود تأكيد الربط إلى البوت. أدخله هنا لإكمال التفعيل.');
        else if (state.stage === 'send_failed')
            message('تعذر إرسال كود الربط. ابدأ ربطًا جديدًا بعد دقيقة.', true);
        else if (waiting) message('افتح تليجرام واضغط «ابدأ»، ثم ارجع لكتابة كود تأكيد الربط.');
        else
            message(
                state.linked && state.selected === 'telegram'
                    ? 'تليجرام هو قناة كود الدخول الحالية. سيصلك الكود عند كل تسجيل دخول.'
                    : state.linked
                      ? 'الربط مؤكّد. لاستقبال أكواد الدخول عبره اختر تليجرام أدناه.'
                      : 'أكّد كلمة المرور لفتح رابط ربط مؤقت.'
            );
        schedule();
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
            message(error.message, true);
        } finally {
            busy = false;
            panel.querySelectorAll('button').forEach((node) => {
                node.disabled = false;
            });
        }
    };
    const changed = () => {
        document.dispatchEvent(new Event('login-security-changed'));
    };
    linkForm.addEventListener('submit', (event) => {
        event.preventDefault();
        run(async () => {
            const password = linkForm.elements.password.value;
            linkForm.reset();
            const result = await request('/start', { password });
            const url = new URL(result.url);
            if (
                url.protocol !== 'https:' ||
                url.hostname !== 't.me' ||
                url.username ||
                url.password ||
                !/^\/[A-Za-z0-9_]+$/.test(url.pathname)
            )
                throw new Error('رابط الربط غير صالح.');
            linkUrl = url.href;
            find('[data-tg-open]').href = linkUrl;
            await load();
        });
    });
    codeForm.addEventListener('submit', (event) => {
        event.preventDefault();
        run(async () => {
            const code = codeForm.elements.code.value;
            codeForm.reset();
            await request('/confirm', { code });
            linkUrl = '';
            await load();
            changed();
        });
    });
    find('[data-tg-restart]').addEventListener('click', () => {
        clearTimeout(timer);
        linkUrl = '';
        find('[data-tg-open]').hidden = true;
        codeForm.hidden = true;
        linkForm.hidden = false;
        linkForm.elements.password.focus();
        message('أدخل كلمة المرور لبدء ربط جديد. يمكن إعادة الطلب بعد دقيقة من الطلب السابق.');
    });
    const changeChannel = async (target) => {
        const password = channelForm.elements.password.value;
        channelForm.elements.password.value = '';
        const result = await request('/channel', { password, target });
        if (result.requiresCode) {
            channelForm.hidden = true;
            channelCode.hidden = false;
            message(
                'أرسلنا كودًا إلى ' +
                    (result.source === 'telegram' ? 'تليجرام الحالي' : 'البريد الحالي') +
                    ' لتأكيد التغيير.'
            );
            channelCode.elements.code.focus();
        } else {
            channelCode.hidden = true;
            await load();
            changed();
        }
    };
    channelForm.addEventListener('submit', (event) => {
        event.preventDefault();
        run(() => changeChannel(channelForm.elements.target.value));
    });
    find('[data-tg-unlink]').addEventListener('click', () => {
        if (channelForm.reportValidity()) run(() => changeChannel('unlink'));
    });
    channelCode.addEventListener('submit', (event) => {
        event.preventDefault();
        run(async () => {
            const code = channelCode.elements.code.value;
            channelCode.reset();
            await request('/channel/confirm', { code });
            channelCode.hidden = true;
            await load();
            changed();
        });
    });
    for (const form of [codeForm, channelCode])
        form.elements.code.addEventListener('input', () => {
            form.elements.code.value = form.elements.code.value
                .replace(/[٠-٩]/g, (char) => String(char.charCodeAt(0) - 1632))
                .replace(/[۰-۹]/g, (char) => String(char.charCodeAt(0) - 1776))
                .replace(/[\s-]/g, '');
        });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) clearTimeout(timer);
        else if (
            !busy &&
            channelCode.hidden &&
            !linkForm.elements.password.value &&
            !channelForm.elements.password.value
        )
            run(load);
    });
    document.addEventListener('login-email-verified', () => {
        if (!busy) run(load);
    });
    run(async () => {
        try {
            await load();
        } catch (error) {
            find('[data-tg-state]').textContent = 'تعذر التحقق';
            throw error;
        }
    });
})();
