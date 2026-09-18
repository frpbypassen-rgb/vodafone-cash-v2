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
})(window, document);
