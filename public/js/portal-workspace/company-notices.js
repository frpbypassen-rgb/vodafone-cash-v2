import { config, parseJsonResponse, openDialog, showFormResult, portalFetch, portalUrl } from './core.js';

const companyWelcomeDialog = document.getElementById('companyWelcomeDialog');

const companyMessageDialog = document.getElementById('companyMessageDialog');

const companyMessageTitle = document.getElementById('companyMessageTitle');

const companyMessageCopy = document.getElementById('companyMessageCopy');

const companyLowBalanceDialog = document.getElementById('companyLowBalanceDialog');

const companyAlertKey = (name) => `company-os-alert:${config.notificationScope || 'local'}:${name}`;

const alertMemory = new Map();

const readCompanyAlert = (name) => {
    const key = companyAlertKey(name);
    for (const storageName of ['localStorage', 'sessionStorage']) {
        try {
            const value = window[storageName].getItem(key);
            if (value) return value;
        } catch (_) {
            /* Try the next available storage. */
        }
    }
    return alertMemory.get(key);
};

const saveCompanyAlert = (name, value) => {
    const key = companyAlertKey(name);
    if (value) alertMemory.set(key, value);
    else alertMemory.delete(key);
    for (const storageName of ['localStorage', 'sessionStorage']) {
        try {
            if (value) window[storageName].setItem(key, value);
            else window[storageName].removeItem(key);
        } catch (_) {
            /* Storage is optional in private browsers. */
        }
    }
};

const clearLegacyRateMessageMarkers = () => {
    try {
        Object.keys(localStorage)
            .filter((key) => key.startsWith('company-os-seen-rate:'))
            .forEach((key) => localStorage.removeItem(key));
    } catch (_) {
        /* optional */
    }
};

if (config.workspaceType === 'company') clearLegacyRateMessageMarkers();

const noteSeenKey = (note) => (note?._id ? `company-os-seen-note:${note._id}` : '');

const wasNoteSeen = (note) => {
    const key = noteSeenKey(note);
    if (!key) return false;
    try {
        return localStorage.getItem(key) === '1';
    } catch (_) {
        return false;
    }
};

const rememberNote = (note) => {
    const key = noteSeenKey(note);
    if (!key) return;
    try {
        localStorage.setItem(key, '1');
    } catch (_) {
        /* optional */
    }
};

const ackCompanyNote = async (note) => {
    if (!note?._id) return;
    rememberNote(note);
    await portalFetch(`/client/api/notifications/${encodeURIComponent(note._id)}/read`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'x-csrf-token': config.csrfToken || '' },
    }).catch(() => {});
};

const showAdminMessage = async () => {
    if (
        config.workspaceType !== 'company' ||
        !companyMessageDialog ||
        companyMessageDialog.open ||
        companyWelcomeDialog?.open ||
        companyLowBalanceDialog?.open
    )
        return;
    try {
        const response = await portalFetch(portalUrl('/client/api/notifications/unread'), {
            headers: { Accept: 'application/json' },
        });
        const payload = await parseJsonResponse(response);
        const note = (payload.notifications || []).find((item) => {
            if (!item?._id || wasNoteSeen(item)) return false;
            if (item.type === 'rate_change') return false;
            return true;
        });
        if (!note) return;
        rememberNote(note);
        void ackCompanyNote(note);
        if (companyMessageTitle) companyMessageTitle.textContent = note.title || 'رسالة من الإدارة';
        if (companyMessageCopy) companyMessageCopy.textContent = note.message || '';
        const ack = document.getElementById('companyMessageAck');
        if (ack) {
            ack.onclick = () => {
                void ackCompanyNote(note);
                companyMessageDialog.close();
            };
        }
        companyMessageDialog.addEventListener(
            'close',
            () => {
                void ackCompanyNote(note);
            },
            { once: true }
        );
        openDialog(companyMessageDialog);
    } catch (_) {
        /* optional */
    }
};

