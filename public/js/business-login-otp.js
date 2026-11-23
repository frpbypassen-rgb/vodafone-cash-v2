(() => {
    'use strict';
    const panel = document.querySelector('[data-business-otp]');
    if (!panel) return;
    panel.querySelector('[data-otp-theme]').addEventListener('click', () => {
        const light = document.documentElement.dataset.theme !== 'light';
        document.documentElement.dataset.theme = light ? 'light' : 'dark';
        try {
            localStorage.setItem('ahram_theme', light ? 'light' : 'dark');
        } catch (_) {
            /* Theme remains usable without storage. */
        }
        panel.querySelector('[data-otp-theme]').textContent = light ? '☾' : '☀';
        panel
            .querySelector('[data-otp-theme]')
            .setAttribute('aria-label', light ? 'تفعيل الوضع الليلي' : 'تفعيل الوضع النهاري');
    });
    const find = (selector) => panel.querySelector(selector),
        digits = [...panel.querySelectorAll('[data-otp-digit]')];
    let screen = JSON.parse(document.getElementById('businessOtpScreen').textContent),
        selected,
        busy = false,
        useRecovery = false;
    const normalize = (value) =>
        String(value)
            .replace(/[٠-٩]/g, (char) => String(char.charCodeAt(0) - 1632))
            .replace(/[۰-۹]/g, (char) => String(char.charCodeAt(0) - 1776))
            .replace(/\D/g, '');
    const note = (text, success = false) => {
        const node = find('[data-otp-message]');
        node.textContent = text;
        node.hidden = !text;
        node.classList.toggle('success', success);
    };
    const remaining = (value) =>
        value ? Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 1000)) : 0;
    const syncCode = () => {
        find('[data-otp-value]').value = useRecovery
            ? find('[data-otp-recovery]').value.trim()
            : digits.map((input) => normalize(input.value)).join('');
        tick();
    };
    const clearCode = () => {
        digits.forEach((input) => {
            input.value = '';
        });
        find('[data-otp-value]').value = '';
    };
    const tick = () => {
        if (screen.sessionExpiresAt && !remaining(screen.sessionExpiresAt) && screen.stage !== 'blocked') {
            screen.stage = 'blocked';
            render();
            return;
        }
        const cooldown = remaining(screen.resendAt),
            expires = remaining(screen.expiresAt);
        const canSendCode = selected && selected !== 'authenticator';
        find('[data-otp-send]').textContent = selected === 'authenticator' ? 'متابعة إلى رمز التطبيق' : 'إرسال الكود';
        find('[data-otp-send]').disabled = busy || !selected || (canSendCode && cooldown > 0) || screen.stage === 'blocked';
        find('[data-otp-send-note]').textContent = canSendCode && cooldown ? `يمكن الإرسال بعد ${cooldown} ثانية` : '';
        find('[data-otp-resend]').disabled = busy || cooldown > 0;
        find('[data-otp-resend]').textContent = cooldown
            ? `إعادة الإرسال بعد ${cooldown} ثانية`
            : 'إعادة الإرسال';
        find('[data-otp-change]').disabled = busy;
        find('[data-otp-confirm]').disabled =
            busy || screen.stage !== 'sent' || !expires || (useRecovery
                ? !/^[a-f0-9]{5}-?[a-f0-9]{5}$/i.test(find('[data-otp-recovery]').value.trim())
                : find('[data-otp-value]').value.length !== 6);
        find('[data-otp-expiry]').textContent =
            screen.stage === 'sent'
                ? expires
                    ? `صلاحية الكود ${Math.floor(expires / 60)}:${String(expires % 60).padStart(2, '0')}`
                    : 'انتهت مهلة التحقق. اختر الطريقة مجددًا.'
                : '';
    };
    const render = () => {
        const blocked = screen.stage === 'blocked';
        selected =
            screen.selected ||
            (screen.methods.some((item) => item.key === screen.preferred && item.available)
                ? screen.preferred
                : screen.methods.filter((item) => item.available).length === 1
                  ? screen.methods.find((item) => item.available).key
                  : null);
        find('[data-otp-choose]').hidden = blocked || ['sent', 'sending'].includes(screen.stage);
        find('[data-otp-form]').hidden = screen.stage !== 'sent';
        find('[data-otp-restart]').hidden = !blocked;
        const chosen = screen.methods.find((item) => item.key === screen.selected);
        find('[data-otp-title]').textContent = blocked
            ? 'انتهت محاولة الدخول'
            : screen.stage === 'sent'
              ? 'أدخل رمز التحقق'
              : 'اختر طريقة التحقق';
        find('[data-otp-description]').textContent = blocked
            ? 'ابدأ تسجيل الدخول من جديد لإكمال التحقق بأمان.'
            : chosen && screen.stage === 'sent'
              ? chosen.key === 'authenticator' ? 'أدخل الرمز الظاهر في تطبيق المصادقة.' : 'أرسلنا الكود إلى \u2066' + chosen.destination + '\u2069'
              : screen.methods.some((item) => item.available)
                ? 'أكمل الدخول بإحدى الطرق المتاحة.'
                : 'لا توجد طريقة تحقق متاحة حاليًا. تواصل مع الإدارة.';
        const list = find('[data-otp-methods]');
        list.replaceChildren();
        const orderedMethods = [...screen.methods].sort((a, b) =>
            Number(b.key === screen.preferred) - Number(a.key === screen.preferred));
        for (const method of orderedMethods) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'otp-method';
            button.disabled = !method.available;
            button.setAttribute('aria-pressed', String(selected === method.key));
            const title = document.createElement('strong');
            title.textContent = method.title;
            const destination = document.createElement('small');
            destination.textContent =
                '\u2066' + method.destination + '\u2069' + (method.available ? '' : ' — الإرسال غير متاح');
            button.append(title, destination);
            button.addEventListener('click', () => {
                selected = method.key;
                list.querySelectorAll('button').forEach((node) =>
                    node.setAttribute('aria-pressed', String(node === button))
                );
                tick();
            });
            list.append(button);
        }
        const open = find('[data-otp-open-telegram]');
        const usingApp = screen.stage === 'sent' && screen.selected === 'authenticator';
        useRecovery = false;
        find('[data-otp-use-recovery]').hidden = !usingApp;
        find('[data-otp-use-recovery]').textContent = 'استخدام رمز استرداد';
        find('[data-otp-recovery-field]').hidden = true;
        find('[data-otp-recovery]').value = '';
        find('[data-otp-digits]').hidden = false;
        find('[data-otp-resend]').hidden = usingApp;
        open.hidden = screen.stage !== 'sent' || screen.selected !== 'telegram';
        if (screen.telegramUrl) {
            try {
                const url = new URL(screen.telegramUrl);
                if (url.protocol === 'https:' && url.hostname === 't.me' && !url.username && !url.password)
                    open.href = url.href;
            } catch (_) {
                open.hidden = true;
            }
        }
        clearCode();
        tick();
    };
    const request = async (action) => {
        const response = await fetch('/client/verify/' + action, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'x-csrf-token': panel.dataset.csrf,
            },
            body: JSON.stringify(action === 'send' ? { channel: selected } : {}),
        });
        const result = await response.json().catch(() => ({}));
        if (result.screen) {
            screen = result.screen;
            render();
        }
        if (!response.ok || !result.success) {
            if (result.restart) {
                screen.stage = 'blocked';
                render();
            }
            throw new Error(result.error || 'تعذر الاتصال. حاول مجددًا.');
        }
    };
    const run = async (action) => {
        if (busy) return;
        busy = true;
        tick();
        try {
            await request(action);
            note(
                action === 'send' && screen.selected === 'authenticator' ? ''
                    : action === 'send'
                    ? 'تم إرسال الكود إلى الطريقة المختارة.'
                    : 'تم إلغاء الكود السابق. اختر طريقة الاستلام.',
                true
            );
            if (screen.stage === 'sent') digits[0].focus();
        } catch (error) {
            note(error.message);
        } finally {
            busy = false;
            tick();
        }
    };
    find('[data-otp-send]').addEventListener('click', () => run('send'));
    find('[data-otp-resend]').addEventListener('click', () => run('send'));
    find('[data-otp-change]').addEventListener('click', () => run('change'));
    find('[data-otp-use-recovery]').addEventListener('click', () => {
        useRecovery = !useRecovery;
        clearCode();
        const input = find('[data-otp-recovery]');
        input.value = '';
        find('[data-otp-recovery-field]').hidden = !useRecovery;
        find('[data-otp-digits]').hidden = useRecovery;
        find('[data-otp-use-recovery]').textContent = useRecovery ? 'استخدام رمز التطبيق' : 'استخدام رمز استرداد';
        (useRecovery ? input : digits[0]).focus();
        tick();
    });
    find('[data-otp-recovery]').addEventListener('input', tick);
    const fill = (value, index = 0) => {
        const text = normalize(value);
        for (let i = index; i < digits.length && i - index < text.length; i++)
            digits[i].value = text[i - index];
        digits[Math.min(5, index + text.length)].focus();
        syncCode();
    };
    digits.forEach((input, index) => {
        input.addEventListener('paste', (event) => {
            event.preventDefault();
            fill(event.clipboardData.getData('text'), 0);
        });
        input.addEventListener('input', (event) => {
            const value = normalize(event.data?.length > 1 ? event.data : input.value);
            if (value.length > 1) fill(value, 0);
            else {
                input.value = value;
                if (value && index < 5) digits[index + 1].focus();
                syncCode();
            }
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Backspace' && !input.value && index > 0) digits[index - 1].focus();
            if (event.key === 'ArrowLeft' && index > 0) digits[index - 1].focus();
            if (event.key === 'ArrowRight' && index < 5) digits[index + 1].focus();
        });
    });
    find('[data-otp-form]').addEventListener('submit', (event) => {
        syncCode();
        if (find('[data-otp-confirm]').disabled) event.preventDefault();
        else {
            busy = true;
            tick();
            find('[data-otp-confirm]').textContent = 'جارٍ التحقق…';
        }
    });
    render();
    setInterval(tick, 1000);
})();
