'use strict';
document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-transaction-id]');
    if (!button) return;
    const body = document.getElementById('txDetailsBody');
    body.textContent = 'جارٍ التحميل...';
    const dialog = document.getElementById('txDetails');
    if (!dialog.open) dialog.showModal();
    try {
        const response = await fetch(`/transactions/${encodeURIComponent(button.dataset.transactionId)}/details`, { headers: { Accept: 'application/json' } });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error('DETAILS_UNAVAILABLE');
        const tx = result.transaction;
        const rows = [
            ['رقم العملية', tx.customId], ['الشركة / الحساب', tx.companyName || tx.subAccountName || tx.employeeName],
            ['الحالة', ({ completed: 'مكتملة', accepted: 'قيد العمل', processing: 'موجهة', pending: 'معلقة', rejected: 'ملغية' })[tx.status] || tx.status],
            ['المبلغ', tx.amount], ['نوع التحويل', tx.transferType], ['المستفيد', tx.accountName],
            ['الرقم / الحساب', tx.vodafoneNumber || tx.accountNumber], ['الموظف المنفذ', tx.executorName],
            ['التاريخ', tx.createdAt ? new Date(tx.createdAt).toLocaleString('ar-EG', { timeZone: 'Africa/Tripoli' }) : '---']
        ];
        const list = document.createElement('dl');
        rows.forEach(([label, value]) => {
            const title = document.createElement('dt');
            const content = document.createElement('dd');
            title.textContent = label; content.textContent = value ?? '---';
            list.append(title, content);
        });
        body.replaceChildren(list);
    } catch (_) { body.textContent = 'تعذر تحميل تفاصيل العملية.'; }
});
