import { config, body } from './core.js';
import { activeService } from './services.js';

const transferAmountInput = document.getElementById('transferAmount');

const transferNotesInput = document.getElementById('transferNotes');

document.querySelectorAll('[data-amount-add]').forEach((button) => {
    button.addEventListener('click', () => {
        if (!transferAmountInput) return;
        transferAmountInput.value = String(
            Math.max(0, Number(transferAmountInput.value || 0)) + Number(button.dataset.amountAdd || 0)
        );
        transferAmountInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
});

document.querySelector('[data-amount-max]')?.addEventListener('click', () => {
    const service =
        activeService || (config.services || []).find((item) => item.key === config.selectedService);
    const rate = Number(service?.rate || 0);
    const balance = Number(config.availableBalance || 0);
    if (!transferAmountInput || !(rate > 0) || !(balance > 0)) return;
    const maximum = service?.rateDirection === 'source_to_lyd' ? balance / rate : balance * rate;
    transferAmountInput.value = String(Math.floor(maximum * 100) / 100);
    transferAmountInput.dispatchEvent(new Event('input', { bubbles: true }));
});

document.querySelectorAll('[data-transfer-reason]').forEach((button) => {
    button.addEventListener('click', () => {
        if (!transferNotesInput) return;
        transferNotesInput.value = button.dataset.transferReason || '';
        transferNotesInput.focus();
    });
});

document.querySelector('[data-focus-mode]')?.addEventListener('click', (event) => {
    const active = body.classList.toggle('bw-focus-mode');
    event.currentTarget.innerHTML = active
        ? '<i class="fa-solid fa-compress"></i>إنهاء التركيز'
        : '<i class="fa-solid fa-expand"></i>وضع التركيز';
});

const offlineBanner = document.querySelector('[data-offline-banner]');

const updateConnectivity = () => {
    const offline = !navigator.onLine;
    if (offlineBanner) offlineBanner.hidden = !offline;
    body.classList.toggle('bw-is-offline', offline);
    const submit = document.getElementById('transferSubmitButton');
    if (submit) submit.disabled = offline;
};

window.addEventListener('online', updateConnectivity);

window.addEventListener('offline', updateConnectivity);

updateConnectivity();

const privacyShield = document.querySelector('[data-privacy-shield]');

const setPrivacyShield = (active) => {
    if (privacyShield) privacyShield.hidden = !active;
    body.classList.toggle('bw-privacy-active', active);
};

document
    .querySelectorAll('[data-privacy-toggle]')
    .forEach((button) => button.addEventListener('click', () => setPrivacyShield(true)));

document.querySelector('[data-privacy-restore]')?.addEventListener('click', () => setPrivacyShield(false));

let lastShakeAt = 0;

window.addEventListener('devicemotion', (event) => {
    const acceleration = event.accelerationIncludingGravity;
    const strength =
        Math.abs(acceleration?.x || 0) + Math.abs(acceleration?.y || 0) + Math.abs(acceleration?.z || 0);
    if (strength > 34 && Date.now() - lastShakeAt > 2500) {
        lastShakeAt = Date.now();
        setPrivacyShield(true);
    }
});
