/* exported renderStats, renderOperations, reportChartInstance, renderReportChart, buildRow, buildMobileCard */
function renderStats(data) {
    const grid = document.getElementById('statsGrid');
    const fs = data.financialSummary;
    const isPersonal = data.scope === 'employee';

    const stats = [
        { icon: 'fa-list-check', color: 'stat-blue', label: 'عدد العمليات', value: data.operationCount || 0 },
        {
            icon: 'fa-sack-dollar',
            color: 'stat-green',
            label: 'إجمالي العمليات',
            value: formatEgp(data.totalEGP || 0),
        },
    ];

    if (!isPersonal && fs) {
        stats.push(
            {
                icon: 'fa-wallet',
                color: 'stat-gold',
                label: 'الرصيد السابق',
                value: formatEgp(fs.openingBalance),
            },
            {
                icon: 'fa-arrow-down',
                color: 'stat-green',
                label: 'الإيداعات',
                value: formatEgp(fs.additions),
            },
            { icon: 'fa-arrow-up', color: 'stat-red', label: 'الخصومات', value: formatEgp(fs.deductions) },
            {
                icon: 'fa-scale-balanced',
                color: 'stat-blue',
                label: 'الإجمالي / الرصيد الحالي',
                value: formatEgp(fs.closingBalance),
            }
        );
    } else {
        stats.push(
            { icon: 'fa-ban', color: 'stat-red', label: 'الملغاة', value: data.summary?.cancelledCount || 0 },
            {
                icon: 'fa-clock',
                color: 'stat-gold',
                label: 'متوسط المدة',
                value: data.summary?.averageDurationSeconds
                    ? `${Math.floor(data.summary.averageDurationSeconds / 60)}د ${data.summary.averageDurationSeconds % 60}ث`
                    : '---',
            }
        );
    }

    grid.innerHTML = stats
        .map(
            (s, i) => `
                <div class="x-stat-box ${s.color}" style="animation-delay:${i * 0.05}s">
                    <i class="fa-solid ${s.icon}"></i>
                    <small>${s.label}</small>
                    <strong>${s.value}</strong>
                </div>
            `
        )
        .join('');
}

function renderOperations(data) {
    const tbody = document.getElementById('reportTableBody');
    tbody.innerHTML = '';
    const mobileList = document.getElementById('mobileReportList');
    if (mobileList) mobileList.innerHTML = '';

    const cancelled = Array.isArray(data.cancelledOperations) ? data.cancelledOperations : [];
    const cancelledTbody = document.getElementById('cancelledReportTableBody');
    const mobileCancelledList = document.getElementById('mobileCancelledList');
    cancelledTbody.innerHTML = '';
    if (mobileCancelledList) mobileCancelledList.innerHTML = '';
    document.getElementById('cancelledSection').classList.toggle('d-none', cancelled.length === 0);

    const operations = allReportOperations(data);
    if (operations.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${isPersonalExecutorReport ? 10 : 11}" class="text-center text-muted py-4">لا توجد عمليات في هذه الفترة</td></tr>`;
        if (mobileList) mobileList.innerHTML = '<div class="x-empty-box">لا توجد عمليات في هذه الفترة</div>';
    } else {
        operations.forEach((tx, i) => {
            const row = buildRow(tx, i);
            tbody.appendChild(row);
            if (mobileList) mobileList.appendChild(buildMobileCard(tx));
        });
    }

    cancelled.forEach((tx, index) => {
        const date = new Date(tx.completedAt || tx.createdAt);
        const dateText = date.toLocaleString('en-GB', { timeZone: 'Africa/Tripoli', hour12: true });
        const reference = tx.customId || tx.id || '---';
        const amount = Number(tx.amount || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="text-muted">${index + 1}</td><td dir="ltr" class="fw-bold">${reference}</td><td>${amount} ج.م</td><td dir="ltr">${dateText}</td><td><span class="badge-st st-fail">ملغاة</span></td>`;
        cancelledTbody.appendChild(tr);
        if (mobileCancelledList) {
            const card = document.createElement('div');
            card.className = 'x-mobile-card';
            card.innerHTML = `<div class="x-mobile-card-header"><span class="x-mobile-card-id">#${reference}</span><span class="badge-st st-fail">ملغاة</span></div><div class="x-mobile-card-body"><span class="x-mobile-amount">${amount} ج.م</span><span class="x-mobile-meta">${dateText}</span></div>`;
            mobileCancelledList.appendChild(card);
        }
    });
}

