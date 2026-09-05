(function initClientWebOs(global) {
    'use strict';

    const paletteEl = () => document.getElementById('clientOsCommandPalette');
    const paletteInput = () => document.getElementById('clientOsPaletteInput');
    const paletteList = () => document.getElementById('clientOsPaletteList');
    const inspectorEl = () => document.getElementById('clientOsInspector');
    const inspectorBackdrop = () => document.getElementById('clientOsInspectorBackdrop');
    const shellEl = () => document.querySelector('.client-os-shell.with-inspector-dock');

    let paletteItems = [];
    let paletteActiveIndex = 0;
    let filterTimer = null;

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[char]));
    }

    function buildPaletteItems() {
        const items = [
            { label: 'مركز القيادة', hint: 'الصفحة الرئيسية', icon: 'fa-grid-2', action: () => { global.location.href = '/client/dashboard'; } },
            { label: 'تحويل مالي', hint: 'بدء عملية جديدة', icon: 'fa-paper-plane', shortcut: '+', action: openTransferModal },
            { label: 'تحويل رصيد', hint: 'إدارة الرصيد المتاح', icon: 'fa-wallet', action: () => global.openBalanceTransferModal?.() },
            { label: 'التقارير', hint: 'كشف حساب وتقارير', icon: 'fa-chart-line', action: () => { global.location.href = '/client/reports'; } },
            { label: 'مركز الدعم', hint: 'تواصل مع الفريق', icon: 'fa-headset', action: () => { global.location.href = '/client/support'; } },
            { label: 'الأمان', hint: 'إعدادات الحماية', icon: 'fa-shield-halved', action: () => global.openClientSecurityPanel?.() },
            { label: 'الوضع الليلي', hint: 'تبديل المظهر', icon: 'fa-moon', action: () => global.toggleTheme?.() },
            { label: 'تسجيل الخروج', hint: 'إنهاء الجلسة', icon: 'fa-power-off', action: () => { global.location.href = '/client/logout'; } }
        ];
        return items;
    }

    function openTransferModal() {
        const modalEl = document.getElementById('transferModal');
        if (modalEl && global.bootstrap?.Modal) {
            global.bootstrap.Modal.getOrCreateInstance(modalEl).show();
            return;
        }
        global.openQuickTransfer?.();
    }

    function renderPaletteList(query) {
        const list = paletteList();
        if (!list) return;
        const q = String(query || '').trim().toLowerCase();
        paletteItems = buildPaletteItems().filter((item) => {
            if (!q) return true;
            return item.label.toLowerCase().includes(q) || (item.hint || '').toLowerCase().includes(q);
        });
        paletteActiveIndex = 0;
        if (!paletteItems.length) {
            list.innerHTML = '<div class="client-os-palette-empty">لا توجد أوامر مطابقة</div>';
            return;
        }
        list.innerHTML = paletteItems.map((item, idx) => `
            <button type="button" class="client-os-palette-item${idx === 0 ? ' is-active' : ''}" data-palette-idx="${idx}">
                <span><i class="fa-solid ${item.icon}"></i></span>
                <div><div>${escapeHtml(item.label)}</div><small>${escapeHtml(item.hint || '')}</small></div>
                ${item.shortcut ? `<kbd>${escapeHtml(item.shortcut)}</kbd>` : ''}
            </button>
        `).join('');
        list.querySelectorAll('[data-palette-idx]').forEach((btn) => {
            btn.addEventListener('click', () => runPaletteItem(Number(btn.getAttribute('data-palette-idx'))));
        });
    }

    function runPaletteItem(index) {
        const item = paletteItems[index];
        if (!item) return;
        closeCommandPalette();
        item.action?.();
    }

    function openCommandPalette() {
        const dialog = paletteEl();
        if (!dialog || typeof dialog.showModal !== 'function') return;
        renderPaletteList('');
        dialog.showModal();
        window.setTimeout(() => paletteInput()?.focus(), 30);
    }

    function closeCommandPalette() {
        paletteEl()?.close?.();
    }

    function onPaletteKeydown(event) {
        if (!paletteEl()?.open) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            paletteActiveIndex = Math.min(paletteActiveIndex + 1, paletteItems.length - 1);
            highlightPaletteItem();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            paletteActiveIndex = Math.max(paletteActiveIndex - 1, 0);
            highlightPaletteItem();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            runPaletteItem(paletteActiveIndex);
        } else if (event.key === 'Escape') {
            closeCommandPalette();
        }
    }

    function highlightPaletteItem() {
        const list = paletteList();
        if (!list) return;
        list.querySelectorAll('.client-os-palette-item').forEach((el, idx) => {
            el.classList.toggle('is-active', idx === paletteActiveIndex);
        });
    }

    function statusLabel(tx) {
        const map = {
            completed: 'مكتمل',
            pending: 'قيد المعالجة',
            processing: 'في طابور الانتظار',
            accepted: 'قيد العمل',
            deposit: 'إيداع',
            deduction: 'خصم',
            rejected: 'ملغي',
            cancelled_by_admin: 'ملغي'
        };
        return map[tx.status] || tx.status || '—';
    }

    function openInspector(tx) {
        const panel = inspectorEl();
        if (!panel || !tx) return;
        const isSub = !!global.isSubAccount;
        const cost = isSub ? (tx.subAccountCostLYD || tx.costLYD || 0) : (tx.costLYD || 0);
        const rate = isSub ? (tx.subClientRate || tx.exchangeRate || 0) : (tx.exchangeRate || 0);
        const txId = escapeHtml(tx.customId || String(tx._id || '').slice(-6));
        const account = escapeHtml(tx.vodafoneNumber || tx.accountNumber || '—');
        const safeId = /^[a-f\d]{24}$/i.test(String(tx._id || '')) ? tx._id : '';
        const hasProof = !!(tx.proofImage || (tx.proofImages && tx.proofImages.length));

        panel.querySelector('[data-inspector-title]').textContent = `#${txId}`;
        panel.querySelector('[data-inspector-status]').textContent = statusLabel(tx);
        panel.querySelector('[data-inspector-amount]').textContent = `${Number(tx.amount || 0).toFixed(2)} EGP`;
        panel.querySelector('[data-inspector-cost]').textContent = `${Number(cost).toFixed(2)} LYD`;
        panel.querySelector('[data-inspector-rate]').textContent = Number(rate).toFixed(2);
        panel.querySelector('[data-inspector-account]').textContent = account;
        panel.querySelector('[data-inspector-time]').textContent = new Date(tx.createdAt).toLocaleString('ar-EG', {
            timeZone: 'Africa/Tripoli', hour12: true
        });

        const actions = panel.querySelector('[data-inspector-actions]');
        if (actions) {
            let html = '';
            if (hasProof && safeId) {
                html += `<button type="button" class="btn btn-sm btn-primary" onclick="viewProof('${safeId}')"><i class="fa-solid fa-receipt me-1"></i>عرض الإيصال</button>`;
            }
            if (safeId && tx.status !== 'deposit' && tx.status !== 'deduction') {
                html += `<button type="button" class="btn btn-sm btn-outline-danger" onclick="submitComplaint('${safeId}', '${txId}')"><i class="fa-solid fa-flag me-1"></i>شكوى</button>`;
            }
            actions.innerHTML = html || '<span class="text-muted small">لا إجراءات إضافية</span>';
        }

        panel.classList.add('is-open');
        inspectorBackdrop()?.classList.add('is-open');
        shellEl()?.classList.add('is-inspector-open');
        document.querySelectorAll('.client-os-tx-row').forEach((row) => {
            row.classList.toggle('is-selected', row.getAttribute('data-tx-id') === safeId);
        });
    }

    function closeInspector() {
        inspectorEl()?.classList.remove('is-open');
        inspectorBackdrop()?.classList.remove('is-open');
        shellEl()?.classList.remove('is-inspector-open');
        document.querySelectorAll('.client-os-tx-row.is-selected').forEach((row) => row.classList.remove('is-selected'));
    }

    function attachRowHandlers() {
        document.querySelectorAll('#tableBody .client-os-tx-row').forEach((row) => {
            if (row.dataset.bound === '1') return;
            row.dataset.bound = '1';
            const txId = row.getAttribute('data-tx-id');
            const activate = () => {
                const tx = (global.allTransactions || []).find((t) => t._id === txId);
                if (tx) openInspector(tx);
            };
            row.addEventListener('click', activate);
            row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activate();
                }
            });
        });
    }

    function filterTableLocally(query) {
        const q = String(query || '').trim().toLowerCase();
        document.querySelectorAll('#tableBody .client-os-tx-row').forEach((row) => {
            const text = row.textContent.toLowerCase();
            row.hidden = q ? !text.includes(q) : false;
        });
    }

    function setupLiveSearch() {
        const input = document.getElementById('client-os-search-input');
        if (!input || input.dataset.liveBound === '1') return;
        input.dataset.liveBound = '1';
        input.addEventListener('input', () => {
            window.clearTimeout(filterTimer);
            filterTimer = window.setTimeout(() => filterTableLocally(input.value), 180);
        });
    }

    function onTransactionsRendered() {
        attachRowHandlers();
        setupLiveSearch();
        const input = document.getElementById('client-os-search-input');
        if (input?.value) filterTableLocally(input.value);
    }

    function bindGlobalShortcuts() {
        document.addEventListener('keydown', (event) => {
            const tag = (event.target?.tagName || '').toLowerCase();
            const typing = tag === 'input' || tag === 'textarea' || event.target?.isContentEditable;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                openCommandPalette();
                return;
            }
            if (!typing && event.key === '+' && document.body.classList.contains('wallet-hub-active')) {
                event.preventDefault();
                openTransferModal();
            }
            onPaletteKeydown(event);
        });
    }

    function bindUi() {
        document.getElementById('clientOsCmdTrigger')?.addEventListener('click', openCommandPalette);
        paletteInput()?.addEventListener('input', (event) => renderPaletteList(event.target.value));
        paletteEl()?.addEventListener('close', () => paletteInput()?.blur());
        inspectorBackdrop()?.addEventListener('click', closeInspector);
        document.getElementById('clientOsInspectorClose')?.addEventListener('click', closeInspector);
    }

    global.ClientWebOs = {
        openCommandPalette,
        closeCommandPalette,
        openInspector,
        closeInspector,
        onTransactionsRendered
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { bindUi(); bindGlobalShortcuts(); setupLiveSearch(); });
    } else {
        bindUi();
        bindGlobalShortcuts();
        setupLiveSearch();
    }
})(window);
