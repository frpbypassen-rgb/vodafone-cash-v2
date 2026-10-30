(() => {
    'use strict';
    const root = document.querySelector('[data-retail-notifications]');
    if (!root) return;
    const find = (s) => root.querySelector(s),
        form = find('[data-rn-preferences]'),
        emailForm = find('[data-rn-email-form]'),
        codeForm = find('[data-rn-code-form]');
    let state = null,
        baseline = '',
        emailBaseline = '',
        busy = false,
        fresh = false,
        leaving = false,
        linkUrl = '',
        device = { active: false, subscription: null };
    const values = () => ({
        ratesEnabled: form.elements.ratesEnabled.checked,
        emailEnabled: form.elements.emailEnabled.checked,
        telegramEnabled: form.elements.telegramEnabled.checked,
    });
    const dirty = () => Boolean(state && JSON.stringify(values()) !== baseline),
        emailDraft = () => emailForm.elements.email.value !== emailBaseline;
    const unsaved = () => dirty() || emailDraft();
    const message = (text, error = false) => {
        const node = find('[data-rn-message]');
        node.textContent = text;
        node.hidden = !text;
        node.classList.toggle('is-error', error);
    };
    const request = async (path = '', body) => {
        const response = await fetch('/client/api/customer-notifications' + path, {
            method: body ? 'POST' : 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'x-csrf-token': window.csrfToken || '',
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success)
            throw Object.assign(new Error(result.error || 'تعذر إكمال الطلب. أعد المحاولة.'), {
                code: result.code,
                status: response.status,
            });
        return result.data;
    };
    const controls = () => {
        const locked = busy || !fresh,
            changed = dirty();
        root.querySelectorAll('button').forEach((button) => {
            button.disabled = locked;
        });
        find('[data-rn-refresh]').disabled = busy;
        find('[data-rn-inbox]').disabled = false;
        form.elements.ratesEnabled.disabled = locked;
        form.elements.emailEnabled.disabled = locked || !state?.email.verified;
        form.elements.telegramEnabled.disabled = locked || !state?.telegram.linked;
        find('[data-rn-save]').disabled = locked || !changed;
        find('[data-rn-dirty]').textContent = changed
            ? 'لديك تفضيلات غير محفوظة.'
            : 'لا توجد تغييرات غير محفوظة.';
        emailForm.elements.email.disabled = locked || changed;
        codeForm.elements.code.disabled = locked || changed;
        if (!state) return;
        find('[data-rn-email-send]').disabled = locked || changed || !state.email.available;
        find('[data-rn-email-test]').disabled =
            locked || changed || !state.email.enabled || !state.email.verified || !state.email.available;
        codeForm.querySelector('button').disabled = locked || changed;
        find('[data-rn-tg-link]').disabled =
            locked || changed || !state.telegram.available || state.telegram.linked;
        find('[data-rn-tg-check]').disabled = locked || changed;
        find('[data-rn-tg-test]').disabled =
            locked || changed || !state.telegram.available || !state.telegram.enabled;
        const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
        const permission = supported ? Notification.permission : 'unsupported';
        find('[data-rn-push-enable]').disabled =
            locked || changed || !supported || !state.push.configured || permission === 'denied';
        find('[data-rn-push-enable]').hidden = device.active && permission === 'granted';
        find('[data-rn-push-disable]').hidden = !device.subscription;
        find('[data-rn-push-disable]').disabled = locked || changed;
        find('[data-rn-push-test]').disabled =
            locked || changed || !device.active || permission !== 'granted' || !state.push.configured;
    };
    const inspectDevice = async () => {
        const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
        let label = 'غير مدعوم',
            help = 'هذا المتصفح لا يدعم إشعارات الجهاز.';
        device = { active: false, subscription: null };
        if (supported) {
            const registration = await navigator.serviceWorker.getRegistration('/rate-alert-sw.js');
            const subscription = await registration?.pushManager.getSubscription();
            device.subscription = subscription || null;
            if (subscription) {
                device.active = (await request('/push/status', { endpoint: subscription.endpoint })).active;
            }
            if (!state.push.configured) {
                label = 'الخدمة غير مهيأة';
                help = 'إشعارات الجهاز غير مهيأة على هذه النسخة. تواصل مع الإدارة.';
            } else if (Notification.permission === 'denied') {
                label = 'الإذن محظور';
                help = 'افتح إعدادات هذا الموقع في المتصفح، واسمح بالإشعارات، ثم حدّث الحالة.';
            } else if (Notification.permission === 'granted' && device.active) {
                label = 'مفعّلة على هذا الجهاز';
                help = 'يمكنك إرسال إشعار تجريبي للتأكد من الوصول.';
            } else {
                label = Notification.permission === 'granted' ? 'الإذن مسموح — غير مشترَك' : 'غير مفعّلة';
                help =
                    'اضغط تفعيل للسماح بتنبيهات هذا الجهاز. على iPhone قد تحتاج إضافة الموقع إلى الشاشة الرئيسية.';
            }
        }
        find('[data-rn-push-state]').textContent = label;
        find('[data-rn-push-help]').textContent = help;
    };
    const apply = (data) => {
        state = data;
        fresh = true;
        form.elements.ratesEnabled.checked = data.ratesEnabled;
        form.elements.emailEnabled.checked = data.email.enabled;
        form.elements.telegramEnabled.checked = data.telegram.enabled;
        baseline = JSON.stringify(values());
        emailForm.elements.email.value = data.email.pendingEmail || data.email.email || '';
        emailBaseline = emailForm.elements.email.value;
        codeForm.hidden = !data.email.challengeId;
        find('[data-rn-email-state]').textContent =
            data.email.enabled && data.email.verified
                ? 'مفعّل'
                : data.email.verified
                  ? 'مؤكّد — الإرسال متوقف'
                  : 'غير مؤكّد';
        find('[data-rn-email-info]').textContent = data.email.available
            ? 'كشف يومي عند 00:05 بتوقيت ليبيا. ' +
              (data.email.lastSentAt
                  ? 'آخر إرسال: ' +
                    new Date(data.email.lastSentAt).toLocaleString('ar-LY', { timeZone: 'Africa/Tripoli' })
                  : data.email.lastDeliveryStatus === 'uncertain'
                    ? 'تعذر تأكيد آخر إرسال؛ لن يعاد تلقائيًا.'
                    : 'لا يوجد إرسال مؤكد بعد.')
            : 'البريد غير مهيأ على هذه النسخة؛ لا يمكن إرسال كود أو اختبار حاليًا.';
        find('[data-rn-tg-state]').textContent = data.telegram.enabled
            ? 'مفعّل'
            : data.telegram.linked
              ? 'مرتبط — الإيصالات متوقفة'
              : 'غير مرتبط';
        find('[data-rn-tg-info]').textContent = data.telegram.available
            ? data.telegram.username
                ? 'الحساب: @' + data.telegram.username
                : 'اربط حسابك عبر Ahrampay_bot ثم فعّل الإيصالات واحفظ التفضيلات.'
            : 'بوت الإشعارات غير مهيأ على هذه النسخة.';
        find('[data-rn-tg-open]').hidden = !linkUrl || data.telegram.linked;
        find('[data-rn-tg-check]').hidden = !linkUrl || data.telegram.linked;
        find('[data-rn-freshness]').textContent =
            'آخر تحقق ناجح: ' +
            new Date().toLocaleTimeString('ar-LY', {
                timeZone: 'Africa/Tripoli',
                hour: '2-digit',
                minute: '2-digit',
            });
    };
    const load = async () => {
        try {
            apply(await request());
            try {
                await inspectDevice();
            } catch (_) {
                device.active = false;
                find('[data-rn-push-state]').textContent = 'تعذر التحقق';
                find('[data-rn-push-help]').textContent = 'تعذر التحقق من اشتراك الجهاز. حدّث الحالة.';
            }
            controls();
        } catch (error) {
            fresh = false;
            find('[data-rn-freshness]').textContent = 'تعذر التحقق من التفضيلات. أعد تحديث الحالة.';
            throw error;
        }
    };
    const run = async (task) => {
        if (busy) return;
        busy = true;
        controls();
        try {
            await task();
        } catch (error) {
            if (error.status === 409) {
                fresh = false;
                find('[data-rn-freshness]').textContent = 'تغيّرت التفضيلات؛ حدّث الحالة قبل الحفظ.';
            }
            message(error.message, true);
        } finally {
            busy = false;
            controls();
        }
    };
    form.addEventListener('change', controls);
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!dirty() || !fresh) return;
        run(async () => {
            const result = await request('/preferences', {
                ...values(),
                revision: state.revision,
                emailRevision: state.email.revision,
                telegramRevision: state.telegram.revision,
            });
            apply(result);
            message('تم حفظ التفضيلات بنجاح.');
        });
    });
    emailForm.addEventListener('submit', (event) => {
        event.preventDefault();
        if (dirty()) {
            message('احفظ التفضيلات أولًا.');
            return;
        }
        run(async () => {
            message('جارٍ إرسال كود التأكيد…');
            await request('/email/request-code', {
                email: emailForm.elements.email.value,
                revision: state.email.revision,
            });
            await load();
            message('أرسلنا كود التأكيد. أدخله هنا خلال 10 دقائق.');
            codeForm.elements.code.focus();
        });
    });
    codeForm.elements.code.addEventListener('input', () => {
        codeForm.elements.code.value = codeForm.elements.code.value
            .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632))
            .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776))
            .replace(/[\s-]/g, '');
    });
    codeForm.addEventListener('submit', (event) => {
        event.preventDefault();
        run(async () => {
            await request('/email/verify', {
                challengeId: state.email.challengeId,
                code: codeForm.elements.code.value,
                revision: state.email.revision,
            });
            codeForm.reset();
            await load();
            message('تم تأكيد البريد وتفعيل الكشف اليومي. يمكنك إرسال كشف تجريبي.');
        });
    });
    find('[data-rn-email-test]').addEventListener('click', () =>
        run(async () => {
            message('جارٍ تجهيز وإرسال الكشف التجريبي…');
            await request('/email/test', {});
            await load();
            message('تم إرسال الكشف التجريبي.');
        })
    );
    find('[data-rn-tg-link]').addEventListener('click', () =>
        run(async () => {
            const data = await request('/telegram/link', { revision: state.telegram.revision });
            const url = new URL(data.botUrl);
            if (url.origin !== 'https://t.me' || url.pathname.toLowerCase() !== '/ahrampay_bot')
                throw new Error('رابط الربط غير صالح.');
            linkUrl = url.href;
            find('[data-rn-tg-open]').href = linkUrl;
            await load();
            message('افتح البوت واضغط ابدأ، ثم ارجع واضغط تحقّق من الربط.');
        })
    );
    find('[data-rn-tg-check]').addEventListener('click', () =>
        run(async () => {
            await load();
            message(
                state.telegram.linked
                    ? 'تم الربط. فعّل إيصالات تليجرام ثم احفظ التفضيلات.'
                    : 'لم يكتمل الربط بعد. افتح البوت واضغط ابدأ.'
            );
        })
    );
    find('[data-rn-tg-test]').addEventListener('click', () =>
        run(async () => {
            await request('/telegram/test', {});
            message('تم إرسال رسالة تليجرام التجريبية.');
        })
    );
    const subscriptionKey = (value) => {
        const base = value.replace(/-/g, '+').replace(/_/g, '/'),
            raw = atob(base + '='.repeat((4 - (base.length % 4)) % 4));
        return Uint8Array.from(raw, (c) => c.charCodeAt(0));
    };
    find('[data-rn-push-enable]').addEventListener('click', () =>
        run(async () => {
            if ((await Notification.requestPermission()) !== 'granted')
                throw new Error('لم يُسمح بالإشعارات. يمكنك تغيير الإذن من إعدادات المتصفح.');
            const registration = await navigator.serviceWorker.register('/rate-alert-sw.js');
            if (!registration.active) {
                const worker = registration.installing || registration.waiting;
                if (worker)
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(
                            () => reject(new Error('تعذر تهيئة إشعارات الجهاز. أعد المحاولة.')),
                            15000
                        );
                        worker.addEventListener('statechange', () => {
                            if (worker.state === 'activated') {
                                clearTimeout(timer);
                                resolve();
                            }
                        });
                    });
            }
            const subscription =
                (await registration.pushManager.getSubscription()) ||
                (await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: subscriptionKey(state.push.publicKey),
                }));
            await request('/push/subscribe', { subscription: subscription.toJSON() });
            await inspectDevice();
            message('تم التفعيل على هذا الجهاز. يمكنك إرسال إشعار تجريبي.');
        })
    );
    find('[data-rn-push-disable]').addEventListener('click', () =>
        run(async () => {
            if (device.subscription) {
                await request('/push/disable', { endpoint: device.subscription.endpoint });
                await device.subscription.unsubscribe();
            }
            await inspectDevice();
            message('تم إيقاف إشعارات هذا الجهاز.');
        })
    );
    find('[data-rn-push-test]').addEventListener('click', () =>
        run(async () => {
            await request('/push/test', { endpoint: device.subscription.endpoint });
            message('تم إرسال الإشعار التجريبي إلى هذا الجهاز.');
        })
    );
    find('[data-rn-refresh]').addEventListener('click', () => {
        if (
            unsaved() &&
            !window.confirm(
                'لديك تغييرات غير محفوظة. تحديث الحالة يستبدلها بالتفضيلات المحفوظة. هل تريد المتابعة؟'
            )
        )
            return;
        run(async () => {
            await load();
            message('تم تحديث الحالة.');
        });
    });
    find('[data-rn-inbox]').addEventListener('click', (event) => {
        event.stopPropagation();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        const button = document.querySelector('[data-bell-toggle]');
        if (button?.getAttribute('aria-expanded') !== 'true') button?.click();
    });
    window.addEventListener('beforeunload', (event) => {
        if (leaving || !unsaved()) return;
        event.preventDefault();
        event.returnValue = '';
    });
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (
            !link ||
            leaving ||
            !unsaved() ||
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey ||
            link.target === '_blank' ||
            link.getAttribute('href').startsWith('#')
        )
            return;
        if (!window.confirm('لديك تغييرات غير محفوظة. هل تريد المغادرة دون حفظ؟')) {
            event.preventDefault();
            return;
        }
        leaving = true;
    });
    window.addEventListener('pageshow', () => {
        leaving = false;
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !busy && fresh && !unsaved() && linkUrl) run(load);
    });
    run(async () => {
        try {
            await load();
        } catch (error) {
            fresh = false;
            find('[data-rn-freshness]').textContent = 'تعذر التحقق من التفضيلات. أعد التحديث.';
            throw error;
        }
    });
})();
