'use strict';
(() => {
    const banner = document.getElementById('rateChangeCountdown');
    const value = banner?.querySelector('[data-rate-countdown-value]');
    const details = document.getElementById('rateChangeDetails');
    const activatedBanner = document.getElementById('rateChangeActivated');
    const activatedDetails = document.getElementById('rateChangeActivatedDetails');
    let effectiveAt = (window.agentPortal || window.businessPortal)?.pendingRateUpdate?.effectiveAt || null;
    let rateChangesText =
        (window.agentPortal || window.businessPortal)?.pendingRateUpdate?.rateChangesText || '';
    let timer = null;

    const render = () => {
        if (!banner || !value) return;
        if (!effectiveAt) {
            banner.hidden = true;
            return;
        }
        const seconds = Math.max(0, Math.ceil((new Date(effectiveAt).getTime() - Date.now()) / 1000));
        if (!Number.isFinite(seconds) || seconds <= 0) {
            banner.hidden = true;
            if (timer) window.clearInterval(timer);
            return;
        }
        banner.hidden = false;
        if (details) details.textContent = rateChangesText;
        value.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    };
    const arm = (payload) => {
        effectiveAt = payload?.effectiveAt || null;
        rateChangesText = payload?.rateChangesText || '';
        if (timer) window.clearInterval(timer);
        render();
        if (effectiveAt) timer = window.setInterval(render, 1000);
    };

    arm({ effectiveAt, rateChangesText });
    if (typeof window.io === 'function') {
        const socket = window.getPortalRealtimeSocket ? window.getPortalRealtimeSocket() : window.io();
        socket.on('rate_change_scheduled', arm);
        socket.on('rate_change_activated', (payload) => {
            effectiveAt = null;
            if (timer) window.clearInterval(timer);
            if (banner) banner.hidden = true;
            if (activatedDetails)
                activatedDetails.textContent =
                    payload?.currentRatesText || 'تم اعتماد السعر الجديد في حسابك.';
            if (activatedBanner) {
                activatedBanner.hidden = false;
                window.setTimeout(() => {
                    activatedBanner.hidden = true;
                }, 12000);
            }
        });
    }
})();
