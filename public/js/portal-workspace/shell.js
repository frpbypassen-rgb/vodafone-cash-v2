import { body, root, savePreference, readPreference, config, openDialog, closeDialog } from './core.js';

const setSidebar = (open) => {
    const isDrawer = window.matchMedia('(max-width: 1050px)').matches;
    const next = Boolean(isDrawer && open);
    body.classList.toggle('bw-sidebar-open', next);
    document.querySelectorAll('[data-sidebar-toggle]').forEach((button) => {
        button.setAttribute('aria-expanded', next ? 'true' : 'false');
    });
};

const drawerQuery = window.matchMedia('(max-width: 1050px)');

const onDrawerChange = (event) => {
    if (!event.matches) setSidebar(false);
};

if (typeof drawerQuery.addEventListener === 'function') {
    drawerQuery.addEventListener('change', onDrawerChange);
} else if (typeof drawerQuery.addListener === 'function') {
    drawerQuery.addListener(onDrawerChange);
}

document.querySelectorAll('[data-sidebar-toggle]').forEach((button) => {
    button.addEventListener('click', () => setSidebar(!body.classList.contains('bw-sidebar-open')));
});

document.querySelectorAll('[data-sidebar-close]').forEach((button) => {
    button.addEventListener('click', () => setSidebar(false));
});

document.querySelectorAll('.bw-navigation a').forEach((link) => {
    link.addEventListener('click', () => setSidebar(false));
});

const resolveTheme = (preference) => {
    if (preference !== 'system') return preference;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const applyTheme = (preference) => {
    savePreference('powerpay-business-theme', preference);
    root.dataset.theme = resolveTheme(preference);
    body.dataset.theme = root.dataset.theme;
    const icon = document.querySelector('[data-theme-toggle] i');
    if (icon) icon.className = `fa-solid ${root.dataset.theme === 'dark' ? 'fa-sun' : 'fa-moon'}`;
    const select = document.querySelector('[data-preference="theme"]');
    if (select) select.value = preference;
};

const savedTheme = readPreference('powerpay-business-theme') || 'light';

const isCustomerPortal = root.getAttribute('data-portal') === 'customer' || body.classList.contains('cl-app');

if (config.workspaceType !== 'company' && !body.hasAttribute('data-business-shell') && !isCustomerPortal) {
    applyTheme(savedTheme);
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
        button.addEventListener('click', () => applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
    });
    const themeSelect = document.querySelector('[data-preference="theme"]');
    if (themeSelect) themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
}

const densitySelect = document.querySelector('[data-preference="density"]');

if (densitySelect) {
    densitySelect.value = readPreference('powerpay-business-density') || 'comfortable';
    densitySelect.addEventListener('change', () => {
        savePreference('powerpay-business-density', densitySelect.value);
        root.dataset.density = densitySelect.value;
    });
}

document.querySelectorAll('[data-notification-preference]').forEach((input) => {
    const key = `powerpay-notification-${input.dataset.notificationPreference}`;
    const stored = readPreference(key);
    if (stored !== null) input.checked = stored === 'true';
    input.addEventListener('change', () => savePreference(key, String(input.checked)));
});

const settingsShell = document.querySelector('[data-settings-shell]');

if (settingsShell) {
    const tabs = [...settingsShell.querySelectorAll('[data-settings-tab]')];
    const panels = [...settingsShell.querySelectorAll('[data-settings-panel]')];
    const activateSettingsPanel = (key) => {
        const target = panels.find((panel) => panel.id === key) || panels[0];
        if (!target) return;
        panels.forEach((panel) => {
            const active = panel === target;
            panel.hidden = !active;
            panel.classList.toggle('active', active);
        });
        tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.settingsTab === target.id));
        window.history.replaceState(null, '', `#${target.id}`);
    };
    tabs.forEach((tab) =>
        tab.addEventListener('click', () => activateSettingsPanel(tab.dataset.settingsTab))
    );
    const requested = window.location.hash.replace('#', '');
    if (requested && panels.some((panel) => panel.id === requested)) activateSettingsPanel(requested);
}

document.querySelectorAll('[data-alert-close]').forEach((button) => {
    button.addEventListener('click', () => button.closest('.bw-alert')?.remove());
});

document.querySelectorAll('[data-dialog-open]').forEach((button) => {
    button.addEventListener('click', () => openDialog(document.getElementById(button.dataset.dialogOpen)));
});

document.querySelectorAll('[data-dialog-close]').forEach((button) => {
    button.addEventListener('click', () => closeDialog(button));
});

document.querySelectorAll('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });
});

document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
        if (form.dataset.confirmAccepted === '1') {
            delete form.dataset.confirmAccepted;
            return;
        }
        event.preventDefault();
        const message = form.dataset.confirm || 'هل تريد المتابعة؟';
        const proceed = () => {
            form.dataset.confirmAccepted = '1';
            if (typeof form.requestSubmit === 'function') form.requestSubmit();
            else form.submit();
        };
        if (config.workspaceType !== 'company') {
            if (window.confirm(message)) proceed();
            return;
        }
        const dialog = document.getElementById('companyActionDialog');
        const copy = document.getElementById('companyActionCopy');
        const submit = document.getElementById('companyActionSubmit');
        if (!dialog || !copy || !submit) {
            if (window.confirm(message)) proceed();
            return;
        }
        copy.textContent = message;
        const onSubmit = () => {
            submit.removeEventListener('click', onSubmit);
            dialog.removeEventListener('close', onClose);
            dialog.close();
            proceed();
        };
        const onClose = () => {
            submit.removeEventListener('click', onSubmit);
            dialog.removeEventListener('close', onClose);
        };
        submit.addEventListener('click', onSubmit);
        dialog.addEventListener('close', onClose);
        openDialog(dialog);
    });
});

const customerBalanceDialog = document.getElementById('customerBalanceDialog');

const customerBalanceForm = document.getElementById('customerBalanceForm');

const customerBalanceName = document.getElementById('customerBalanceName');

document.querySelectorAll('[data-customer-balance]').forEach((button) => {
    button.addEventListener('click', () => {
        if (!customerBalanceDialog || !customerBalanceForm) return;
        customerBalanceForm.action = `/client/customers/${encodeURIComponent(button.dataset.customerId)}/balance`;
        if (customerBalanceName) customerBalanceName.textContent = button.dataset.customerName || 'العميل';
        openDialog(customerBalanceDialog);
    });
});

const staffPasswordDialog = document.getElementById('staffPasswordDialog');

const staffPasswordForm = document.getElementById('staffPasswordForm');

const staffPasswordName = document.getElementById('staffPasswordName');

document.querySelectorAll('[data-staff-password]').forEach((button) => {
    button.addEventListener('click', () => {
        if (!staffPasswordDialog || !staffPasswordForm) return;
        staffPasswordForm.action = `/client/${config.workspaceType === 'company' ? 'company' : 'agent'}/staff/${encodeURIComponent(button.dataset.memberId)}/password`;
        if (staffPasswordName) staffPasswordName.textContent = button.dataset.memberName || 'الموظف';
        const usernameInput = document.getElementById('staffPasswordUsername');
        if (usernameInput) usernameInput.value = button.dataset.memberUsername || '';
        openDialog(staffPasswordDialog);
    });
});

export { setSidebar };
