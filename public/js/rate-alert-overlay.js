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
        root.innerHTML = `
            <section class="rate-alert-card is-active" role="alert">
                <div class="rate-alert-topline">
                    <span class="rate-alert-icon"><i class="fa-solid fa-bell"></i></span>
                    <span class="rate-alert-copy"><strong>تنبيه طارئ: تحديث أسعار الصرف</strong><small>سيتم تطبيق السعر الجديد تلقائياً عند انتهاء العداد</small></span>
                    <b class="rate-alert-countdown">${minutes}:${remainder}</b>
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
        window.setTimeout(() => { root.innerHTML = ''; }, 12000);
    };

    const schedule = (nextPayload) => {
        if (!nextPayload?.effectiveAt) return;
        payload = nextPayload;
        finalWarningPlayed = false;
        hideLegacyBanners();
        if (timer) window.clearInterval(timer);
        renderScheduled();
        playTone();
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
