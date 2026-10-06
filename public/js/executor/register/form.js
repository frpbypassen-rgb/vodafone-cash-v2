(() => {
    const form = document.getElementById('executorRegistrationForm');

    document.querySelectorAll('[data-password-toggle]').forEach((button) => {
        button.addEventListener('click', () => {
            const input = document.getElementById(button.dataset.passwordToggle);
            const icon = button.querySelector('i');
            const shouldShow = input.type === 'password';
            input.type = shouldShow ? 'text' : 'password';
            icon.classList.toggle('fa-eye', !shouldShow);
            icon.classList.toggle('fa-eye-slash', shouldShow);
            button.setAttribute('aria-label', shouldShow ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
            button.setAttribute('title', shouldShow ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
        });
    });

    const copyStatus = document.getElementById('copyStatus');
    document.querySelectorAll('[data-copy-target]').forEach((button) => {
        button.addEventListener('click', async () => {
            const target = document.getElementById(button.dataset.copyTarget);
            try {
                await navigator.clipboard.writeText(target.textContent.trim());
                copyStatus.textContent = 'تم النسخ بنجاح';
                button.querySelector('i').className = 'fa-solid fa-check';
                window.setTimeout(() => {
                    copyStatus.textContent = '';
                    button.querySelector('i').className = 'fa-regular fa-copy';
                }, 1800);
            } catch {
                copyStatus.textContent = 'تعذر النسخ تلقائياً';
            }
        });
    });

    if (!form) return;

    const fields = {
        companyName: document.getElementById('companyName'),
        managerName: document.getElementById('managerName'),
        phone: document.getElementById('phone'),
        executorServiceKey: document.getElementById('executorServiceKey'),
        webUsername: document.getElementById('webUsername'),
        webPassword: document.getElementById('webPassword'),
        confirmPassword: document.getElementById('confirmPassword'),
    };
    const passwordStrength = document.getElementById('passwordStrength');
    const strengthLabel = passwordStrength.querySelector('.strength-label');

    const setFieldState = (name, message) => {
        const wrapper = form.querySelector(`[data-field="${name}"]`);
        const error = form.querySelector(`[data-error-for="${name}"]`);
        wrapper.classList.toggle('is-invalid', Boolean(message));
        wrapper.classList.toggle('is-valid', !message && Boolean(fields[name].value.trim()));
        fields[name].setAttribute('aria-invalid', message ? 'true' : 'false');
        error.textContent = message;
        return !message;
    };

    const validateField = (name) => {
        const input = fields[name];
        const value = input.value.trim();
        let message = '';

        if (!value) {
            message = 'هذا الحقل مطلوب.';
        } else if ((name === 'companyName' || name === 'managerName') && value.length < 3) {
            message = 'يجب إدخال 3 أحرف على الأقل.';
        } else if (name === 'phone' && value.replace(/\D/g, '').length < 8) {
            message = 'أدخل رقم هاتف صحيحاً.';
        } else if (name === 'webUsername' && !/^[A-Za-z0-9_]{3,}$/.test(value)) {
            message = 'استخدم 3 أحرف إنجليزية أو أرقام على الأقل.';
        } else if (name === 'webPassword' && value.length < 8) {
            message = 'يجب ألا تقل كلمة المرور عن 8 أحرف.';
        } else if (name === 'confirmPassword' && value !== fields.webPassword.value) {
            message = 'كلمتا المرور غير متطابقتين.';
        }

        return setFieldState(name, message);
    };

    const updatePasswordStrength = () => {
        const value = fields.webPassword.value;
        let level = 0;
        let label = '6 أحرف على الأقل';

        if (value) {
            const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((rule) =>
                rule.test(value)
            ).length;
            level = value.length < 8 ? 1 : value.length >= 10 && variety >= 3 ? 3 : 2;
            label = level === 1 ? 'ضعيفة' : level === 2 ? 'متوسطة' : 'قوية';
        }

        passwordStrength.dataset.level = String(level);
        strengthLabel.textContent = label;
    };

    fields.webUsername.addEventListener('input', () => {
        const withoutDomain = fields.webUsername.value.replace(/@ahram\.com$/i, '');
        fields.webUsername.value = withoutDomain.replace(/[^A-Za-z0-9_]/g, '');
    });

    Object.entries(fields).forEach(([name, input]) => {
        input.addEventListener('blur', () => validateField(name));
        input.addEventListener('input', () => {
            if (form.querySelector(`[data-field="${name}"]`).classList.contains('is-invalid')) {
                validateField(name);
            }
            if (name === 'webPassword') {
                updatePasswordStrength();
                if (fields.confirmPassword.value) validateField('confirmPassword');
            }
        });
    });

    form.addEventListener('submit', (event) => {
        const validity = Object.keys(fields).map(validateField);
        if (validity.includes(false)) {
            event.preventDefault();
            const firstInvalid = form.querySelector('.field.is-invalid input, .field.is-invalid select');
            firstInvalid?.focus();
            return;
        }

        const submitButton = document.getElementById('submitBtn');
        submitButton.disabled = true;
        submitButton.classList.add('is-loading');
    });

    updatePasswordStrength();
})();
