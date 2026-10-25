import {
    config,
    body,
    idempotencyKeyFor,
    finishIdempotency,
    parseJsonResponse,
    openDialog,
    showFormResult,
    escapeHtml,
    formatNumber,
    portalFetch,
    portalUrl,
} from './core.js';
import {
    requestOperationPin,
    transferSuccessDialog,
    fillTransferSuccess,
    openSealConfirm,
} from './transfers.js';

const balanceTransferForm = document.getElementById('balanceTransferForm');

const balanceTransferResult = document.getElementById('balanceTransferResult');

const submitBalanceTransfer = async (bodyData) => {
    try {
        const operationPin = await requestOperationPin();
        if (operationPin === null) return;
        if (operationPin) bodyData.operationPin = operationPin;

        const balanceFingerprint = JSON.stringify({
            targetAccountCode: bodyData.targetAccountCode || '',
            amount: bodyData.amount || '',
            notes: bodyData.notes || '',
        });
        const balanceKey = idempotencyKeyFor('web-balance-transfer', balanceFingerprint);
        const transferResponse = await portalFetch(portalUrl('/client/balance-transfer'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'x-csrf-token': config.csrfToken || '',
                'Idempotency-Key': balanceKey,
            },
            body: JSON.stringify(bodyData),
        });
        const transfer = await parseJsonResponse(transferResponse);
        if (!transferResponse.ok || !transfer.success)
            throw new Error(transfer.error || 'تعذر تحويل الرصيد.');
        finishIdempotency('web-balance-transfer');
        showFormResult(
            balanceTransferResult,
            `${transfer.message} رقم العملية: ${transfer.transferId}`,
            true
        );
        fillTransferSuccess(
            {
                customId: transfer.transferId,
                message: transfer.message,
                successCopy: transfer.message || 'تم تحويل الرصيد الداخلي.',
            },
            ''
        );
        if (body.hasAttribute('data-business-shell')) openDialog(transferSuccessDialog);
        balanceTransferForm.reset();
    } catch (error) {
        showFormResult(balanceTransferResult, error.message || 'تعذر تحويل الرصيد.', false);
    }
};

balanceTransferForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!balanceTransferForm.reportValidity()) return;
    const formData = new FormData(balanceTransferForm);
    const bodyData = Object.fromEntries(formData.entries());
    try {
        const lookupResponse = await portalFetch(portalUrl('/client/balance-transfer/lookup'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'x-csrf-token': config.csrfToken || '',
            },
            body: JSON.stringify({ targetAccountCode: bodyData.targetAccountCode }),
        });
        const lookup = await parseJsonResponse(lookupResponse);
        if (!lookupResponse.ok || !lookup.success) throw new Error(lookup.error || 'تعذر التحقق من الحساب.');
        const confirmCopy = `سيتم تحويل ${bodyData.amount} LYD إلى ${lookup.target.name} (${lookup.target.accountCode}).`;
        if (config.workspaceType !== 'company') {
            if (!window.confirm(`${confirmCopy} هل تريد المتابعة؟`)) return;
            await submitBalanceTransfer(bodyData);
            return;
        }
        openSealConfirm({
            title: 'تأكيد التحويل الداخلي',
            html: `
                    <div class="bw-cost-preview">
                        <div><span>المستلم</span><strong>${escapeHtml(lookup.target.name || '')}</strong></div>
                        <div><span>رقم الحساب</span><strong class="bw-mono">${escapeHtml(lookup.target.accountCode || '')}</strong></div>
                        <div><span>المبلغ</span><strong class="bw-mono">${escapeHtml(formatNumber(Number(bodyData.amount || 0), 2))} LYD</strong></div>
                    </div>
                    <p class="bw-dialog-note">${escapeHtml(confirmCopy)}</p>`,
            onConfirm: () => submitBalanceTransfer(bodyData),
        });
    } catch (error) {
        showFormResult(balanceTransferResult, error.message || 'تعذر تحويل الرصيد.', false);
    }
});