const showLowBalanceAlert = () => {
    const alert = config.lowBalanceAlert;
    if (config.workspaceType !== 'company' || !companyLowBalanceDialog) return false;
    if (!alert) {
        // Re-arm only after the balance has recovered, not on every amount change.
        if (config.canViewBalance) saveCompanyAlert('low-balance', null);
        return false;
    }
    const alertState = `${alert.tone || 'warning'}:${alert.title || ''}`;
    if (readCompanyAlert('low-balance') === alertState) return false;
    const title = document.getElementById('companyLowBalanceTitle');
    const copy = document.getElementById('companyLowBalanceCopy');
    if (title) title.textContent = alert.title;
    if (copy) copy.textContent = alert.copy;
    companyLowBalanceDialog.dataset.tone = alert.tone || 'warning';
    openDialog(companyLowBalanceDialog);
    if (companyLowBalanceDialog.open) saveCompanyAlert('low-balance', alertState);
    return true;
};

const afterCompanyWelcome = () => {
    if (showLowBalanceAlert()) {
        companyLowBalanceDialog.addEventListener(
            'close',
            () => {
                window.setTimeout(showAdminMessage, 250);
            },
            { once: true }
        );
        return;
    }
    window.setTimeout(showAdminMessage, 400);
};

const showCompanyWelcome = () => {
    if (config.workspaceType !== 'company' || !companyWelcomeDialog) {
        afterCompanyWelcome();
        return;
    }
    let alreadySeen = Boolean(readCompanyAlert('welcome'));
    // Preserve the current tab's acknowledgement when upgrading the portal.
    try {
        alreadySeen ||= Boolean(sessionStorage.getItem('company-os-welcome'));
    } catch (_) {
        /* optional */
    }
    if (alreadySeen) {
        saveCompanyAlert('welcome', '1');
        afterCompanyWelcome();
        return;
    }
    companyWelcomeDialog.addEventListener('close', afterCompanyWelcome, { once: true });
    openDialog(companyWelcomeDialog);
    if (companyWelcomeDialog.open) saveCompanyAlert('welcome', '1');
};

showCompanyWelcome();

const companyDepositForm = document.getElementById('companyDepositForm');

const companyDepositResult = document.getElementById('companyDepositResult');

companyDepositForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const amount = Number(document.getElementById('companyDepositAmount')?.value || 0);
    const note = String(document.getElementById('companyDepositNote')?.value || '').trim();
    if (!(amount > 0) || note.length < 3) {
        showFormResult(companyDepositResult, 'أدخل قيمة صحيحة وملاحظة توضح مرجع الإيداع.', false);
        return;
    }
    const submit = document.getElementById('companyDepositSubmit');
    if (submit) submit.disabled = true;
    try {
        const response = await portalFetch(portalUrl('/client/api/support/messages'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'x-csrf-token': config.csrfToken || '',
            },
            body: JSON.stringify({
                text: `طلب إيداع رصيد\nالقيمة: ${amount.toFixed(2)} LYD\nالملاحظة: ${note}`,
            }),
        });
        const payload = await parseJsonResponse(response);
        if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر إرسال طلب الإيداع.');
        showFormResult(companyDepositResult, 'تم إرسال طلب الإيداع إلى الإدارة عبر الدعم الفني.', true);
        companyDepositForm.reset();
        window.setTimeout(() => window.location.reload(), 700);
    } catch (error) {
        showFormResult(companyDepositResult, error.message || 'تعذر إرسال طلب الإيداع.', false);
    } finally {
        if (submit) submit.disabled = false;
    }
});

const companyLogoutDialog = document.getElementById('companyLogoutDialog');

if (config.workspaceType === 'company' && companyLogoutDialog) {
    document.querySelectorAll('a[href="/client/logout"]').forEach((link) => {
        if (link.hasAttribute('data-logout-confirm')) return;
        link.addEventListener('click', (event) => {
            event.preventDefault();
            openDialog(companyLogoutDialog);
        });
    });
}
