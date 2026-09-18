'use strict';

(function adminOpsTools(window, document) {
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));

    const formatMetric = (meta, value) => {
        const number = Number(value || 0);
        if (meta.format === 'percent') return `${(number * 100).toFixed(1)}%`;
        if (meta.format === 'money') return `${number.toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م`;
        return number.toLocaleString('en-US', { maximumFractionDigits: 1 });
    };

    const projectPoint = (lng, lat, width, height) => {
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
        return {
            x: ((lng + 180) / 360) * width,
            y: ((90 - lat) / 180) * height
        };
    };

    window.renderGeoHeatmap = function renderGeoHeatmap(root, payload) {
        if (!root) return;
        const countries = Array.isArray(payload?.countries) ? payload.countries : [];
        const width = 640;
        const height = 250;
        const dots = countries.map((row) => {
            const point = projectPoint(row.lng, row.lat, width, height);
            if (!point) return '';
            const radius = 4 + (Number(row.intensity || 0) * 14);
            const opacity = 0.35 + (Number(row.intensity || 0) * 0.55);
            return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${radius.toFixed(1)}" fill="#dc2626" fill-opacity="${opacity.toFixed(2)}"><title>${esc(row.label)} · ${row.count}</title></circle>`;
        }).join('');
        const bars = countries.slice(0, 8).map((row) => `
            <div class="geo-bar ${Number(row.intensity) >= 0.7 ? 'is-hot' : ''}">
                <span>${esc(row.label)}</span>
                <strong class="mono">${esc(row.count)}</strong>
                <i style="width:${Math.max(8, Number(row.intensity || 0) * 100)}%"></i>
            </div>
        `).join('');
        const demo = payload?.demo
            ? `<div class="geo-demo">${esc(payload.label || 'بيانات تجريبية للتطوير فقط')}</div>`
            : '';
        const empty = !countries.length
            ? `<div class="geo-empty">لا توجد إشارة جغرافية في هذه النافذة. تظهر النقاط عند توفر ترويسة الدولة (cf-ipcountry / x-country-code).</div>`
            : '';
        root.innerHTML = `
            ${demo}
            <div class="geo-layout">
                <svg class="geo-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="خريطة حرارية للدول">
                    <rect width="${width}" height="${height}" rx="16" fill="currentColor" opacity="0.04"></rect>
                    <g fill="currentColor" fill-opacity="0.08">
                        <ellipse cx="170" cy="88" rx="78" ry="42"></ellipse>
                        <ellipse cx="228" cy="168" rx="38" ry="52"></ellipse>
                        <ellipse cx="348" cy="142" rx="42" ry="58"></ellipse>
                        <ellipse cx="430" cy="78" rx="96" ry="38"></ellipse>
                        <ellipse cx="520" cy="92" rx="70" ry="34"></ellipse>
                        <ellipse cx="575" cy="168" rx="36" ry="22"></ellipse>
                    </g>
                    <path d="M20 125 H620 M320 20 V230" stroke="currentColor" stroke-opacity="0.12" fill="none"></path>
                    ${dots}
                </svg>
                <div class="geo-bars">${bars || empty}</div>
            </div>
            <small class="geo-meta">آخر ${esc(payload.window || '15m')} · ${esc(payload.total || 0)} عملية ذات دولة معروفة</small>
        `;
    };

    window.renderBehaviorComparison = function renderBehaviorComparison(root, payload) {
        if (!root) return;
        const metrics = payload?.metrics || {};
        const meta = Array.isArray(payload?.meta) ? payload.meta : [];
        const rows = meta.map((item) => {
            const metric = metrics[item.key] || {};
            const flagged = metric.flagged ? 'is-flagged' : '';
            const currentVal = Math.max(0, Number(metric.current || 0));
            const baselineVal = Math.max(0, Number(metric.baseline || 0));
            const maxVal = Math.max(currentVal, baselineVal, 0.0001);
            const currentWidth = Math.max(8, Math.min(100, Math.round((currentVal / maxVal) * 100)));
            const baselineWidth = Math.max(8, Math.min(100, Math.round((baselineVal / maxVal) * 100)));
            return `<article class="behavior-metric ${flagged}">
                <header><span>${esc(item.label)}</span>${metric.flagged ? '<b>غير معتاد</b>' : ''}</header>
                <div class="behavior-tracks">
                    <div><em>الآن</em><i style="width:${currentWidth}%"></i><strong>${esc(formatMetric(item, metric.current))}</strong></div>
                    <div><em>الأساس</em><i class="is-base" style="width:${baselineWidth}%"></i><strong>${esc(formatMetric(item, metric.baseline))}</strong></div>
                </div>
            </article>`;
        }).join('');
        const unusual = payload?.unusual
            ? `<div class="behavior-alert">السلوك الحالي ينحرف عن متوسط 30 يوماً (درجة ${esc(payload.anomalyScore || 0)}).</div>`
            : `<div class="behavior-ok">لا انحراف كبير عن المتوسط التاريخي.</div>`;
        root.innerHTML = `${unusual}<div class="behavior-grid">${rows}</div>
            <small class="geo-meta">الحالي = آخر 24 ساعة · الأساس = متوسط يومي لـ 30 يوماً السابقة</small>`;
    };

    window.loadBehaviorComparison = async function loadBehaviorComparison(root, { id, type, url }) {
        if (!root || !id) return;
        root.innerHTML = '<div class="geo-empty">جاري مقارنة السلوك...</div>';
        try {
            const endpoint = url || `/api/admin/ops/behavior-comparison?type=${encodeURIComponent(type || 'user')}&id=${encodeURIComponent(id)}`;
            const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'تعذر التحميل');
            window.renderBehaviorComparison(root, data);
        } catch (error) {
            root.innerHTML = `<div class="geo-empty">${esc(error.message)}</div>`;
        }
    };

    window.loadGeoHeatmap = async function loadGeoHeatmap(root, windowKey) {
        if (!root) return;
        const params = new URLSearchParams({ window: windowKey || '15m' });
        const demo = new URLSearchParams(window.location.search).get('demo');
        if (demo) params.set('demo', demo);
        try {
            const response = await fetch('/api/admin/ops/geo-heatmap?' + params, { headers: { Accept: 'application/json' } });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'تعذر التحميل');
            window.renderGeoHeatmap(root, data);
        } catch (error) {
            root.innerHTML = `<div class="geo-empty">${esc(error.message)}</div>`;
        }
    };
    window.parseVoiceFilter = function parseVoiceFilter(transcript) {
        const text = String(transcript || '').toLowerCase();
        const result = {};
        if (/فشل|فاشل|failed|rejected/.test(text)) result.status = 'failed';
        else if (/معلق|pending/.test(text)) result.status = 'pending';
        else if (/نجاح|ناجح|مكتمل|success/.test(text)) result.status = 'success';
        else if (/ملغ|cancel/.test(text)) result.status = 'cancelled';
        if (/آخر ساعة|last hour/.test(text) || /ساعة/.test(text)) result.range = '1h';
        else if (/اليوم|today|24|يوم/.test(text)) result.range = '24h';
        if (/فودافون|vodafone/.test(text)) result.type = 'vodafone';
        else if (/بريد|post/.test(text)) result.type = 'post_account';
        else if (/بنك|bank/.test(text)) result.type = 'bank_account';
        const amount = text.match(/(\d{3,})/);
        if (/أكبر|أكثر|above|greater|>/.test(text) && amount) result.minAmount = amount[1];
        else if (/مبلغ كبير|large/.test(text)) result.minAmount = '10000';
        return result;
    };

    window.renderTimeFlow = function renderTimeFlow(root, buckets, activeMinute) {
        if (!root) return;
        const rows = Array.isArray(buckets) ? buckets.slice(-60) : [];
        if (!rows.length) {
            root.innerHTML = '<div class="geo-empty">لا توجد بصمة زمنية في هذه النافذة.</div>';
            return;
        }
        const dots = rows.map((row) => {
            const height = 10 + Number(row.intensity || 0) * 28;
            const kind = Number(row.failed) > Number(row.success) ? 'is-failed' : (row.success ? 'is-success' : '');
            const active = activeMinute && String(row.minute) === String(activeMinute) ? 'is-active' : '';
            return `<button type="button" class="${kind} ${active}" data-minute="${esc(row.minute)}" title="${esc(row.minute)} · ${row.total}"><i style="height:${height}px"></i></button>`;
        }).join('');
        root.innerHTML = (activeMinute
            ? '<button type="button" class="ops-timeflow-clear" data-minute="">مسح الدقيقة</button>'
            : '') + dots;
    };

    window.renderWatchdog = function renderWatchdog(root, payload) {
        if (!root) return;
        const dismissed = new Set(JSON.parse(localStorage.getItem('ahram_ops_watchdog_dismissed') || '[]'));
        const cards = (payload?.watchdog || []).filter((item) => !dismissed.has(item.id));
        if (!cards.length) {
            root.innerHTML = '';
            root.hidden = true;
            return;
        }
        root.hidden = false;
        root.innerHTML = `<small class="geo-meta">${esc(payload.disclaimer || 'قواعد تشغيلية — ليست نموذجاً لغوياً.')}</small>` + cards.map((card) => `
            <article class="ops-watch-card ${esc(card.severity || '')}" data-id="${esc(card.id)}">
                <header><span>${esc(card.title)}</span><button type="button" data-dismiss="${esc(card.id)}" class="live-btn" style="height:28px;padding:0 8px;">إخفاء</button></header>
                <p class="mb-2 mt-1">${esc(card.body)}</p>
                <button type="button" class="live-btn primary" data-watch-action="${esc(JSON.stringify(card.action || {}))}">تطبيق الفلتر</button>
            </article>
        `).join('');
    };

    window.renderTrustPath = function renderTrustPath(root, path) {
        if (!root) return;
        const state = path?.state || 'unknown';
        const cls = state === 'mismatch' ? 'is-bad' : (state === 'consistent' ? 'is-ok' : '');
        const label = state === 'mismatch' ? 'تعارض بين IP والدولة المخزّنة' : (state === 'consistent' ? 'مسار ثقة متسق' : 'إشارة جغرافية غير مكتملة');
        root.innerHTML = `<div class="trust-path ${cls}">
            <span class="trust-node">جهاز ${esc(path?.deviceType || '—')}</span>
            <span>↔</span>
            <span class="trust-node mono">${esc(path?.ip || '—')}</span>
            <span>↔</span>
            <span class="trust-node">${esc(path?.originCountry || path?.auditCountry || '—')}</span>
            <small>${esc(label)}</small>
        </div>`;
    };

    window.renderBenchmark = function renderBenchmark(root, payload) {
        if (!root) return;
        if (!payload || !payload.sample) {
            root.innerHTML = '<div class="geo-empty">لا توجد عمليات مشابهة كافية للمقارنة.</div>';
            return;
        }
        const flag = payload.slow ? '<b>أبطأ من المعتاد</b>' : '<span>ضمن المعدل</span>';
        root.innerHTML = `<div class="behavior-metric ${payload.slow ? 'is-flagged' : ''}">
            <header><span>زمن التنفيذ مقابل المشابه</span>${flag}</header>
            <div class="behavior-tracks">
                <div><em>هذه</em><i style="width:${payload.slow ? 90 : 55}%"></i><strong>${esc(Math.round((payload.currentMs || 0) / 1000))} ث</strong></div>
                <div><em>المعيار</em><i class="is-base" style="width:45%"></i><strong>${esc(Math.round((payload.baselineMs || 0) / 1000))} ث · ${esc(payload.sample)} عينة</strong></div>
            </div>
            <small class="geo-meta">شريحة المبلغ ${esc(payload.band || '')} · نفس النوع عند توفره</small>
        </div>`;
    };
})(window, document);
