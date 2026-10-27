(() => {
    'use strict';
    const panel = document.querySelector('[data-mfa-panel]');
    if (!panel || panel.dataset.bound === 'true') return;
    panel.dataset.bound = 'true';
    const find = (selector) => panel.querySelector(selector);
    let busy = false,
        currentSetup = null,
        recoveryCodes = [],
        step = 1;
    const message = (text = '', error = false) => {
        const node = find('[data-mfa-message]');
        node.textContent = text;
        node.hidden = !text;
        node.classList.toggle('error', error);
    };
    const request = async (path, body) => {
        const response = await fetch('/security/mfa' + path, {
            credentials: 'same-origin',
            cache: 'no-store',
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'x-csrf-token': panel.dataset.mfaCsrf || '',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true)
            throw Object.assign(new Error(data.error || 'تعذر إكمال الطلب. حدّث الصفحة وحاول مجددًا.'), {
                status: response.status,
            });
        return data;
    };
    const setBusy = (value) => {
        busy = value;
        panel.querySelectorAll('button').forEach((button) => {
            button.disabled = value;
        });
    };
    const setStep = (value, focus = false) => {
        step = value;
        find('[data-mfa-add-step]').hidden = value !== 1;
        find('[data-mfa-confirm-step]').hidden = value !== 2;
        panel.querySelectorAll('[data-mfa-step-label]').forEach((label) => {
            if (Number(label.dataset.mfaStepLabel) === value) label.setAttribute('aria-current', 'step');
            else label.removeAttribute('aria-current');
        });
        if (focus && value === 2) find('[data-mfa-confirm-token]').focus();
    };
    const clearSetup = () => {
        currentSetup = null;
        step = 1;
        find('[data-mfa-secret]').textContent = '';
        find('[data-mfa-account-label]').textContent = '';
        find('[data-mfa-open-app]').removeAttribute('href');
        find('[data-mfa-qr-image]').removeAttribute('src');
        find('[data-mfa-confirm-token]').value = '';
        panel.querySelectorAll('[data-mfa-method]').forEach((item) => {
            item.open = false;
        });
    };
    const clearRecovery = () => {
        recoveryCodes = [];
        find('[data-mfa-recovery]').value = '';
    };
    const showSetup = (setup) => {
        const uri = new URL(setup.qrUri);
        if (
            uri.protocol !== 'otpauth:' ||
            uri.hostname !== 'totp' ||
            !String(setup.qrImage).startsWith('data:image/png;base64,')
        )
            throw new Error('تعذر تجهيز رابط التطبيق أو QR. أعد بدء الإعداد.');
        if (currentSetup?.secret !== setup.secret) {
            clearSetup();
            step = 1;
        }
        currentSetup = setup;
        find('[data-mfa-open-app]').href = setup.qrUri;
        find('[data-mfa-qr-image]').src = setup.qrImage;
        find('[data-mfa-secret]').textContent = setup.secret;
        find('[data-mfa-account-label]').textContent = setup.accountLabel || 'Al-Ahram Pay';
        setStep(step);
    };
    const render = (data) => {
        const enabled = data.enabled === true;
        const settingUp = !enabled && data.enrollment?.stage === 'setup';
        const recovering = enabled && data.enrollment?.stage === 'recovery';
        panel.dataset.mfaProgress = String(settingUp || recovering);
        const state = find('[data-mfa-state]');
        state.textContent = enabled ? 'مفعّل' : 'غير مفعّل';
        state.classList.toggle('ready', enabled);
        state.classList.toggle('warn', !enabled);
        const oldStatus = find('[data-mfa-enabled]');
        if (oldStatus) oldStatus.textContent = enabled ? 'مفعّل' : 'غير مفعّل';
        find('[data-mfa-login-rule]').textContent = enabled
            ? 'كلمة المرور + رمز تحقق'
            : 'بدون رمز Authenticator';
        find('[data-mfa-start]').hidden = enabled || settingUp;
        find('[data-mfa-disable]').hidden = !enabled || recovering;
        const manage = find('[data-mfa-manage]');
        if (manage) {
            manage.hidden = !enabled || recovering;
            manage.setAttribute('aria-expanded', 'false');
            find('[data-mfa-management]').hidden = true;
        }
        find('[data-mfa-setup]').hidden = !settingUp;
        find('[data-mfa-recovery-step]').hidden = !recovering;
        if (settingUp) showSetup(data.enrollment.setup);
        else clearSetup();
        if (recovering) {
            recoveryCodes = (data.enrollment.recoveryCodes || []).map(String);
            find('[data-mfa-recovery]').value = recoveryCodes.join('\n');
        } else clearRecovery();
    };
    const refresh = async () => {
        render(await request('/status'));
    };
    const act = async (action) => {
        if (busy) return;
        setBusy(true);
        message();
        try {
            await action();
        } catch (error) {
            if ([409, 410].includes(error.status)) await refresh().catch(() => {});
            message(error.message, true);
        } finally {
            setBusy(false);
        }
    };
    const copy = async (value, node) => {
        try {
            await navigator.clipboard.writeText(value);
            message('تم النسخ.');
        } catch (_) {
            if (node.select) {
                node.focus();
                node.select();
            } else {
                const range = document.createRange();
                range.selectNodeContents(node);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }
            message('تم تحديد البيانات. انسخها يدويًا أو اضغط مطولًا للنسخ.');
        }
    };
    find('[data-mfa-start]').addEventListener('click', () =>
        act(async () => {
            const data = await request('/setup', {});
            render({ enabled: false, enrollment: { stage: 'setup', setup: data.setup } });
        })
    );
    find('[data-mfa-next]').addEventListener('click', () => setStep(2, true));
    find('[data-mfa-back]').addEventListener('click', () => setStep(1));
    find('[data-mfa-cancel]').addEventListener('click', () =>
        act(async () => {
            await request('/setup/cancel', {});
            await refresh();
        })
    );
    find('[data-mfa-copy-secret]').addEventListener('click', () =>
        copy(find('[data-mfa-secret]').textContent, find('[data-mfa-secret]'))
    );
    const tokenInput = find('[data-mfa-confirm-token]');
    tokenInput.addEventListener('input', () => {
        tokenInput.value = tokenInput.value.replace(/\D/g, '').slice(0, 6);
    });
    tokenInput.addEventListener('paste', (event) => {
        event.preventDefault();
        tokenInput.value = (event.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    });
    tokenInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            find('[data-mfa-confirm]').click();
        }
    });
    find('[data-mfa-confirm]').addEventListener('click', () => {
        if (!/^\d{6}$/.test(tokenInput.value)) {
            message('أدخل الرمز الحالي المكوّن من 6 أرقام من التطبيق.', true);
            tokenInput.focus();
            return;
        }
        act(async () => {
            try {
                const data = await request('/confirm', { token: tokenInput.value });
                render({ enabled: true, enrollment: data.enrollment });
                message('تم تفعيل Authenticator. احفظ رموز الاسترداد الآن.');
            } catch (error) {
                await refresh().catch(() => {});
                throw error;
            }
        });
    });
    find('[data-mfa-copy-recovery]').addEventListener('click', () =>
        copy(recoveryCodes.join('\n'), find('[data-mfa-recovery]'))
    );
    find('[data-mfa-download-recovery]').addEventListener('click', () => {
        if (!recoveryCodes.length) return;
        const url = URL.createObjectURL(
            new Blob(
                [
                    'Al-Ahram Pay — Recovery codes\nKeep these codes private. Each code can be used once.\n\n' +
                        recoveryCodes.join('\n'),
                ],
                { type: 'text/plain;charset=utf-8' }
            )
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = 'ahram-recovery-codes.txt';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    });
    find('[data-mfa-finish]').addEventListener('click', () =>
        act(async () => {
            await request('/recovery/ack', {});
            clearRecovery();
            await refresh();
            message('اكتمل إعداد الحماية.');
        })
    );
    find('[data-mfa-manage]')?.addEventListener('click', () => {
        const management = find('[data-mfa-management]');
        management.hidden = !management.hidden;
        find('[data-mfa-manage]').setAttribute('aria-expanded', String(!management.hidden));
    });
    find('[data-mfa-disable]').addEventListener('click', () => {
        if (busy) return;
        const token = window.prompt('أدخل رمز التطبيق أو أحد رموز الاسترداد لإيقاف الحماية:')?.trim();
        if (token)
            act(async () => {
                await request('/disable', { token });
                await refresh();
                message('تم إيقاف الحماية.');
            });
    });
    panel.querySelectorAll('[data-mfa-method]').forEach((item) =>
        item.addEventListener('toggle', () => {
            if (item.open)
                panel.querySelectorAll('[data-mfa-method]').forEach((other) => {
                    if (other !== item) other.open = false;
                });
        })
    );
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !busy)
            refresh().catch((error) => message(error.message, true));
    });
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) refresh().catch((error) => message(error.message, true));
    });
    window.addEventListener('pagehide', () => {
        clearSetup();
        clearRecovery();
    });
    refresh().catch((error) => message(error.message, true));
})();
