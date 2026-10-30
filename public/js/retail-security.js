(() => {
    'use strict';
    const form = document.getElementById('retailPasswordForm');
    if (!form) return;
    const current = form.elements.currentPassword,
        next = form.elements.newPassword,
        confirm = form.elements.passwordConfirm;
    const save = document.getElementById('retailPasswordSave'),
        status = document.getElementById('retailPasswordStatus');
    let leaving = false;
    const dirty = () => Boolean(current.value || next.value || confirm.value);
    const sync = () => {
        const length = next.value.length >= 8,
            match = Boolean(confirm.value && next.value === confirm.value);
        document.querySelector('[data-password-length]').classList.toggle('is-valid', length);
        document.querySelector('[data-password-match]').classList.toggle('is-valid', match);
        confirm.setCustomValidity(confirm.value && !match ? 'تأكيد كلمة المرور غير مطابق.' : '');
        save.disabled = !(current.value && length && match);
        status.textContent = dirty() ? 'لديك تغييرات غير محفوظة.' : 'أكمل الحقول لتحديث كلمة المرور.';
    };
    form.addEventListener('input', sync);
    form.addEventListener('change', sync);
    form.querySelectorAll('[data-password-toggle]').forEach((button) =>
        button.addEventListener('click', () => {
            const input = document.getElementById(button.dataset.passwordToggle),
                show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            button.setAttribute('aria-pressed', String(show));
            button.setAttribute(
                'aria-label',
                (show ? 'إخفاء ' : 'إظهار ') + form.querySelector('label[for="' + input.id + '"]').textContent
            );
        })
    );
    form.addEventListener('submit', (event) => {
        if (save.disabled || !form.reportValidity()) {
            event.preventDefault();
            return;
        }
        leaving = true;
        save.disabled = true;
        status.textContent = 'جارٍ حفظ كلمة المرور…';
    });
    window.addEventListener('beforeunload', (event) => {
        if (leaving || !dirty()) return;
        event.preventDefault();
        event.returnValue = '';
    });
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (
            !link ||
            leaving ||
            !dirty() ||
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey ||
            link.target === '_blank' ||
            link.getAttribute('href').startsWith('#')
        )
            return;
        if (!window.confirm('لديك تغييرات غير محفوظة في كلمة المرور. هل تريد المغادرة؟')) {
            event.preventDefault();
            return;
        }
        leaving = true;
    });
    window.addEventListener('pageshow', () => {
        leaving = false;
        sync();
    });
    sync();
})();