let reportChartInstance = null;
function renderReportChart(data) {
    const ctx = document.getElementById('reportChart');
    if (!ctx) return;
    if (typeof Chart === 'undefined') {
        ctx.parentElement.innerHTML =
            '<div class="text-center text-muted small py-4">تعذر تحميل الرسم البياني، لكن تفاصيل التقرير والعمليات ظاهرة بالأسفل.</div>';
        return;
    }
    if (reportChartInstance) {
        reportChartInstance.destroy();
    }
    const days = {};
    allReportOperations(data).forEach((tx) => {
        if (!tx.createdAt) return;
        const d = new Date(tx.createdAt).toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' });
        days[d] = (days[d] || 0) + 1;
    });
    const labels = Object.keys(days).sort();
    const values = labels.map((d) => days[d]);
    if (labels.length === 0) {
        ctx.parentElement.innerHTML =
            '<div class="text-center text-muted small py-4">لا توجد بيانات كافية للرسم البياني</div>';
        return;
    }
    reportChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'عدد العمليات',
                    data: values,
                    backgroundColor: 'rgba(34, 211, 238, 0.25)',
                    borderColor: '#22d3ee',
                    borderWidth: 1,
                    borderRadius: 8,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8' },
                },
                x: { grid: { display: false }, ticks: { color: '#94a3b8' } },
            },
        },
    });
}

function buildRow(tx, i) {
    const tr = document.createElement('tr');
    tr.onclick = () => openOperationDetail(tx);
    let statusHtml = '';
    if (tx.status === 'completed')
        statusHtml =
            '<span class="badge-st st-done"><span class="indicator-dot dot-done"></span>مكتمل</span>';
    else if (tx.status === 'rejected' || tx.status === 'cancelled_by_admin')
        statusHtml =
            '<span class="badge-st st-fail"><span class="indicator-dot dot-fail"></span>مرفوض</span>';
    else
        statusHtml =
            '<span class="badge-st st-pending"><span class="indicator-dot dot-pending"></span>قيد التنفيذ</span>';

    const dateObj = new Date(tx.createdAt);
    const dateStr = dateObj.toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' });
    const arrivalTime = dateObj.toLocaleTimeString('en-US', {
        timeZone: 'Africa/Tripoli',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    });
    let completionTime = '---';
    if (tx.completedAt) {
        completionTime = new Date(tx.completedAt).toLocaleTimeString('en-US', {
            timeZone: 'Africa/Tripoli',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
        });
    }
    let duration = '---';
    if (tx.executionDurationSeconds !== null && tx.executionDurationSeconds !== undefined) {
        const m = Math.floor(tx.executionDurationSeconds / 60);
        const s = tx.executionDurationSeconds % 60;
        duration = m > 0 ? `${m}د ${s}ث` : `${s}ث`;
    }
    const by = tx.executorName || '---';
    const typeLabel = tx.transferTypeLabel || 'محافظ كاش';

    tr.innerHTML = `
                <td class="text-muted fw-bold">${i + 1}</td>
                <td dir="ltr" class="fw-bold text-center">#${tx.customId || String(tx.id || '').slice(-6)}</td>
                <td>${typeLabel}</td>
                <td class="fw-bold">${formatEgp(tx.amount)}</td>
                <td dir="ltr" class="text-center" style="font-size:0.85rem; font-family:monospace;">${tx.recipientNumber || '---'}</td>
                <td dir="ltr" class="text-center" style="font-size:0.85rem; font-family:monospace;">${arrivalTime}</td>
                <td dir="ltr" class="text-center" style="font-size:0.85rem; font-family:monospace;">${completionTime}</td>
                <td class="fw-bold text-success" style="font-size:0.85rem;">${duration}</td>
                <td>${statusHtml}</td>
                <td><div dir="ltr" style="font-size:0.85em;" class="text-center fw-bold">${dateStr}</div></td>
                ${isPersonalExecutorReport ? '' : `<td>${by}</td>`}
            `;
    return tr;
}

function buildMobileCard(tx) {
    const card = document.createElement('div');
    card.className = 'x-mobile-card';
    card.onclick = () => openOperationDetail(tx);
    let statusHtml = '';
    if (tx.status === 'completed') statusHtml = '<span class="badge-st st-done">مكتمل</span>';
    else if (tx.status === 'rejected' || tx.status === 'cancelled_by_admin')
        statusHtml = '<span class="badge-st st-fail">مرفوض</span>';
    else statusHtml = '<span class="badge-st st-pending">قيد التنفيذ</span>';
    const dateObj = new Date(tx.createdAt);
    const dateStr = dateObj.toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' });
    const typeLabel = tx.transferTypeLabel || 'محافظ كاش';
    card.innerHTML = `
                <div class="x-mobile-card-header">
                    <span class="x-mobile-card-id">#${tx.customId || String(tx.id || '').slice(-6)}</span>
                    <span>${statusHtml}</span>
                </div>
                <div class="x-mobile-card-body">
                    <span class="x-mobile-amount">${Number(tx.amount || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })} ج.م</span>
                    <span class="x-mobile-meta">${typeLabel}</span>
                </div>
                <div class="x-mobile-card-details">
                    <span>المستلم <b dir="ltr">${tx.recipientNumber || '---'}</b></span>
                    <span>التاريخ <b dir="ltr">${dateStr}</b></span>
                    ${isPersonalExecutorReport ? '' : `<span>المنفذ <b>${tx.executorName || '---'}</b></span>`}
                </div>
            `;
    return card;
}
