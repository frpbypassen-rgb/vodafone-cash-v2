/* Presentation only. Financial requests and their existing handlers stay in their page modules. */
(() => {
    'use strict';
    const root = document.documentElement;
    if (!root.classList.contains('admin-modern')) return;
    const groups = href => {
        const path = new URL(href, location.origin).pathname;
        if (path === '/') return 'overview';
        if (/^\/(financial-movements|reports|audit-log)|^\/transactions\/(deposits|movements)/.test(path)) return 'finance';
        if (/^\/(clients|user|company|executors|executor|employees|registration-requests)|^\/admin\/accounts/.test(path)) return 'accounts';
        if (/^\/(support|complaints|broadcast|telegram-monitor|whatsapp-monitor)|^\/admin\/webhooks/.test(path)) return 'communication';
        if (/^\/(settings|security)|^\/admin\/security/.test(path)) return 'system';
        return 'operations';
    };
    const currentGroup = groups(location.href);
    root.dataset.adminSection = currentGroup;
    const nav = document.querySelector('#sidebarMenu');
    if (nav) {
        const links = [...nav.querySelectorAll('.sidebar-menu a[href]')];
        const current = new URL(location.href);
        let best = null;
        let score = -1;
        links.forEach(link => {
            const url = new URL(link.href);
            const group = groups(link.href);
            const inContext = group === currentGroup || (currentGroup === 'overview' && group === 'operations');
            link.classList.toggle('am-outside-context', !inContext);
            let match = url.pathname === current.pathname ? 1 : -1;
            for (const [key, value] of url.searchParams) match += current.searchParams.get(key) === value ? 2 : -10;
            if (match > score) { score = match; best = link; }
        });
        if (best && score >= 1) {
            links.forEach(link => { link.classList.remove('active'); link.removeAttribute('aria-current'); });
            best.classList.add('active'); best.setAttribute('aria-current', 'page');
        }
    }
    document.querySelectorAll('[data-am-section]').forEach(link => {
        if (link.dataset.amSection === currentGroup) { link.classList.add('selected'); link.setAttribute('aria-current', 'true'); }
    });
    document.querySelectorAll('.bottom-nav-admin-mobile a[href]').forEach(link => {
        const selected = groups(link.href) === currentGroup;
        link.classList.toggle('active', selected);
        if (selected) link.setAttribute('aria-current', 'page');
    });
    const main = document.querySelector('.main-content');
    if (main && !main.id) main.id = 'am-main';
    const skip = document.querySelector('.am-skip');
    if (main && skip) skip.href = `#${main.id}`;
    // Labels are added to existing cells, never cloned: mobile keeps the same controls and event listeners.
    function labelTables(container) {
        const tables = container.matches?.('table') ? [container] : container.querySelectorAll('table');
        tables.forEach(table => {
            if (table.closest('.am-keep-table') || table.querySelector('thead [rowspan], thead [colspan]')) return;
            const headers = [...table.querySelectorAll('thead tr:first-child th')].map(th => th.textContent.trim());
            if (!headers.length) return;
            table.classList.add('am-responsive-table');
            table.querySelectorAll('tbody tr').forEach(row => {
                if (row.cells.length !== headers.length || [...row.cells].some(cell => cell.colSpan > 1)) return;
                [...row.cells].forEach((cell, index) => { cell.dataset.amLabel = headers[index]; });
            });
        });
    }
    labelTables(document);
    // Observe only inserted rows; no polling, cloning, or finance mutations.
    let queued = false;
    const changedTables = new Set();
    const observer = new MutationObserver(changes => {
        for (const change of changes) {
            for (const node of change.addedNodes) {
                if (node.nodeType !== 1) continue;
                const table = node.closest('table');
                if (table) changedTables.add(table);
                node.querySelectorAll('table').forEach(item => changedTables.add(item));
            }
        }
        if (queued || !changedTables.size) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            changedTables.forEach(table => { if (table.isConnected) labelTables(table); });
            changedTables.clear();
        });
    });
    if (main) observer.observe(main, { childList: true, subtree: true });
    document.querySelectorAll('[data-am-theme]').forEach(button => button.addEventListener('click', () => {
        const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        root.dataset.theme = theme; root.dataset.bsTheme = theme;
        try { localStorage.setItem('ahram_theme', theme); } catch (_) { /* Keep the current page usable. */ }
    }));
    new MutationObserver(() => {
        root.dataset.bsTheme = root.dataset.theme;
        document.querySelectorAll('[data-am-theme]').forEach(button => button.setAttribute('aria-pressed', String(root.dataset.theme === 'dark')));
        const color = getComputedStyle(root).getPropertyValue('--am-muted').trim();
        Object.values(window.Chart?.instances || {}).forEach(chart => {
            if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = color;
            Object.values(chart.options.scales || {}).forEach(scale => {
                if (scale.ticks) scale.ticks.color = color;
            });
            chart.update('none');
        });
    }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
})();
