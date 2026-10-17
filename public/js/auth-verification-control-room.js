(() => {
    'use strict';

    const boot = () => {
        document.querySelectorAll('[data-auth-verification-form]').forEach((form) => {
            const input = form.querySelector('[data-auth-code-input]');
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

            input.addEventListener('input', () => {
                input.value = input.value.replace(/\D/g, '').slice(0, 6);
                if (input.value.length < 6) setProgress(0, 'جاهز', 0);
            });

            form.addEventListener('submit', (event) => {
                if (form.dataset.authSubmitting === 'true') return;
                if (input.value.replace(/\D/g, '').length !== 6) return;
                event.preventDefault();
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
            });

            setProgress(0, 'جاهز', 0);
        });
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
