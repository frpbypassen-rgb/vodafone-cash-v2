(() => {
    'use strict';
    const paths = new Set(['transactions', 'customers', 'staff', 'reports', 'finance', 'finance/profits'].map(path => '/agent-portal/' + path));
    const names = new Set(['search', 'status', 'service', 'staff', 'from', 'to', 'type', 'role', 'scope', 'period', 'month', 'page']);
    const selectors = ['customer-search', 'customer-filter', 'staff-search', 'staff-status', 'staff-role', 'ledger-search', 'profit-search', 'profit-sort', 'report-search'];
    const cleanQuery = value => {
        const result = new URLSearchParams();
        for (const [key, item] of new URLSearchParams(value)) if (names.has(key) && item.length <= 256) result.set(key, item);
        result.sort();
        return result.toString();
    };
    const install = win => {
        const doc = win.document, scope = win.agentPortal?.notificationScope;
        if (!scope || doc.documentElement.dataset.portal !== 'agent') return;
        const prefix = 'agent-list-state:v1:' + scope + ':';
        let storage;
        try { storage = win.sessionStorage; } catch (_) { return; }
        const read = path => {
            try {
                const value = JSON.parse(storage.getItem(prefix + path));
                return value && Date.now() - value.at < 8 * 60 * 60 * 1000 && typeof value.query === 'string' ? value : null;
            } catch (_) { return null; }
        };
        const controls = () => {
            const result = [];
            for (const name of selectors) {
                const el = doc.querySelector('[data-' + name + ']');
                if (el) result.push({key: name, el});
            }
            doc.querySelectorAll('form[method="GET" i] [name]').forEach(el => {
                if (names.has(el.name) && !['password', 'file', 'hidden'].includes(el.type)) result.push({key: 'get:' + el.name, el});
            });
            return result;
        };
        const current = win.location.pathname;
        const query = cleanQuery(win.location.search);
        const fields = paths.has(current) ? controls() : [];
        const previous = paths.has(current) ? read(current) : null;
        if (previous && cleanQuery(previous.query) === query) {
            for (const {key, el} of fields) {
                const value = previous.controls?.[key];
                if (typeof value === 'string' && value.length <= 256 && (el.tagName !== 'SELECT' || [...el.options].some(option => option.value === value))) el.value = value;
            }
        }
        const save = () => {
            if (!paths.has(current)) return;
            try {
                storage.setItem(prefix + current, JSON.stringify({at: Date.now(), query, controls: Object.fromEntries(fields.map(({key, el}) => [key, String(el.value).slice(0, 256)]))}));
            } catch (_) { /* Optional tab state must never block navigation. */ }
        };
        const decorate = () => doc.querySelectorAll('.cm-navigation a, .bw-navigation a, .agent-more-menu a, .bw-mobile-dock a').forEach(link => {
            const href = link.getAttribute('href');
            if (!paths.has(href)) return; // Explicit filters and reset links remain authoritative.
            const stored = read(href), savedQuery = stored && cleanQuery(stored.query);
            if (savedQuery) link.setAttribute('href', href + '?' + savedQuery);
        });
        save();
        decorate();
        fields.forEach(({el}) => { el.addEventListener('input', save); el.addEventListener('change', save); });
        win.addEventListener('pagehide', save);
        doc.addEventListener('click', event => {
            const link = event.target.closest('a[href]');
            if (link?.getAttribute('href') !== '/agent-portal/logout') return;
            try { for (const key of Object.keys(storage)) if (key.startsWith(prefix)) storage.removeItem(key); } catch (_) { /* optional */ }
        });
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = {cleanQuery, install};
    if (typeof window !== 'undefined') install(window);
})();
