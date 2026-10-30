import { config } from './portal-workspace/core.js';
import './portal-workspace/transfers.js?v=20261030-retail-review';
(async () => {
    const modules = [];
    if (config.page === 'smart_transfer') modules.push(import('./portal-workspace/smart-transfer.js'));
    if (config.page === 'internal_transfer') modules.push(import('./portal-workspace/balance-transfer.js'));
    await Promise.all(modules);
    document
        .querySelectorAll('[data-dialog-close]')
        .forEach((button) => button.addEventListener('click', () => button.closest('dialog')?.close()));
    const form = document.getElementById('businessTransferForm');
    if (form) {
        const syncSummary = () => {
            const destination = document.getElementById('transferDestination');
            const name = document.getElementById('transferBeneficiary');
            const nationalId = document.getElementById('transferNationalId');
            const amount = document.getElementById('transferAmount');
            const currency = document.getElementById('transferAmountCurrency');
            const recipient = form.querySelector('[data-cm-recipient]');
            if (recipient)
                recipient.textContent =
                    (config.selectedService === 'post_card' ? nationalId?.value : destination?.value) ||
                    name?.value ||
                    '—';
            const output = form.querySelector('[data-cm-amount]');
            if (output)
                output.textContent =
                    Number(amount?.value) > 0
                        ? Number(amount.value).toLocaleString('en-US', { maximumFractionDigits: 2 }) +
                          ' ' +
                          currency?.textContent
                        : '—';
            form.querySelectorAll('[data-cm-cost]').forEach((node) => {
                node.textContent = document.getElementById('costEstimate')?.textContent || '0.000 LYD';
            });
            if (config.selectedService === 'bankak_sudan')
                document.getElementById('transferAmountLabel').textContent = 'المبلغ بالجنيه السوداني';
        };
        form.addEventListener('input', syncSummary);
        form.addEventListener('change', syncSummary);
        const cost = document.getElementById('costEstimate');
        if (cost) new MutationObserver(syncSummary).observe(cost, { childList: true, subtree: true });
        syncSummary();
        document.querySelectorAll('[data-amount-add]').forEach((button) =>
            button.addEventListener('click', () => {
                const amount = document.getElementById('transferAmount');
                amount.value = Number(amount.value || 0) + Number(button.dataset.amountAdd);
                amount.dispatchEvent(new Event('input', { bubbles: true }));
            })
        );
        document.querySelector('[data-amount-max]')?.addEventListener('click', () => {
            const service = config.services.find((item) => item.key === config.selectedService);
            if (!service || !(service.rate > 0)) return;
            let value =
                service.rateDirection === 'source_to_lyd'
                    ? config.availableBalance / service.rate
                    : config.availableBalance * service.rate;
            if (service.maxAmount) value = Math.min(value, service.maxAmount);
            value = service.integerAmount ? Math.floor(value) : Math.floor(value * 100) / 100;
            const amount = document.getElementById('transferAmount');
            amount.value = value;
            amount.dispatchEvent(new Event('input', { bubbles: true }));
        });
        document.querySelector('[data-focus-mode]')?.addEventListener('click', (event) => {
            const active = document.body.classList.toggle('retail-focus');
            event.currentTarget.textContent = active ? 'إنهاء التركيز' : 'وضع التركيز';
            event.currentTarget.setAttribute('aria-pressed', String(active));
        });
    }
    document.querySelectorAll('[data-transaction-id]').forEach((button) =>
        button.addEventListener('click', () => {
            window.location.assign(
                '/client/account?tab=operations&search=' +
                    encodeURIComponent(button.querySelector('strong')?.textContent || '')
            );
        })
    );
    document.body.dataset.workspaceReady = 'true';
})().catch((error) => console.error('[Customer transfers] initialization failed:', error));
