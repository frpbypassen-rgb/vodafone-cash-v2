'use strict';

// Event delegation also covers transaction rows replaced by live refresh.
document.addEventListener('click', event => {
    const button = event.target.closest('[data-provider-communication]');
    if (!button) return;
    let closed = false;
    let timer;
    let request;
    let failures = 0;
    const close = () => {
        closed = true;
        clearTimeout(timer);
        request?.abort();
    };
    const refresh = async popup => {
        const current = () => !closed && Swal.getPopup() === popup;
        if (!current()) return;
        request = new AbortController();
        const deadline = setTimeout(() => request.abort(), 10000);
        try {
            const response = await fetch(button.dataset.observationUrl, {
                credentials: 'same-origin', cache:'no-store', headers:{Accept:'application/json'}, signal:request.signal
            });
            if (!current() || response.status === 204) return;
            if (response.redirected) throw Object.assign(new Error('SESSION_EXPIRED'), { status:401 });
            if (!response.ok) throw Object.assign(new Error('READ_FAILED'), { status:response.status });
            const result = await response.json();
            if (!current() || typeof result.text !== 'string') return;
            failures = 0;
            Swal.getHtmlContainer().textContent = result.text;
            button.dataset.providerCommunication = result.text;
            button.title = result.title + ' — ' + result.receipt;
            button.setAttribute('aria-label', button.title);
            button.classList.toggle('btn-success', result.confirmed);
            button.classList.toggle('btn-outline-warning', !result.confirmed);
            const icon = button.querySelector('i');
            icon.classList.toggle('fa-comment-dots', result.confirmed);
            icon.classList.toggle('fa-clock', !result.confirmed);
            const label = button.parentElement?.querySelector('[data-provider-pending-label]');
            if (label) {
                label.textContent = result.pendingLabel;
                label.hidden = !result.pendingLabel;
            }
            const badge = button.closest('tr,.mobile-tx-card')?.querySelector('[data-provider-row-state]');
            if (badge && result.rowStatus) badge.textContent = result.rowStatus;
            if (result.refresh) timer = setTimeout(() => refresh(popup), 5000);
        } catch (error) {
            if (!current()) return;
            Swal.getHtmlContainer().textContent = button.dataset.providerCommunication + '\nتعذر تحديث السجل من الموقع.';
            if (++failures < 3 && ![401,403,404].includes(error.status)) timer = setTimeout(() => refresh(popup), 5000 * failures);
        } finally { clearTimeout(deadline); }
    };
    Swal.fire({
        titleText: 'سجل التخاطب مع المزود',
        text: button.dataset.providerCommunication,
        confirmButtonText: 'حسنًا',
        didOpen: popup => {
            const content = Swal.getHtmlContainer();
            if (content) content.style.whiteSpace = 'pre-line';
            void refresh(popup);
        },
        willClose: close,
        didDestroy: close
    });
});
