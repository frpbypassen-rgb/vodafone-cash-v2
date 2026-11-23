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
        const lengthRule = form.querySelector('[data-password-length]');
        const matchRule = form.querySelector('[data-password-match]');
        lengthRule.classList.toggle('is-valid', length);
        matchRule.classList.toggle('is-valid', match);
        lengthRule.querySelector('[data-rule-text]').textContent = length ? 'الطول مناسب' : '8 أحرف على الأقل';
        matchRule.querySelector('[data-rule-text]').textContent = match ? 'كلمتا المرور متطابقتان'
            : confirm.value ? 'كلمتا المرور غير متطابقتين' : 'تطابق كلمة المرور وتأكيدها';
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
            const icon = button.querySelector('i');
            icon.classList.toggle('fa-eye', !show);
            icon.classList.toggle('fa-eye-slash', show);
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
