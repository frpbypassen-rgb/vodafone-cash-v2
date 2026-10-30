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
