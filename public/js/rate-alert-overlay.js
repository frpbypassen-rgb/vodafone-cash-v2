(() => {
    'use strict';

    const root = document.createElement('div');
    root.id = 'rateAlertOverlay';
    root.setAttribute('aria-live', 'assertive');
    root.setAttribute('aria-atomic', 'true');

    let payload = null;
    let timer = null;
    let pollTimer = null;
    let audioContext = null;
    let audioUnlocked = false;
    let finalWarningPlayed = false;
    let minimized = false;
    let fetching = false;
    const ACTIVATED_EVENT_KEY = 'powerpay.rate-alert:last-activated';
    const SCHEDULED_EVENT_KEY = 'powerpay.rate-alert:last-scheduled';

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
        } catch (_) {}
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
        }
    };

    const showBrowserNotification = (title, body, tag) => {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        if (!document.hidden && document.hasFocus()) return;
        try {
            new Notification(title, {
                body,
                icon: '/images/logo.png',
                tag: tag || `rate-alert-${Date.now()}`,
                renotify: true
            });
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
        } catch (_) {}
    };

    const playTone = (urgent = false) => {
        if (!audioUnlocked || !audioContext) return;
        try {
            const now = audioContext.currentTime;
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            oscillator.type = urgent ? 'square' : 'sine';
            oscillator.frequency.setValueAtTime(urgent ? 940 : 720, now);
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
        return Number.isFinite(effectiveAt)
            ? Math.max(0, Math.ceil((effectiveAt - Date.now()) / 1000))
            : 0;
    };

    const formatCountdown = (seconds) => (
        `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    );

    const renderRateRows = (rows) => {
        if (!Array.isArray(rows) || !rows.length) {
            return `<div class="rate-alert-rates">${escapeHtml(payload?.rateChangesText || 'تم تحديث أسعار الصرف.')}</div>`;
        }
        return `<div class="rate-alert-rate-list">${rows.map((row) => {
            const direction = row.direction === 'down' ? 'down' : 'up';
            const symbol = direction === 'up' ? '↑' : '↓';
            return `<div class="rate-alert-rate-row is-${direction}">
                <strong>${escapeHtml(row.label)}</strong>
                <span class="rate-alert-rate-values" dir="ltr">
                    <del>${escapeHtml(Number(row.oldRate).toFixed(2))}</del>
                    <b>${symbol}</b>
                    <ins>${escapeHtml(Number(row.newRate).toFixed(2))}</ins>
                </span>
            </div>`;
        }).join('')}</div>`;
    };

    const renderScheduled = () => {
        const seconds = secondsRemaining();
        if (!payload || seconds <= 0) return;
        const total = Math.max(1, Number(payload.delaySeconds || 60));
        const width = Math.max(0, Math.min(100, (seconds / total) * 100));
        const countdown = formatCountdown(seconds);
        if (minimized) {
            root.innerHTML = `<button class="rate-alert-compact" type="button" data-rate-alert-expand aria-label="فتح تنبيه تغيّر السعر"><i class="fa-solid fa-bell"></i><span>${countdown}</span></button>`;
            return;
        }
        root.innerHTML = `
            <section class="rate-alert-card is-active" role="alert">
                <div class="rate-alert-topline">
                    <span class="rate-alert-icon"><i class="fa-solid fa-chart-line"></i></span>
                    <span class="rate-alert-copy"><strong>تنبيه مهم: تحديث سعر الصرف</strong><small>يظل السعر الحالي فعالاً حتى انتهاء العداد</small></span>
                    <b class="rate-alert-countdown">${countdown}</b>
                    <button class="rate-alert-minimize" type="button" data-rate-alert-minimize aria-label="تصغير التنبيه"><i class="fa-solid fa-minus"></i></button>
                </div>
                ${renderRateRows(payload.rateChanges)}
                <div class="rate-alert-progress"><span style="width:${width}%"></span></div>
            </section>`;
        if (seconds <= 10 && !finalWarningPlayed) {
            finalWarningPlayed = true;
            playTone(true);
        }
    };

    const eventIdentity = (eventPayload) => String(
        eventPayload?.campaignReference || eventPayload?.effectiveAt || ''
    ).trim();

    const rememberEvent = (key, eventPayload) => {
        const identity = eventIdentity(eventPayload);
        if (!identity) return false;
        try {
            if (localStorage.getItem(key) === identity) return true;
            localStorage.setItem(key, identity);
        } catch (_) { /* optional */ }
        return false;
    };

    const clearLegacyMarkers = () => {
        try {
            Object.keys(localStorage)
                .filter((key) => key.startsWith('rate-alert-activated:') || key.startsWith('company-os-seen-rate:'))
                .forEach((key) => localStorage.removeItem(key));
        } catch (_) { /* optional */ }
    };

    const showActivated = (completedPayload) => {
        payload = null;
        minimized = false;
        if (timer) window.clearInterval(timer);
        const alreadySeen = rememberEvent(ACTIVATED_EVENT_KEY, completedPayload);
        if (alreadySeen) {
            root.innerHTML = '';
            return;
        }
        const current = completedPayload?.currentRatesText || 'تم اعتماد السعر الجديد في حسابك.';
        root.innerHTML = `
            <section class="rate-alert-card is-activated" role="alert">
                <div class="rate-alert-topline">
                    <span class="rate-alert-icon"><i class="fa-solid fa-circle-check"></i></span>
                    <span class="rate-alert-copy"><strong>تم تفعيل السعر الجديد</strong><small>تأكد من السعر الحالي قبل إرسال أي عملية</small></span>
                </div>
                <div class="rate-alert-rates">${escapeHtml(current)}</div>
            </section>`;
        playTone();
        showBrowserNotification('تم تفعيل السعر الجديد', current, `rate-activated-${completedPayload?.campaignReference || Date.now()}`);
        window.setTimeout(() => {
            if (!payload) root.innerHTML = '';
        }, 12000);
    };

    const schedule = (nextPayload) => {
        if (!nextPayload?.effectiveAt || Date.parse(nextPayload.effectiveAt) <= Date.now()) return;
        const sameCampaign = payload
            && String(payload.campaignReference || payload.effectiveAt) === String(nextPayload.campaignReference || nextPayload.effectiveAt);
        payload = nextPayload;
        if (!sameCampaign) {
            minimized = false;
            finalWarningPlayed = false;
            const alreadyNotified = rememberEvent(SCHEDULED_EVENT_KEY, nextPayload);
            if (!alreadyNotified) {
                playTone();
                showBrowserNotification(
                    'تنبيه مهم: تحديث سعر الصرف',
                    `سيتم التفعيل خلال ${nextPayload.countdown || formatCountdown(nextPayload.delaySeconds || 60)}.\n${nextPayload.rateChangesText || ''}`,
                    `rate-alert-${nextPayload.campaignReference || nextPayload.effectiveAt}`
                );
            }
        }
        hideLegacyBanners();
        if (timer) window.clearInterval(timer);
        renderScheduled();
        timer = window.setInterval(() => {
            if (secondsRemaining() <= 0) {
                window.clearInterval(timer);
                const completedPayload = payload;
                window.setTimeout(() => refreshCurrent({ activationHint: true, completedPayload }), 250);
                return;
            }
            renderScheduled();
        }, 1000);
    };

    const refreshCurrent = async ({ activationHint = false, completedPayload = payload } = {}) => {
        if (fetching) return;
        fetching = true;
        try {
            const response = await fetch('/client/api/rate-alerts/current', {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
                cache: 'no-store'
            });
            if (!response.ok) return;
            const body = await response.json();
            if (body?.alert?.effectiveAt) {
                schedule(body.alert);
            } else if ((activationHint || completedPayload) && completedPayload) {
                showActivated(completedPayload);
            }
        } catch (_) {
            if (activationHint && completedPayload) {
                window.setTimeout(() => refreshCurrent({ activationHint: true, completedPayload }), 2000);
            }
        } finally {
            fetching = false;
        }
    };

    const mount = () => {
        document.body.appendChild(root);
        clearLegacyMarkers();
        ['pointerdown', 'keydown', 'touchstart'].forEach((event) => {
            window.addEventListener(event, unlockAudio, { once: true, passive: true });
        });
        root.addEventListener('click', (event) => {
            if (event.target.closest('[data-rate-alert-minimize]')) {
                minimized = true;
                renderScheduled();
                return;
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
        void refreshCurrent();
        pollTimer = window.setInterval(() => refreshCurrent(), 15000);
        window.addEventListener('beforeunload', () => window.clearInterval(pollTimer), { once: true });
        if (typeof window.io !== 'function') return;
        const socket = window.io();
        socket.on('rate_change_refresh', (event) => {
            const completedPayload = payload;
            void refreshCurrent({ activationHint: event?.event === 'activated', completedPayload });
        });
        // Older server instances may emit these while a rolling deployment is
        // still finishing. Fetching prevents trusting a non-personalized body.
        socket.on('rate_change_scheduled', () => refreshCurrent());
        socket.on('rate_change_activated', () => refreshCurrent({ activationHint: true, completedPayload: payload }));
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
})();
