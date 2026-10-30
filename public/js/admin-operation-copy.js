(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.mount(root.document, root.navigator);
})(typeof window === 'undefined' ? this : window, function () {
    'use strict';
    const clean = (value) =>
        String(value ?? '')
            .replace(/[\x00-\x1f\x7f]/g, ' ')
            .trim();
    const formatOperation = (tx) => {
        const sender =
            [
                ...new Set(
                    [tx.companyName, tx.subAccountName, tx.employeeName]
                        .map(clean)
                        .filter((value) => value && !['---', '—'].includes(value))
                ),
            ].join(' — ') || 'غير مسجلة';
        const bank =
            ['bank_account', 'bank_transfer'].includes(tx.transferType) ||
            ['bank_account', 'bank_transfer'].includes(tx.canonicalServiceKey);
        const recipient =
            clean(bank ? tx.accountNumber || tx.vodafoneNumber : tx.vodafoneNumber || tx.accountNumber) ||
            'غير مسجل';
        const preferred = tx.serviceDetails?.amountCurrency;
        const currency =
            ['deposit', 'deduction'].includes(tx.status) || tx.transferType === 'balance_transfer'
                ? 'LYD'
                : ['EGP', 'LYD', 'SDG', 'XOF', 'USD', 'EUR'].includes(preferred)
                  ? preferred
                  : 'EGP';
        const value =
            tx.amount === null || tx.amount === undefined || tx.amount === '' ? NaN : Number(tx.amount);
        const amount = Number.isFinite(value)
            ? value.toLocaleString('en-US', {
                  minimumFractionDigits: currency === 'LYD' ? 3 : 2,
                  maximumFractionDigits: currency === 'LYD' ? 3 : 2,
              }) +
              ' ' +
              currency
            : 'غير مسجل';
        return `الجهة المرسلة: ${sender}\nرقم الحساب / الهاتف: ${recipient}\nالمبلغ: ${amount}`;
    };
    const mount = (document, navigator) => {
        let notice, noticeTimer;
        const feedback = (text) => {
            if (!notice) {
                notice = document.createElement('div');
                notice.className = 'tx-copy-feedback';
                notice.setAttribute('role', 'status');
                notice.setAttribute('aria-live', 'polite');
                document.body.append(notice);
            }
            notice.textContent = text;
            notice.hidden = false;
            clearTimeout(noticeTimer);
            noticeTimer = setTimeout(() => {
                notice.hidden = true;
            }, 5000);
        };
        const write = async (text) => {
            try {
                await navigator.clipboard.writeText(text);
                return;
            } catch (_) {
                /* Older or restricted browsers. */
            }
            const input = document.createElement('textarea'),
                focused = document.activeElement;
            input.value = text;
            input.readOnly = true;
            input.className = 'tx-copy-fallback';
            document.body.append(input);
            input.select();
            let copied = false;
            try {
                copied = document.execCommand('copy');
            } finally {
                input.remove();
                focused?.focus({ preventScroll: true });
            }
            if (!copied) throw new Error('COPY_FAILED');
        };
        document.addEventListener('click', async (event) => {
            const button = event.target.closest('[data-copy-operation]');
            if (!button || button.disabled) return;
            event.preventDefault();
            event.stopPropagation();
            button.disabled = true;
            try {
                // Rows are replaced during live refresh: always read the current snapshot.
                const rows = JSON.parse(document.getElementById('transactionRowsData')?.textContent || '{}');
                const tx = rows[button.dataset.copyOperation];
                if (!tx) throw new Error('ROW_UNAVAILABLE');
                await write(formatOperation(tx));
                feedback('تم نسخ الجهة المرسلة ورقم الحساب والمبلغ.');
            } catch (_) {
                feedback('تعذر النسخ. حدّث السجل واسمح للمتصفح باستخدام الحافظة ثم حاول مجددًا.');
            } finally {
                button.disabled = false;
            }
        });
    };
    return { formatOperation, mount };
});
