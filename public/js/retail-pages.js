(() => {
    'use strict';
    const button = document.getElementById('hubRatePushBtn');
    const status = document.getElementById('hubRatePushStatus');
    if (!button || !status) return;
    const configured = Boolean(window.rateAlertPushPublicKey);
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    status.textContent = !supported
        ? 'غير مدعوم في هذا المتصفح'
        : !configured
          ? 'غير مهيأ على هذه النسخة'
          : Notification.permission === 'granted'
            ? 'الإذن مسموح'
            : 'غير مفعّل';
    button.disabled = !configured || !supported;
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') throw new Error('لم يتم السماح بالإشعارات.');
            const registration = await navigator.serviceWorker.register('/rate-alert-sw.js');
            await navigator.serviceWorker.ready;
            const base64 = window.rateAlertPushPublicKey.replace(/-/g, '+').replace(/_/g, '/');
            const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
            const key = Uint8Array.from(binary, (c) => c.charCodeAt(0));
            const subscription =
                (await registration.pushManager.getSubscription()) ||
                (await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: key,
                }));
            const response = await fetch('/client/api/rate-alerts/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.csrfToken },
                body: JSON.stringify({ subscription }),
            });
            if (!response.ok) throw new Error('تعذر حفظ تفعيل الإشعارات.');
            status.textContent = 'مفعّل على هذا المتصفح';
        } catch (error) {
            status.textContent = error.message || 'تعذر التفعيل.';
        } finally {
            button.disabled = false;
        }
    });
})();

(() => {
    'use strict';
    const dialog = document.getElementById('retailLogoutDialog');
    if (!dialog) return;
    document.querySelector('[data-retail-logout]')?.addEventListener('click', () => dialog.showModal());
    document.querySelector('[data-retail-logout-cancel]')?.addEventListener('click', () => dialog.close());
})();

(() => {
    'use strict';
    const form = document.getElementById('retailProfileForm');
    if (!form) return;
    const fields = [...form.querySelectorAll('input:not([type="hidden"])')];
    const initial = fields.map((input) => input.value);
    const save = document.getElementById('retailProfileSave');
    const status = document.getElementById('retailProfileSaveStatus');
    let submitting = false;
    let navigationConfirmed = false;
    const dirty = () => fields.some((input, index) => input.value !== initial[index]);
    const sync = () => {
        save.disabled = !dirty() || submitting;
        status.textContent = dirty() ? 'لديك تغييرات غير محفوظة.' : 'لا توجد تغييرات غير محفوظة.';
    };
    form.addEventListener('input', sync);
    form.addEventListener('change', sync);
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submitting || !dirty() || !form.reportValidity()) return;
        submitting = true;
        save.disabled = true;
        status.textContent = 'جارٍ حفظ التغييرات…';
        fields.forEach((input) => {
            input.readOnly = true;
        });
        try {
            const response = await fetch(form.action, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-CSRF-Token': window.csrfToken || '',
                },
                body: new URLSearchParams(new FormData(form)),
            });
            const payload = await response.json();
            if (!response.ok || payload.success !== true)
                throw new Error(payload.error || 'تعذر حفظ التغييرات. أعد المحاولة.');
            fields.forEach((input, index) => {
                input.value = payload.profile?.[input.name] ?? input.value;
                initial[index] = input.value;
            });
            const identity = document.querySelector('.retail-profile-identity strong');
            if (identity && payload.profile?.name) identity.textContent = payload.profile.name;
            status.textContent = 'تم حفظ التغييرات بنجاح.';
        } catch (error) {
            status.textContent = 'تعذر حفظ التغييرات. بياناتك ما زالت موجودة؛ أعد المحاولة.';
        } finally {
            submitting = false;
            fields.forEach((input) => {
                input.readOnly = false;
            });
            save.disabled = !dirty();
        }
    });
    window.addEventListener('beforeunload', (event) => {
        if (navigationConfirmed || !dirty()) return;
        event.preventDefault();
        event.returnValue = '';
    });
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (
            !link ||
            submitting ||
            !dirty() ||
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey ||
            link.target === '_blank' ||
            link.hasAttribute('download') ||
            link.getAttribute('href').startsWith('#')
        )
            return;
        if (!window.confirm('لديك تغييرات غير محفوظة. هل تريد المغادرة دون حفظ؟')) {
            event.preventDefault();
            return;
        }
        // The confirmed navigation must not prompt a second time on unload.
        navigationConfirmed = true;
    });
    window.addEventListener('pageshow', () => {
        submitting = false;
        navigationConfirmed = false;
        sync();
    });
    sync();
})();
