(() => {
    'use strict';
    const controls = document.querySelector('[data-agent-push-test-controls]');
    const preference = document.querySelector('[data-notification-preference="push"]');
    if (!controls || !preference) return;
    const button = controls.querySelector('[data-agent-push-test]');
    const status = controls.querySelector('[data-agent-push-test-status]');
    let busy = false;
    try {
        const stored = localStorage.getItem('powerpay-notification-push');
        if (stored !== null) preference.checked = stored === 'true';
    } catch (_) {}
    const sync = () => { controls.hidden = !preference.checked; status.textContent = ''; };
    preference.addEventListener('change', sync);
    sync();
    const timeout = (promise, ms = 8000) => new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(new Error('TIMEOUT')),ms);
        Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); },error => { clearTimeout(timer); reject(error); });
    });
    const workerRegistration = async () => {
        let registration = await timeout(navigator.serviceWorker.getRegistration());
        if (!registration) registration = await timeout(navigator.serviceWorker.register('/rate-alert-sw.js',{scope:'/agent-portal/notification-test/'}));
        if (!registration.active) {
            const worker = registration.installing || registration.waiting;
            if (!worker) throw new Error('NO_WORKER');
            await timeout(new Promise((resolve,reject) => {
                const changed = () => {
                    if (worker.state === 'activated' || worker.state === 'redundant') {
                        worker.removeEventListener('statechange',changed);
                        if (worker.state === 'activated') resolve(); else reject(new Error('NO_WORKER'));
                    }
                };
                worker.addEventListener('statechange',changed);
                changed();
            }));
        }
        return registration;
    };
    button.addEventListener('click', async () => {
        if (busy || !preference.checked) return;
        if (!window.isSecureContext) { status.textContent = 'اختبار الإشعارات يحتاج اتصالًا آمنًا HTTPS.'; return; }
        if (!('Notification' in window)) { status.textContent = 'هذا المتصفح لا يدعم إشعارات الويب.'; return; }
        if (Notification.permission === 'denied') { status.textContent = 'الإشعارات محظورة. اسمح بها من إعدادات الموقع في المتصفح.'; return; }
        busy = true;
        button.disabled = true;
        status.textContent = 'جارٍ اختبار الإشعارات…';
        try {
            const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
            if (!preference.checked) return;
            if (permission !== 'granted') { status.textContent = 'لم يتم منح إذن الإشعارات. اضغط الاختبار للسماح بها.'; return; }
            const title = 'الأهرام Pay — اختبار إشعارات الويب';
            const options = {body:'إشعار تجريبي للتأكد من ظهور التنبيهات على هذا الجهاز.',icon:'/images/logo.jpg',tag:'agent-web-notification-test',data:{url:'/agent-portal/settings#notifications'}};
            let displayed = false;
            if ('serviceWorker' in navigator) {
                try {
                    const registration = await workerRegistration();
                    if (!preference.checked) return;
                    await timeout(registration.showNotification(title,options));
                    displayed = true;
                } catch (_) {}
            }
            if (!preference.checked) return;
            if (!displayed) {
                const notification = new Notification(title,options);
                notification.onclick = () => { window.focus(); notification.close(); };
            }
            status.textContent = 'تم إرسال إشعار تجريبي لهذا الجهاز. راجع إشعارات المتصفح أو النظام.';
        } catch (_) { status.textContent = 'تعذر عرض الإشعار. راجع إذن الإشعارات وإعدادات المتصفح.'; }
        finally { busy = false; button.disabled = false; }
    });
})();
