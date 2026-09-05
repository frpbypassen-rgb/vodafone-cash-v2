(function () {
    'use strict';

    const csrf = typeof csrfToken !== 'undefined' ? csrfToken : '';

    async function apiFetch(url, options = {}) {
        const opts = { ...options, headers: { ...(options.headers || {}), Accept: 'application/json' } };
        const method = String(opts.method || 'GET').toUpperCase();
        if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            opts.headers['x-csrf-token'] = csrf;
        }
        return fetch(url, opts);
    }

    function renderReport(payload) {
        const data = payload || {};
        document.getElementById('statsSection')?.classList.remove('d-none');
        document.getElementById('statOpeningBalance').textContent = Number(data.previousBalance || 0).toFixed(2);
        document.getElementById('statTotalOps').textContent = Number(data.totalLYD || 0).toFixed(2);
        document.getElementById('statCredits').textContent = Number(data.totalCredits || 0).toFixed(2);
        document.getElementById('statDeductions').textContent = Number(data.totalDeductions || 0).toFixed(2);
        document.getElementById('statOperationCount').textContent = data.operationCount || 0;
        document.getElementById('statClosingBalance').textContent = Number(data.closingBalance || 0).toFixed(2);

        const tbody = document.getElementById('reportTableBody');
        const mobile = document.getElementById('mobileReportList');
        if (tbody) tbody.innerHTML = '';
        if (mobile) mobile.innerHTML = '';
        const txs = data.operations || [];
        if (!txs.length && tbody) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">لا توجد عمليات</td></tr>';
        }
        txs.forEach((tx, i) => {
            const row = `<tr><td>${i + 1}</td><td>${tx.customId || ''}</td><td>${Number(tx.amount || 0).toFixed(2)}</td><td>${Number(tx.costLYD || 0).toFixed(2)}</td><td>${tx.status || ''}</td><td>${tx.createdAt ? new Date(tx.createdAt).toLocaleString('ar-LY') : ''}</td></tr>`;
            if (tbody) tbody.insertAdjacentHTML('beforeend', row);
            if (mobile) {
                mobile.insertAdjacentHTML('beforeend', `<div class="mobile-tx-card p-3 border rounded-3"><strong>${tx.customId || ''}</strong><div>${Number(tx.amount || 0).toFixed(2)} EGP · ${Number(tx.costLYD || 0).toFixed(2)} LYD</div></div>`);
            }
        });
        document.getElementById('tableSection')?.classList.remove('d-none');
        document.getElementById('btnDownloadPdf')?.classList.remove('d-none');

        const deposits = data.deposits || data.balanceMovements || [];
        const depList = document.getElementById('mobileDepositList');
        if (depList && deposits.length) {
            document.getElementById('depositSection')?.classList.remove('d-none');
            depList.innerHTML = deposits.map((d) => `<div class="p-2 border rounded-3 mb-2"><strong>${d.customId || ''}</strong> · ${Number(d.amount || 0).toFixed(2)} LYD</div>`).join('');
        }
    }

    window.toggleDateInput = function toggleDateInput() {
        const type = document.getElementById('dateType')?.value || 'month';
        document.getElementById('dateValueDay').style.display = type === 'day' ? '' : 'none';
        document.getElementById('dateValueMonth').style.display = type === 'month' ? '' : 'none';
        document.getElementById('dateRangeInputs')?.classList.toggle('d-none', type !== 'range');
    };

    window.fetchReport = async function fetchReport() {
        const dateType = document.getElementById('dateType')?.value || 'month';
        const body = { dateType, search: document.getElementById('reportSearch')?.value || '' };
        if (dateType === 'day') body.dateValue = document.getElementById('dateValueDay')?.value;
        if (dateType === 'month') body.dateValue = document.getElementById('dateValueMonth')?.value;
        if (dateType === 'range') {
            body.dateFrom = document.getElementById('dateFrom')?.value;
            body.dateTo = document.getElementById('dateTo')?.value;
        }
        const btn = document.getElementById('btnFetch');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
        try {
            const res = await apiFetch('/client/reports/filter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'failed');
            renderReport(data.data || {});
        } catch (_) {
            Swal.fire('تنبيه', 'تعذر تحميل التقرير.', 'warning');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-search me-1"></i> عرض'; }
        }
    };

    window.downloadAdminReportCopy = function downloadAdminReportCopy() {
        window.open('/client/reports/admin-copy.pdf', '_blank');
    };

    async function loadDeposits() {
        const listEl = document.getElementById('depositList');
        const filter = listEl?.dataset?.filter;
        if (!listEl || !filter || filter === 'new') return;
        try {
            const res = await apiFetch('/client/api/deposits');
            const data = await res.json();
            if (!data.success) throw new Error();
            if (document.getElementById('currentBalance')) {
                document.getElementById('currentBalance').textContent = `${Number(data.balance || 0).toFixed(2)} LYD`;
            }
            const map = { pending: 'pending', accepted: 'deposit', rejected: 'rejected' };
            const status = map[filter];
            const rows = (data.requests || []).filter((r) => r.status === status);
            listEl.innerHTML = rows.length
                ? rows.map((r) => `<div class="p-3 border rounded-3 mb-2"><strong class="mono-num">${r.customId}</strong><div>${Number(r.amount || 0).toFixed(2)} LYD · ${r.status}</div><small class="text-muted">${r.note || ''}</small></div>`).join('')
                : '<p class="text-muted text-center py-3">لا توجد طلبات في هذا القسم.</p>';
        } catch (_) {
            listEl.innerHTML = '<p class="text-danger text-center py-3">تعذر تحميل الطلبات.</p>';
        }
    }

    document.getElementById('depositForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('submitDepositBtn');
        btn.disabled = true;
        try {
            const res = await apiFetch('/client/api/deposits', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amount: document.getElementById('depositAmount').value,
                    note: document.getElementById('depositNote').value
                })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            Swal.fire('تم الإرسال', data.message || 'وصل الطلب للإدارة.', 'success');
            e.target.reset();
            window.location.assign('/client/account?tab=deposits-pending');
        } catch (err) {
            Swal.fire('تنبيه', err.message || 'تعذر إرسال الطلب.', 'warning');
        } finally {
            btn.disabled = false;
        }
    });

    document.addEventListener('DOMContentLoaded', () => {
        toggleDateInput();
        const now = new Date();
        const monthEl = document.getElementById('dateValueMonth');
        const dayEl = document.getElementById('dateValueDay');
        if (monthEl) monthEl.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        if (dayEl) dayEl.value = now.toISOString().slice(0, 10);
        const panel = document.getElementById('hubAccountReportsPanel');
        const mode = panel?.dataset?.mode || '';
        if (panel && !mode.startsWith('deposit') && mode !== 'export') fetchReport();
        loadDeposits();
        apiFetch('/client/api/deposits').then((r) => r.json()).then((d) => {
            if (d.success && document.getElementById('currentBalance')) {
                document.getElementById('currentBalance').textContent = `${Number(d.balance || 0).toFixed(2)} LYD`;
            }
        }).catch(() => {});
    });
}());
