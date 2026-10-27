(() => {
    'use strict';
    document.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-copy-code]');
        if (!button) return;
        const feedback = document.querySelector('[data-directory-feedback]');
        try {
            await navigator.clipboard.writeText(button.dataset.copyCode);
            if (feedback) feedback.textContent = `تم نسخ رقم الحساب ${button.dataset.copyCode}`;
            button.setAttribute('aria-label', 'تم نسخ رقم الحساب');
            button.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
        } catch (_) {
            if (feedback) feedback.textContent = 'تعذر النسخ تلقائيًا. يمكنك تحديد رقم الحساب ونسخه.';
        }
    });
    document.addEventListener('toggle', (event) => {
        if (!event.target.matches('.am-account-card .am-actions[open]')) return;
        document.querySelectorAll('.am-account-card .am-actions[open]').forEach(menu => {
            if (menu !== event.target) menu.open = false;
        });
    }, true);
    document.addEventListener('click', (event) => {
        if (event.target.closest('.am-actions')) return;
        document.querySelectorAll('.am-account-card .am-actions[open]').forEach(menu => { menu.open = false; });
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        document.querySelectorAll('.am-account-card .am-actions[open]').forEach(menu => {
            menu.open = false;
            menu.querySelector('summary').focus();
        });
    });
})();
