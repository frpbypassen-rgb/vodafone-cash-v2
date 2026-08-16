(() => {
    'use strict';

    const root = document.createElement('div');
    root.id = 'rateAlertOverlay';
    root.setAttribute('aria-live', 'assertive');
    root.setAttribute('aria-atomic', 'true');

    let payload = null;
    let timer = null;
    let audioContext = null;
    let audioUnlocked = false;
    let finalWarningPlayed = false;
    let minimized = false;

    const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[char]));

    const hideLegacyBanners = () => {
        ['rateChangeCountdown', 'rateChangeActivated'].forEach((id) => {
            const element = document.getElementById(id);
            if (element) element.hidden = true;
        });
    };

    const unlockAudio = () => {
        audioUnlocked = true;
        try {
            audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
            audioContext.resume?.();
        } catch (_) {
            // The visual alert remains available when the browser blocks audio.
        }
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
        }
    };

    const showBrowserNotification = (title, body) => {
        if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
        try {
            new Notification(title, { body, icon: '/images/logo.png', tag: `rate-alert-${payload?.campaignReference || Date.now()}`, renotify: true });
        } catch (_) {}
    };

    const base64UrlToUint8Array = (value) => {
        const padding = '='.repeat((4 - (value.length % 4)) % 4);
        const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = window.atob(base64);
        return Uint8Array.from(raw, (character) => character.charCodeAt(0));
    };

    const registerWebPush = async () => {
        const key = String(window.rateAlertPushPublicKey || '').trim();
        if (!key || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
        try {
            const registration = await navigator.serviceWorker.ready;
            let subscription = await registration.pushManager.getSubscription();
            if (!subscription) {
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') return;
                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: base64UrlToUint8Array(key)
                });
            }
            await fetch('/client/api/rate-alerts/subscribe', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': window.businessPortal?.csrfToken || window.rateAlertCsrfToken || ''
                },
                body: JSON.stringify({ subscription })
            });
        } catch (_) {
            // A user can continue using the site when browser Push is blocked.
        }
    };

    const playTone = (urgent = false) => {
        if (!audioUnlocked || !audioContext) return;
        try {
            const now = audioContext.currentTime;
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(urgent ? 980 : 720, now);
            gain.gain.setValueAtTime(.001, now);
            gain.gain.exponentialRampToValueAtTime(.12, now + .03);
            gain.gain.exponentialRampToValueAtTime(.001, now + (urgent ? .48 : .28));
            oscillator.connect(gain).connect(audioContext.destination);
            oscillator.start(now);
            oscillator.stop(now + (urgent ? .5 : .3));
        } catch (_) {}
    };

    const secondsRemaining = () => {
        const effectiveAt = Date.parse(payload?.effectiveAt || '');
        return Number.isFinite(effectiveAt) ? Math.max(0, Math.ceil((effectiveAt - Date.now()) / 1000)) : 0;
    };

    const renderScheduled = () => {
        const seconds = secondsRemaining();
        if (!payload || seconds <= 0) return;
        const total = Math.max(1, Number(payload.delaySeconds || 60));
        const width = Math.max(0, Math.min(100, (seconds / total) * 100));
        const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
        const remainder = String(seconds % 60).padStart(2, '0');
        if (minimized) {
            root.innerHTML = `<button class="rate-alert-compact" type="button" data-rate-alert-expand aria-label="فتح تنبيه تغيّر السعر"><i class="fa-solid fa-bell"></i><span>${minutes}:${remainder}</span></button>`;
            return;
        }
        root.innerHTML = `
            <section class="rate-alert-card is-active" role="alert">
                <div class="rate-alert-topline">
                    <span class="rate-alert-icon"><i class="fa-solid fa-bell"></i></span>
                    <span class="rate-alert-copy"><strong>تنبيه طارئ: تحديث أسعار الصرف</strong><small>سيتم تطبيق السعر الجديد تلقائياً عند انتهاء العداد</small></span>
                    <b class="rate-alert-countdown">${minutes}:${remainder}</b>
                    <button class="rate-alert-minimize" type="button" data-rate-alert-minimize aria-label="تصغير التنبيه"><i class="fa-solid fa-minus"></i></button>
                </div>
                <div class="rate-alert-rates">${escapeHtml(payload.rateChangesText || 'تم تحديث أسعار الصرف.')}</div>
                <div class="rate-alert-progress"><span style="width:${width}%"></span></div>
            </section>`;
        if (seconds <= 10 && !finalWarningPlayed) {
            finalWarningPlayed = true;
            playTone(true);
        }
    };

    const showActivated = (nextPayload) => {
        payload = null;
        minimized = false;
        if (timer) window.clearInterval(timer);
        const current = nextPayload?.currentRatesText || 'تم اعتماد السعر الجديد في حسابك.';
        root.innerHTML = `
            <section class="rate-alert-card is-activated" role="alert">
                <div class="rate-alert-topline">
                    <span class="rate-alert-icon"><i class="fa-solid fa-circle-check"></i></span>
                    <span class="rate-alert-copy"><strong>تم تفعيل السعر الجديد</strong><small>تم تحديث الأسعار في حسابك بنجاح</small></span>
                </div>
                <div class="rate-alert-rates">${escapeHtml(current)}</div>
            </section>`;
        playTone();
        showBrowserNotification('تم تفعيل السعر الجديد', current);
        window.setTimeout(() => { root.innerHTML = ''; }, 12000);
    };

    const schedule = (nextPayload) => {
        if (!nextPayload?.effectiveAt) return;
        payload = nextPayload;
        minimized = false;
        finalWarningPlayed = false;
        hideLegacyBanners();
        if (timer) window.clearInterval(timer);
        renderScheduled();
        playTone();
        showBrowserNotification('تنبيه طارئ: تحديث أسعار الصرف', `سيتم التفعيل خلال 60 ثانية.\n${nextPayload.rateChangesText || ''}`);
        timer = window.setInterval(() => {
            if (secondsRemaining() <= 0) return;
            renderScheduled();
        }, 1000);
    };

    const mount = () => {
        document.body.appendChild(root);
        ['pointerdown', 'keydown', 'touchstart'].forEach((event) => {
            window.addEventListener(event, unlockAudio, { once: true, passive: true });
        });
        root.addEventListener('click', (event) => {
            if (event.target.closest('[data-rate-alert-minimize]')) {
                minimized = true;
                renderScheduled();
            }
            if (event.target.closest('[data-rate-alert-expand]')) {
                minimized = false;
                renderScheduled();
            }
        });
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/rate-alert-sw.js')
                .then(() => registerWebPush())
                .catch(() => {});
        }
        if (window.rateAlertInitial?.effectiveAt) schedule(window.rateAlertInitial);
        if (typeof window.io !== 'function') return;
        const socket = window.io();
        socket.on('rate_change_scheduled', schedule);
        socket.on('rate_change_activated', (nextPayload) => {
            hideLegacyBanners();
            showActivated(nextPayload);
        });
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
})();
