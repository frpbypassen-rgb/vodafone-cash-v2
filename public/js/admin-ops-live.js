'use strict';

(function liveOpsPage(window, document) {
    const capabilities = window.__opsCapabilities || {};
    const state = {
        page: 1, pages: 1, loading: false, latestId: '', refreshTimer: null,
        rows: [], clusters: [], selected: new Set(), minute: '', lastSync: '', intelligence: null, clusterThreshold: 10
    };
    const byId = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
    const number = (value) => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const date = (value) => value ? new Intl.DateTimeFormat('ar-LY', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '—';
    const statusLabels = {
        pending: 'معلق', processing: 'قيد المعالجة', accepted: 'مقبول', completed: 'ناجح',
        rejected: 'فشل', deposit_pending: 'إيداع معلق', deposit: 'إيداع', deduction: 'سحب', cancelled_by_admin: 'ملغي'
    };

    const queryParams = (page = 1) => {
        const params = new URLSearchParams({ page, limit: 50, range: byId('filterRange').value });
        const values = {
            q: byId('filterSearch').value,
            status: byId('filterStatus').value,
            type: byId('filterType').value,
            minAmount: byId('filterMin').value
        };
        Object.entries(values).forEach(([key, value]) => { if (value.trim()) params.set(key, value.trim()); });
        if (params.get('range') === 'custom') {
            if (byId('filterFrom').value) params.set('from', new Date(byId('filterFrom').value).toISOString());
            if (byId('filterTo').value) params.set('to', new Date(byId('filterTo').value).toISOString());
        }
        if (state.minute) params.set('minute', state.minute);
        return params;
    };

    const duration = (ms) => {
        if (!ms) return '—';
        if (ms < 60000) return `${(ms / 1000).toFixed(1)} ث`;
        return `${(ms / 60000).toFixed(1)} د`;
    };

    const syncUrl = () => {
        const params = queryParams(1);
        params.delete('page');
        params.delete('limit');
        if (document.body.classList.contains('focus-mode')) params.set('focus', '1');
        if (document.body.classList.contains('cinema-mode')) params.set('cinema', '1');
        const next = `${location.pathname}?${params}`;
        history.replaceState({}, '', next);
        return `${location.origin}${next}`;
    };

    const applyUrlState = () => {
        const params = new URLSearchParams(location.search);
        const assign = (id, key) => { if (params.has(key) && byId(id)) byId(id).value = params.get(key); };
        assign('filterSearch', 'q');
        assign('filterStatus', 'status');
        assign('filterType', 'type');
        assign('filterRange', 'range');
        assign('filterMin', 'minAmount');
        if (params.get('from') && byId('filterFrom')) byId('filterFrom').value = params.get('from').slice(0, 16);
        if (params.get('to') && byId('filterTo')) byId('filterTo').value = params.get('to').slice(0, 16);
        if (byId('filterRange')?.value === 'custom') byId('customRange')?.classList.add('show');
        state.minute = params.get('minute') || '';
        if (params.has('focus') && window.applyAdminFocusMode) window.applyAdminFocusMode(params.get('focus') === '1');
        if (params.has('cinema') && window.applyAdminCinemaMode) window.applyAdminCinemaMode(params.get('cinema') === '1');
    };

    const densityCounts = (rows) => {
        const counts = {};
        (rows || []).forEach((row) => {
            if (!row.minute) return;
            counts[row.minute] = (counts[row.minute] || 0) + 1;
        });
        const max = Math.max(1, ...Object.values(counts), 1);
        return { counts, max };
    };
    const densityClass = (row, density) => {
        const intensity = (density.counts[row.minute] || 0) / density.max;
        if (intensity >= 0.8) return 'row-density-3';
        if (intensity >= 0.45) return 'row-density-2';
        if (intensity >= 0.2) return 'row-density-1';
        return '';
    };

    const renderMetrics = (metrics) => {
        byId('metricTotal').textContent = number(metrics.total);
        byId('metricLiquidity').textContent = `${number(metrics.liquidity)} ج.م`;
        byId('metricSuccess').textContent = `${Number(metrics.successRate || 0).toFixed(1)}%`;
        byId('metricPending').textContent = number(metrics.pending);
        byId('metricDuration').textContent = duration(metrics.averageDurationMs);
        const alert = byId('failureAlert');
        alert.classList.toggle('show', metrics.alert === true);
        alert.querySelector('span').textContent = `نسبة الفشل خلال آخر 5 دقائق ${Number(metrics.failureRate5m || 0).toFixed(1)}% — تحتاج مراجعة فورية.`;
    };

    const rowHtml = (row, density) => {
        const risks = [row.security?.largeAmount ? 'مبلغ كبير' : '', row.security?.newDevice ? 'جهاز جديد' : ''].filter(Boolean);
        const checked = state.selected.has(row.id) ? 'checked' : '';
        const pin = (row.geo && window.opsMiniMapPin) ? window.opsMiniMapPin(row.geo) : '';
        const task = row.task ? `<span class="assignee-chip" style="background:${esc(row.task.assigneeColor)}">${esc(row.task.assigneeName)}</span>` : '';
        return `<tr data-id="${esc(row.id)}" class="${row.security?.flagged ? 'risk-row' : ''} ${densityClass(row, density || densityCounts(state.rows))}">
            <td><input type="checkbox" class="row-select" data-id="${esc(row.id)}" ${checked}></td>
            <td><strong class="mono">${esc(row.reference)}</strong></td>
            <td>${pin}${esc(row.customer)} ${task}</td>
            <td class="mono">${esc(row.recipient)}</td>
            <td>${esc(row.type || '—')}</td>
            <td><strong class="mono">${number(row.amount)} ج.م</strong></td>
            <td>${esc(row.executor)}</td>
            <td class="status-cell"><span class="status s-${esc(row.status)}">${esc(statusLabels[row.status] || row.status)}</span></td>
            <td class="risk">${risks.length ? `<i class="fa-solid fa-triangle-exclamation ms-1"></i>${esc(risks.join('، '))}` : '—'}</td>
            <td>${date(row.createdAt)}</td>
        </tr>`;
    };

    const clusterHtml = (cluster) => `<tr class="cluster-row" data-cluster="${esc(cluster.key)}">
        <td></td><td colspan="9">${esc(cluster.count)} عملية من ${esc(cluster.name)} بقيمة إجمالية ${number(cluster.volume)} ج.م — انقر للفتح</td>
    </tr>`;

    const renderRows = (rows) => {
        const body = byId('rows');
        const threshold = state.clusterThreshold || 10;
        const serverClusters = Array.isArray(state.clusters) ? state.clusters : [];
        const grouped = {};
        rows.forEach((row) => {
            const key = row.clusterKey || `${row.userKey || row.customer}|${row.minute || ''}`;
            grouped[key] = grouped[key] || { key, name: row.customer, owner: row.userKey || row.customer, count: 0, volume: 0, rows: [] };
            grouped[key].count += 1;
            grouped[key].volume += Number(row.amount || 0);
            grouped[key].name = row.customer || grouped[key].name;
            grouped[key].rows.push(row);
        });
        serverClusters.forEach((cluster) => {
            if (!grouped[cluster.key]) return;
            grouped[cluster.key].name = cluster.name || grouped[cluster.key].name;
            grouped[cluster.key].count = Math.max(grouped[cluster.key].count, Number(cluster.count || 0));
            grouped[cluster.key].volume = Math.max(grouped[cluster.key].volume, Number(cluster.volume || 0));
        });
        const density = densityCounts(rows);
        const html = [];
        Object.entries(grouped).forEach(([key, group]) => {
            if (group.count >= threshold) {
                html.push(clusterHtml({ key, name: group.name, count: group.count, volume: group.volume }));
                if (state.expandedClusters?.has(key)) group.rows.forEach((row) => html.push(rowHtml(row, density)));
            } else {
                group.rows.forEach((row) => html.push(rowHtml(row, density)));
            }
        });
        body.innerHTML = html.join('');
        if (byId('clusterHint')) {
            byId('clusterHint').textContent = `تجميع ذكي عند ≥${threshold} · ${serverClusters.length} مجموعة في هذه الصفحة`;
        }
    };

    state.expandedClusters = new Set();

    const updateFab = () => {
        const bar = byId('opsFab');
        if (!bar) return;
        bar.classList.toggle('show', state.selected.size > 0);
        byId('fabCount').textContent = `${state.selected.size} محدد`;
        bar.querySelectorAll('[data-need="manage"]').forEach((el) => { el.hidden = !capabilities.manageTransactions; });
        bar.querySelectorAll('[data-need="halt"]').forEach((el) => { el.hidden = !capabilities.emergencyHalt; });
    };

    async function load(reset = true) {
        if (state.loading) return;
        state.loading = true;
        try {
            const nextPage = reset ? 1 : state.page + 1;
            const response = await fetch('/api/transactions/live?' + queryParams(nextPage), { headers: { Accept: 'application/json' } });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'تعذر التحميل');
            state.lastSync = data.serverTime || new Date().toISOString();
            if (reset) {
                state.rows = data.rows;
                state.clusters = data.clusters || [];
            } else {
                state.rows = state.rows.concat(data.rows);
                state.clusters = (state.clusters || []).concat(data.clusters || []);
            }
            state.clusterThreshold = data.clusterThreshold || state.clusterThreshold || 10;
            renderRows(state.rows);
            if (reset && data.rows[0]?.id && data.rows[0].id !== state.latestId) {
                byId('rows').querySelector('tr')?.classList.add('flash');
                state.latestId = data.rows[0].id;
            }
            state.page = data.pagination.page;
            state.pages = data.pagination.pages;
            byId('resultCount').textContent = `${number(data.pagination.total)} عملية`;
            byId('empty').hidden = data.pagination.total > 0;
            byId('loadMore').hidden = state.page >= state.pages;
            renderMetrics(data.metrics);
            syncUrl();
        } catch (error) {
            byId('resultCount').textContent = error.message;
        } finally {
            state.loading = false;
        }
    }

    const scheduleLoad = () => {
        clearTimeout(state.refreshTimer);
        state.refreshTimer = setTimeout(() => load(true), 350);
    };

    async function patchChanges() {
        if (!state.lastSync) return load(true);
        try {
            const response = await fetch('/api/admin/ops/live-changes?since=' + encodeURIComponent(state.lastSync), { headers: { Accept: 'application/json' } });
            const data = await response.json();
            if (!response.ok) return scheduleLoad();
            state.lastSync = data.serverTime || state.lastSync;
            let unknown = false;
            (data.changes || []).forEach((change) => {
                const row = byId('rows').querySelector(`tr[data-id="${change.id}"]`);
                if (!row) { unknown = true; return; }
                const cell = row.querySelector('.status-cell');
                if (cell) cell.innerHTML = `<span class="status s-${esc(change.status)}">${esc(statusLabels[change.status] || change.status)}</span>${change.actor ? `<small class="d-block">${esc(change.actor)}</small>` : ''}`;
                row.classList.add('flash-change');
                setTimeout(() => row.classList.remove('flash-change'), 1600);
            });
            if (unknown) scheduleLoad();
        } catch (_) {
            scheduleLoad();
        }
    }

    async function loadIntelligence() {
        try {
            const response = await fetch('/api/admin/ops/intelligence?window=' + encodeURIComponent(byId('geoWindow')?.value || '15m'), { headers: { Accept: 'application/json' } });
            const data = await response.json();
            if (!response.ok) return;
            state.intelligence = data;
            state.clusterThreshold = data.threshold || 10;
            if (window.renderTimeFlow) window.renderTimeFlow(byId('opsTimeflow'), data.timeFlow, state.minute);
            if (window.renderWatchdog) window.renderWatchdog(byId('opsWatchdog'), data);
            const congestion = byId('congestionBanner');
            if (congestion) {
                congestion.classList.toggle('show', Boolean(data.congestion?.flagged));
                congestion.querySelector('span').textContent = data.congestion?.message || '';
            }
            const halt = byId('haltBanner');
            if (halt) {
                halt.classList.toggle('show', Boolean(data.halt?.active));
                halt.querySelector('span').textContent = data.halt?.active
                    ? `التحويلات الجديدة متوقفة بواسطة ${data.halt.by || 'الإدارة'}`
                    : '';
            }
            if (byId('panicState')) byId('panicState').textContent = data.halt?.active ? 'رفع الإيقاف' : 'إيقاف التحويلات';
        } catch (_) {}
    }

    async function openDetail(id) {
        const response = await fetch('/api/transactions/live/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } });
        const data = await response.json();
        if (!response.ok) return;
        const tx = data.transaction, audit = data.audit || {};
        byId('detailReference').textContent = tx.reference;
        byId('detailBody').innerHTML = `
            <div id="trustPath"></div>
            <div class="detail-grid">
                <div class="detail-card"><span>المرسل</span><strong>${esc(data.parties.sender)}</strong></div>
                <div class="detail-card"><span>المستلم</span><strong class="mono">${esc(data.parties.recipient)}</strong></div>
                <div class="detail-card"><span>المبلغ</span><strong class="mono">${number(tx.amount)} ج.م</strong></div>
                <div class="detail-card"><span>الحالة</span><strong>${esc(statusLabels[tx.status] || tx.status)}</strong></div>
                <div class="detail-card"><span>IP</span><strong class="mono">${esc(audit.ip || 'غير مسجل')}</strong></div>
                <div class="detail-card"><span>الدولة</span><strong class="mono">${esc(tx.originCountry || 'غير مسجل')}</strong></div>
                <div class="detail-card"><span>الجهاز</span><strong>${esc(audit.deviceType || 'غير مسجل')}</strong></div>
            </div>
            <div id="opsBenchmark"><div class="geo-empty">جاري المقارنة المعيارية...</div></div>
            <section class="behavior-card" id="behaviorCompare"><div class="geo-empty">جاري مقارنة السلوك...</div></section>
            ${data.error ? `<h3 class="section-title">سبب الفشل</h3><div class="error-box"><strong>${esc(data.error.code)}</strong><br>${esc(data.error.message)}</div>` : ''}
            <h3 class="section-title">شجرة الحدث</h3>
            <div class="timeline">${data.timeline.map((item) => `<div class="event ${item.state === 'error' ? 'error' : ''}"><strong>${esc(item.label)}</strong><time>${date(item.at)}</time></div>`).join('') || '<span class="text-muted">لا توجد أحداث</span>'}</div>
            <div class="flyout-actions">
                ${['pending', 'processing', 'accepted'].includes(tx.status) ? `<a class="live-btn primary text-decoration-none d-inline-flex align-items-center" href="/transactions/pulse">فتح للتوجيه</a>` : ''}
                <a class="live-btn text-decoration-none d-inline-flex align-items-center" target="_blank" href="/transactions/live/${encodeURIComponent(tx.id)}/receipt"><i class="fa-solid fa-print ms-1"></i>طباعة حرارية / PDF</a>
            </div>`;
        if (window.renderTrustPath) window.renderTrustPath(byId('trustPath'), data.trustPath);
        if (window.renderOpsMiniMap) window.renderOpsMiniMap(byId('opsMiniMap'), data.geoMap || tx.geo || {});
        const subjectId = tx.companyId || tx.userKey;
        if (subjectId && window.loadBehaviorComparison) window.loadBehaviorComparison(byId('behaviorCompare'), { id: subjectId, type: tx.companyId ? 'company' : 'user' });
        fetch('/api/admin/ops/similar-benchmark?type=' + encodeURIComponent(tx.type || '') + '&amount=' + encodeURIComponent(tx.amount || 0) + '&durationMs=' + encodeURIComponent(tx.durationMs || 0), { headers: { Accept: 'application/json' } })
            .then((res) => res.json()).then((payload) => window.renderBenchmark && window.renderBenchmark(byId('opsBenchmark'), payload)).catch(() => {});
        fetch('/api/admin/ops/transactions/' + encodeURIComponent(id) + '/notes', { headers: { Accept: 'application/json' } })
            .then((res) => res.json()).then((payload) => {
                byId('opsNotes').innerHTML = (payload.notes || []).map((note) => `<div class="detail-card mb-2"><span>${esc(note.authorName)} · ${date(note.createdAt)}</span><strong>${esc(note.body)}</strong></div>`).join('') || '<div class="geo-empty">لا ملاحظات بعد.</div>';
            }).catch(() => {});
        const form = byId('opsNoteForm');
        if (form) {
            form.hidden = !capabilities.manageTransactions;
            form.onsubmit = async (event) => {
                event.preventDefault();
                const body = form.body.value.trim();
                if (!body) return;
                const response = await fetch('/api/admin/ops/transactions/' + encodeURIComponent(id) + '/notes', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ body })
                });
                if (response.ok) {
                    form.body.value = '';
                    openDetail(id);
                }
            };
        }
        byId('flyout').classList.add('open');
        byId('flyoutBackdrop').classList.add('open');
        byId('flyout').setAttribute('aria-hidden', 'false');
    }

    function closeDetail() {
        byId('flyout').classList.remove('open');
        byId('flyoutBackdrop').classList.remove('open');
        byId('flyout').setAttribute('aria-hidden', 'true');
    }

    function refreshHeatmap() {
        if (window.loadGeoHeatmap) window.loadGeoHeatmap(byId('geoHeatmap'), byId('geoWindow').value);
    }

    function startVoice() {
        const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Speech) {
            byId('voiceStatus').textContent = 'البحث الصوتي غير مدعوم في هذا المتصفح.';
            return;
        }
        const rec = new Speech();
        rec.lang = 'ar-LY';
        rec.onresult = (event) => {
            const text = event.results[0][0].transcript;
            const mapped = window.parseVoiceFilter ? window.parseVoiceFilter(text) : {};
            if (mapped.status) byId('filterStatus').value = mapped.status;
            if (mapped.range) byId('filterRange').value = mapped.range;
            if (mapped.type) byId('filterType').value = mapped.type;
            if (mapped.minAmount) byId('filterMin').value = mapped.minAmount;
            if (!Object.keys(mapped).length) byId('filterSearch').value = text;
            byId('voiceStatus').textContent = text;
            scheduleLoad();
        };
        rec.onerror = () => { byId('voiceStatus').textContent = 'تعذر التقاط الصوت.'; };
        rec.start();
        byId('voiceStatus').textContent = 'جارِ الاستماع...';
    }

    async function submitHalt(enable) {
        const password = byId('haltPassword').value;
        const confirmPhrase = byId('haltPhrase').value;
        const reason = byId('haltReason').value;
        const response = await fetch('/api/admin/ops/emergency-halt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ enable, confirmPhrase, password, reason })
        });
        const data = await response.json();
        byId('haltError').textContent = response.ok ? '' : (data.error || 'فشل الإجراء');
        if (response.ok) {
            byId('haltModal').hidden = true;
            byId('haltModal').classList.remove('is-open');
            byId('haltPassword').value = '';
            loadIntelligence();
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        applyUrlState();
        ['filterStatus', 'filterType', 'filterRange', 'filterMin', 'filterFrom', 'filterTo'].forEach((id) => byId(id).addEventListener('change', () => {
            byId('customRange').classList.toggle('show', byId('filterRange').value === 'custom');
            scheduleLoad();
        }));
        byId('filterSearch').addEventListener('input', scheduleLoad);
        byId('toggleFilters')?.addEventListener('click', () => byId('liveFilters').classList.toggle('is-open'));
        byId('geoWindow')?.addEventListener('change', () => { refreshHeatmap(); loadIntelligence(); });
        byId('resetFilters').addEventListener('click', () => {
            ['filterSearch', 'filterStatus', 'filterType', 'filterMin', 'filterFrom', 'filterTo'].forEach((id) => { byId(id).value = ''; });
            byId('filterRange').value = '24h';
            byId('customRange').classList.remove('show');
            state.minute = '';
            load(true);
            loadIntelligence();
        });
        byId('exportCsv').addEventListener('click', () => {
            const params = queryParams(1);
            params.delete('page'); params.delete('limit');
            location.href = '/api/transactions/live-export.csv?' + params;
        });
        byId('loadMore').addEventListener('click', () => load(false));
        byId('rows').addEventListener('click', (event) => {
            const select = event.target.closest('.row-select');
            if (select) {
                event.stopPropagation();
                if (select.checked) state.selected.add(select.dataset.id);
                else state.selected.delete(select.dataset.id);
                updateFab();
                return;
            }
            const cluster = event.target.closest('tr[data-cluster]');
            if (cluster) {
                const key = cluster.dataset.cluster;
                if (state.expandedClusters.has(key)) state.expandedClusters.delete(key);
                else state.expandedClusters.add(key);
                renderRows(state.rows);
                return;
            }
            const row = event.target.closest('tr[data-id]');
            if (row) openDetail(row.dataset.id);
        });
        byId('closeFlyout').addEventListener('click', closeDetail);
        byId('flyoutBackdrop').addEventListener('click', closeDetail);
        byId('copyLink')?.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(syncUrl()); byId('copyLink').textContent = 'تم النسخ'; }
            catch (_) {}
        });
        byId('voiceSearch')?.addEventListener('click', startVoice);
        byId('opsTimeflow')?.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-minute]');
            if (!button) return;
            state.minute = state.minute === button.dataset.minute ? '' : button.dataset.minute;
            load(true);
            loadIntelligence();
        });
        byId('opsWatchdog')?.addEventListener('click', (event) => {
            const dismiss = event.target.closest('[data-dismiss]');
            if (dismiss) {
                const ids = JSON.parse(localStorage.getItem('ahram_ops_watchdog_dismissed') || '[]');
                ids.push(dismiss.dataset.dismiss);
                localStorage.setItem('ahram_ops_watchdog_dismissed', JSON.stringify(ids));
                loadIntelligence();
                return;
            }
            const actionBtn = event.target.closest('[data-watch-action]');
            if (!actionBtn) return;
            const action = JSON.parse(actionBtn.dataset.watchAction || '{}');
            if (action.status) byId('filterStatus').value = action.status;
            if (action.range) byId('filterRange').value = action.range;
            if (action.q) byId('filterSearch').value = action.q;
            scheduleLoad();
        });
        byId('fabExport')?.addEventListener('click', () => {
            const ids = [...state.selected].join(',');
            location.href = '/api/transactions/live-export.csv?ids=' + encodeURIComponent(ids);
        });
        byId('fabAssign')?.addEventListener('click', async () => {
            const id = [...state.selected][0];
            if (!id) return;
            await fetch('/api/admin/ops/transactions/' + encodeURIComponent(id) + '/task', {
                method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ reason: 'متابعة من المراقبة الحية' })
            });
            state.selected.clear();
            updateFab();
            load(true);
        });
        byId('fabLink')?.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(syncUrl()); } catch (_) {}
        });
        const setHaltModal = (open) => {
            const modal = byId('haltModal');
            if (!modal) return;
            modal.hidden = !open;
            modal.classList.toggle('is-open', open);
        };
        byId('panicBtn')?.addEventListener('click', () => setHaltModal(true));
        byId('haltCancel')?.addEventListener('click', () => setHaltModal(false));
        byId('haltConfirm')?.addEventListener('click', () => submitHalt(true));
        byId('haltLift')?.addEventListener('click', () => submitHalt(false));
        const scroller = document.querySelector('.scroll');
        scroller?.addEventListener('scroll', () => {
            if (state.loading || state.page >= state.pages) return;
            if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 80) load(false);
        });
        load(true);
        refreshHeatmap();
        loadIntelligence();
        setInterval(() => {
            if (document.visibilityState === 'visible') {
                patchChanges();
                refreshHeatmap();
                loadIntelligence();
            }
        }, 15000);
        const socket = window.io ? io({ transports: ['websocket', 'polling'] }) : null;
        if (socket) {
            socket.on('connect', () => {
                byId('connection').classList.remove('off');
                byId('connection').textContent = 'متصل لحظيًا';
                socket.emit('transactions:subscribe');
            });
            socket.on('disconnect', () => {
                byId('connection').classList.add('off');
                byId('connection').textContent = 'إعادة الاتصال';
            });
            socket.on('transactions:changed', () => {
                patchChanges();
                refreshHeatmap();
                loadIntelligence();
            });
        }
    });
})(window, document);
