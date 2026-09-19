'use strict';

(() => {
    const root = document.documentElement;
    const body = document.body;
    if (root.getAttribute('data-portal') !== 'customer' && !body.classList.contains('cl-app')) return;

    const csrf = window.clientPortal?.csrfToken || window.businessPortal?.csrfToken || '';
    const jsonHeaders = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-csrf-token': csrf
    };
    const THEMES = ['day', 'night', 'pharaonic'];
    const THEME_COLORS = { day: '#E8EEFA', night: '#070B14', pharaonic: '#1C1610' };
    const THEME_ICONS = { day: 'fa-sun', night: 'fa-moon', pharaonic: 'fa-landmark' };

    const applyTheme = (value, persist = true) => {
        const next = THEMES.includes(value) ? value : 'day';
        root.setAttribute('data-theme', next);
        body.setAttribute('data-theme', next);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', THEME_COLORS[next]);
        document.querySelectorAll('[data-theme-option]').forEach((button) => {
            button.setAttribute('aria-pressed', button.dataset.themeOption === next ? 'true' : 'false');
        });
        document.querySelectorAll('#themeIcon, #mobileThemeIcon, [data-theme-menu-toggle] i').forEach((icon) => {
            if (icon) icon.className = `fa-solid ${THEME_ICONS[next]}`;
        });
        const select = document.querySelector('[data-preference="client-theme"]');
        if (select) select.value = next;
        if (next === 'pharaonic') root.classList.add('cl-art-ready');
        else root.classList.remove('cl-art-ready');
        if (!persist) return;
        try { localStorage.setItem('ahram_client_theme', next); } catch (_error) { /* private mode */ }
        fetch('/client/api/theme', {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ theme: next })
        }).catch(() => {});
    };

    const serverTheme = THEMES.includes(root.getAttribute('data-theme')) ? root.getAttribute('data-theme') : '';
    const stored = localStorage.getItem('ahram_client_theme');
    const current = serverTheme || (THEMES.includes(stored) ? stored : 'day');
    applyTheme(current, false);
    if (serverTheme) {
        try { localStorage.setItem('ahram_client_theme', serverTheme); } catch (_error) { /* private mode */ }
    }

    const enableArt = () => {
        if (current === 'pharaonic') root.classList.add('cl-art-ready');
    };
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(enableArt, { timeout: 1200 });
    } else {
        window.setTimeout(enableArt, 400);
    }

    window.toggleTheme = function toggleTheme() {
        const now = root.getAttribute('data-theme');
        const index = THEMES.indexOf(now);
        applyTheme(THEMES[(index + 1) % THEMES.length]);
    };

    const switcher = document.querySelector('[data-client-theme-switcher]');
    if (switcher) {
        const toggle = switcher.querySelector('[data-theme-menu-toggle]');
        const panel = switcher.querySelector('[data-theme-panel]');
        const setOpen = (open) => {
            if (!panel || !toggle) return;
            panel.hidden = !open;
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
        toggle?.addEventListener('click', (event) => {
            event.stopPropagation();
            setOpen(Boolean(panel?.hidden));
        });
        document.addEventListener('click', (event) => {
            if (!switcher.contains(event.target)) setOpen(false);
        });
        switcher.addEventListener('click', (event) => {
            const option = event.target.closest('[data-theme-option]');
            if (!option) return;
            event.preventDefault();
            applyTheme(option.dataset.themeOption);
            setOpen(false);
        });
        switcher.querySelector('.cl-theme-ssr-form')?.addEventListener('submit', (event) => {
            event.preventDefault();
        });
    }

    const select = document.querySelector('[data-preference="client-theme"]');
    if (select) {
        select.value = current;
        select.addEventListener('change', () => applyTheme(select.value));
    }
})();
