import {
    openDialog,
    escapeHtml,
    formatNumber,
    parseJsonResponse,
    body,
    portalFetch,
    portalUrl,
} from './core.js';
import { openTransactionDetails } from './receipts.js';
import { setSidebar } from './shell.js';

const exportDialog = document.getElementById('reportExportDialog');

document
    .querySelectorAll('[data-report-export-open]')
    .forEach((button) => button.addEventListener('click', () => openDialog(exportDialog)));

const chart = document.getElementById('liquidityChart');

const chartDataNode = document.getElementById('liquiditySeriesData');

let liquidityRows = [];

try {
    liquidityRows = JSON.parse(chartDataNode?.textContent || '[]');
} catch (_) {
    liquidityRows = [];
}

const renderLiquidityChart = (days = '30') => {
    if (!chart || !liquidityRows.length) return;
    const rows = days === 'all' ? liquidityRows : liquidityRows.slice(-Number(days));
    const width = 760;
    const height = 250;
    const padding = 30;
    const maximum = Math.max(
        1,
        ...rows.flatMap((row) => [Number(row.incoming || 0), Number(row.outgoing || 0)])
    );
    const x = (index) => padding + (index * (width - padding * 2)) / Math.max(1, rows.length - 1);
    const y = (value) => height - padding - (Number(value || 0) / maximum) * (height - padding * 2);
    const points = (key) => rows.map((row, index) => `${x(index)},${y(row[key])}`).join(' ');
    chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="cashIn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".25"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><g class="grid"><line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}"/><line x1="${padding}" y1="${height / 2}" x2="${width - padding}" y2="${height / 2}"/><line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}"/></g><polyline class="incoming" points="${points('incoming')}"/><polyline class="outgoing" points="${points('outgoing')}"/>${rows.map((row, index) => `<circle class="incoming-dot" cx="${x(index)}" cy="${y(row.incoming)}" r="4"><title>${escapeHtml(row.date)} — وارد ${formatNumber(row.incoming, 2)}</title></circle><circle class="outgoing-dot" cx="${x(index)}" cy="${y(row.outgoing)}" r="4"><title>${escapeHtml(row.date)} — صادر ${formatNumber(row.outgoing, 2)}</title></circle>`).join('')}</svg>`;
};

document.querySelectorAll('[data-chart-days]').forEach((button) =>
    button.addEventListener('click', () => {
        document
            .querySelectorAll('[data-chart-days]')
            .forEach((item) => item.classList.toggle('active', item === button));
        renderLiquidityChart(button.dataset.chartDays);
    })
);

renderLiquidityChart('30');

const liveFeed = document.querySelector('[data-transfer-live-feed] > div');

const refreshTransferFeed = async () => {
    if (!liveFeed || document.visibilityState !== 'visible') return;
    try {
        const response = await portalFetch(portalUrl('/client/api/transactions'), {
            headers: { Accept: 'application/json' },
        });
        const payload = await parseJsonResponse(response);
        if (!response.ok || !payload.success) return;
        const labels = {
            completed: 'مكتملة',
            rejected: 'مرفوضة',
            pending: 'معلقة',
            processing: 'قيد التنفيذ',
            accepted: 'مقبولة',
        };
        liveFeed.innerHTML =
            (payload.transactions || [])
                .slice(0, 5)
                .map(
                    (transaction) =>
                        `<button type="button" data-transaction-id="${escapeHtml(transaction._id)}"><span><strong class="bw-mono">${escapeHtml(transaction.customId)}</strong><small>${escapeHtml(transaction.accountName || transaction.vodafoneNumber || transaction.accountNumber || 'مستفيد')}</small></span><b class="bw-mono">${formatNumber(transaction.amount)}</b><em class="bw-status">${escapeHtml(labels[transaction.status] || transaction.status)}</em></button>`
                )
                .join('') || '<p class="bw-live-empty">لا توجد عمليات بعد.</p>';
    } catch (_) {
        /* fallback refresh is optional */
    }
};

if (liveFeed) {
    liveFeed.addEventListener('click', (event) => {
        const row = event.target.closest('[data-transaction-id]');
        if (row) openTransactionDetails(row.dataset.transactionId);
    });
    window.setInterval(refreshTransferFeed, 20000);
    if (typeof window.io === 'function') {
        const liveSocket = window.io();
        liveSocket.on('connect', () => liveSocket.emit('client:transactions:subscribe'));
        liveSocket.on('client:transactions:changed', refreshTransferFeed);
    }
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        setSidebar(false);
        if (body.classList.contains('bw-focus-mode')) body.classList.remove('bw-focus-mode');
    }
});
