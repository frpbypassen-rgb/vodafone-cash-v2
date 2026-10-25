import '../business-portal/api-response.js';

const config =
    document.documentElement.dataset.portal === 'agent'
        ? window.agentPortal || {}
        : window.businessPortal || {};

const root = document.documentElement;

const body = document.body;

const readPreference = (key) => {
    try {
        return localStorage.getItem(config.workspaceType === 'agent' ? storageKey(key) : key);
    } catch (_) {
        return null;
    }
};

const savePreference = (key, value) => {
    try {
        localStorage.setItem(config.workspaceType === 'agent' ? storageKey(key) : key, value);
    } catch (_) {
        /* Preferences must not block transfers. */
    }
};

const escapeHtml = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

const idempotencySlots = new Map();

const newIdempotencyKey = () =>
    window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
              const rand = (Math.random() * 16) | 0;
              const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
              return value.toString(16);
          });

const idempotencyKeyFor = (slot, fingerprint) => {
    const current = idempotencySlots.get(slot);
    if (!current || current.fingerprint !== fingerprint) {
        const next = { fingerprint, key: newIdempotencyKey() };
        idempotencySlots.set(slot, next);
        return next.key;
    }
    return current.key;
};

const finishIdempotency = (slot) => idempotencySlots.delete(slot);

const formatNumber = (value, digits = 0) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    return number.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
};

const formatDateTime = (value) => {
    if (!value) return '---';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '---';
    return `${date.toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' })} - ${date.toLocaleTimeString('ar-LY', { timeZone: 'Africa/Tripoli', hour: '2-digit', minute: '2-digit' })}`;
};

const parseJsonResponse = window.businessPortalApi.readResponse;

const openDialog = (dialog) => {
    if (!dialog || typeof dialog.showModal !== 'function') return;
    dialog.showModal();
};

const closeDialog = (button) => {
    const dialog = button.closest('dialog');
    if (dialog?.open) dialog.close();
};

const showFormResult = (element, message, success) => {
    if (!element) return;
    element.hidden = false;
    element.className = `bw-form-result ${success ? 'success' : 'danger'}`;
    element.innerHTML = `<i class="fa-solid ${success ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i> ${escapeHtml(message)}`;
};

const fileToDataUrl = (file) =>
    new Promise((resolve, reject) => {
        if (!file) return resolve(null);
        if (file.size > 4 * 1024 * 1024) return reject(new Error('حجم الصورة يجب ألا يتجاوز 4MB.'));
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('تعذر قراءة الصورة.'));
        reader.readAsDataURL(file);
    });

const portalUrl = (value) =>
    typeof value === 'string' && config.workspaceType === 'agent'
        ? value.replace(/^\/client(?=\/|$)/, config.basePath || '/agent-portal')
        : value;
const portalFetch = (input, options) =>
    window.fetch(typeof input === 'string' ? portalUrl(input) : input, options);
const storageKey = (name) => config.workspaceType + ':' + (config.notificationScope || 'local') + ':' + name;

export {
    config,
    portalUrl,
    portalFetch,
    storageKey,
    body,
    root,
    savePreference,
    readPreference,
    openDialog,
    closeDialog,
    formatNumber,
    escapeHtml,
    parseJsonResponse,
    showFormResult,
    idempotencyKeyFor,
    finishIdempotency,
    formatDateTime,
    fileToDataUrl,
};
