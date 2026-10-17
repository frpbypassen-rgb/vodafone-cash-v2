(() => {
    'use strict';

    const boot = () => {
        document.querySelectorAll('[data-auth-verification-form]').forEach((form) => {
            const input = form.querySelector('[data-auth-code-input]');
            const slots = [...form.querySelectorAll('[data-auth-code-slot]')];
            const button = form.querySelector('[data-auth-submit]');
            const gauge = form.querySelector('[data-auth-gauge]');
            const percent = form.querySelector('[data-auth-percent]');
            const gaugeLabel = form.querySelector('[data-auth-gauge-label]');
            const steps = [...form.querySelectorAll('[data-auth-step]')];
            if (!input || !button || !gauge || !percent) return;

            const setProgress = (value, label, activeStep) => {
                const safeValue = Math.max(0, Math.min(100, Number(value) || 0));
                gauge.style.setProperty('--auth-progress', `${safeValue}%`);
                gauge.setAttribute('aria-valuenow', String(safeValue));
                percent.textContent = `${safeValue}%`;
                if (gaugeLabel && label) gaugeLabel.textContent = label;
                steps.forEach((step, index) => {
                    step.classList.toggle('is-active', index === activeStep);
                    step.classList.toggle('is-done', index < activeStep);
                });
            };

            const syncSlots = () => {
                if (!slots.length) return;
                input.value = slots.map((slot) => slot.value.replace(/\D/g, '').slice(0, 1)).join('');
            };

            const beginVerification = (event) => {
                if (event) event.preventDefault();
                if (form.dataset.authSubmitting === 'true') return;
                syncSlots();
                if (input.value.replace(/\D/g, '').length !== 6) return;
                form.dataset.authSubmitting = 'true';
                button.disabled = true;
                button.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin ms-1"></i> جارٍ التحقق...';
                setProgress(18, 'استلام الرمز', 0);
                window.setTimeout(() => setProgress(48, 'فحص الصيغة', 1), 150);
                window.setTimeout(() => setProgress(76, 'التحقق من الخادم', 2), 320);
                window.setTimeout(() => {
                    setProgress(92, 'تأكيد الجلسة', 2);
                    HTMLFormElement.prototype.submit.call(form);
                }, 520);
            };

            if (slots.length) {
                slots.forEach((slot, index) => {
                    slot.addEventListener('input', () => {
                        slot.value = slot.value.replace(/\D/g, '').slice(0, 1);
                        syncSlots();
                        if (slot.value && slots[index + 1]) slots[index + 1].focus();
                        if (input.value.length < 6) setProgress(0, 'جاهز', 0);
                        if (input.value.length === 6) window.setTimeout(() => beginVerification(), 80);
                    });
                    slot.addEventListener('keydown', (event) => {
                        if (event.key === 'Backspace' && !slot.value && slots[index - 1]) {
                            slots[index - 1].focus();
                        }
                    });
                    slot.addEventListener('paste', (event) => {
                        const pasted = (event.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
                        if (!pasted) return;
                        event.preventDefault();
                        pasted.split('').forEach((digit, digitIndex) => {
                            if (slots[index + digitIndex]) slots[index + digitIndex].value = digit;
                        });
                        syncSlots();
                        (slots[Math.min(index + pasted.length, slots.length - 1)] || slot).focus();
                        if (input.value.length === 6) window.setTimeout(() => beginVerification(), 80);
                    });
                });
            } else {
                input.addEventListener('input', () => {
                    input.value = input.value.replace(/\D/g, '').slice(0, 6);
                    if (input.value.length < 6) setProgress(0, 'جاهز', 0);
                });
            }

            form.addEventListener('submit', beginVerification);

            setProgress(0, 'جاهز', 0);
            if (slots[0]) slots[0].focus();
        });
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
