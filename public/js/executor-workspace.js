(() => {
    'use strict';

    const apiFetch = (...args) => window.executorApiFetch(...args);
    const readApiResponse = (...args) => window.readExecutorApiResponse(...args);

    const setThemeIcon = () => {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        document.querySelectorAll('[data-executor-theme-icon], #themeIcon').forEach((icon) => {
            icon.className = dark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
        });
    };

    window.toggleExecutorTheme = () => {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        const next = dark ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        document.documentElement.setAttribute('data-bs-theme', next);
        localStorage.setItem('ahram_theme', next);
        setThemeIcon();
    };

    const base64UrlToUint8Array = (value) => {
        const padding = '='.repeat((4 - (value.length % 4)) % 4);
        const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = window.atob(base64);
        return Uint8Array.from(raw, (char) => char.charCodeAt(0));
    };

    const registerWorker = async () => {
        if (!('serviceWorker' in navigator)) return null;
        return navigator.serviceWorker.register('/executor-sw.js', { scope: '/executor-portal/' });
    };

    window.executorBrowserPush = {
        async status() {
            const response = await apiFetch('/executor-portal/api/web-push/status');
            const data = await readApiResponse(response);
            return {
                ...data,
                permission: 'Notification' in window ? Notification.permission : 'unsupported',
                supported: 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window
            };
        },

        async enable() {
            if (!('Notification' in window) || !('PushManager' in window)) {
                throw new Error('هذا المتصفح لا يدعم الإشعارات السحابية.');
            }
            const configResponse = await apiFetch('/executor-portal/api/web-push/status');
            const config = await readApiResponse(configResponse);
            if (!config.configured || !config.publicKey) {
                throw new Error('مفاتيح Web Push غير مكتملة على الخادم.');
            }
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') throw new Error('لم يتم منح إذن الإشعارات للمتصفح.');
            const registration = await registerWorker();
            let subscription = await registration.pushManager.getSubscription();
            if (!subscription) {
                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: base64UrlToUint8Array(config.publicKey)
                });
            }
            const response = await apiFetch('/executor-portal/api/web-push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscription })
            });
            return readApiResponse(response);
        },

        async disable() {
            const registration = await navigator.serviceWorker?.getRegistration('/executor-portal/');
            const subscription = await registration?.pushManager?.getSubscription();
            const endpoint = subscription?.endpoint || '';
            if (subscription) await subscription.unsubscribe();
            const response = await apiFetch('/executor-portal/api/web-push/unsubscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint })
            });
            return readApiResponse(response);
        },

        async test() {
            const response = await apiFetch('/executor-portal/api/web-push/test', { method: 'POST' });
            return readApiResponse(response);
        },

        async preview() {
            await registerWorker();
            const registration = await navigator.serviceWorker.ready;
            const worker = registration.active || registration.waiting || registration.installing;
            if (!worker) throw new Error('تعذر تشغيل عامل إشعارات المتصفح.');
            worker.postMessage({
                type: 'executor-notification-preview',
                title: 'وصلت عملية تنفيذ جديدة',
                message: 'محافظ كاش | 011 | 1,000 ج.م',
                tag: 'executor-preview',
                data: { url: '/executor-portal/dashboard', category: 'executor_task_new' }
            });
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        setThemeIcon();
        registerWorker().catch(() => {});
        document.querySelectorAll('[data-executor-theme-toggle]').forEach((button) => {
            button.addEventListener('click', window.toggleExecutorTheme);
        });
    });
})();
