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

    const parseJson = async (response) => {
        const text = await response.text();
        try { return text ? JSON.parse(text) : {}; } catch (_error) { return {}; }
    };

    const isRetail = Boolean(
        window.clientPortal?.retail
        || body.classList.contains('wallet-hub-active')
        || body.classList.contains('wallet-hub-dashboard')
    );

    const retailHref = (href) => {
        const target = String(href || '').trim() || '/client/dashboard';
        if (!isRetail) return target;
        if (target === '/client/transactions' || target === '/client/finance') return '/client/account?tab=operations';
        if (target === '/client/company/deposits') return '/client/account?tab=deposits-new';
        return target;
    };

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));

    const renderBell = (payload) => {
        const countEl = document.querySelector('[data-customer-bell] [data-bell-count]');
        const groupsEl = document.querySelector('[data-customer-bell] [data-bell-groups]');
        if (!groupsEl) return;
        const unread = Number(payload.unreadCount || payload.count || 0);
        if (countEl) {
            countEl.hidden = unread < 1;
            countEl.textContent = unread > 99 ? '99+' : String(unread);
        }
        const groups = Array.isArray(payload.groups) ? payload.groups : [];
        const hasItems = groups.some((group) => (group.items || []).length);
        if (!hasItems) {
            groupsEl.innerHTML = '<p class="cl-bell-empty">لا إشعارات حالياً</p>';
            return;
        }
        groupsEl.innerHTML = groups.map((group) => {
            const items = group.items || [];
            if (!items.length) return '';
            return `<section><div class="cl-bell-group-title">${escapeHtml(group.label)}</div>${items.map((item) => `
                <button type="button" class="cl-bell-item${item.isRead ? '' : ' is-unread'}" data-bell-item data-id="${escapeHtml(item.id)}" data-href="${escapeHtml(retailHref(item.href || '/client/dashboard'))}">
                    <span>${escapeHtml(item.title)}</span>
                    <small>${escapeHtml(item.relativeTime || '')} · ${escapeHtml(item.message || '')}</small>
                </button>`).join('')}</section>`;
        }).join('');
    };

    const loadInbox = async () => {
        try {
            const response = await fetch('/client/api/notifications', { headers: { Accept: 'application/json' } });
            const payload = await parseJson(response);
            if (payload.success) renderBell(payload);
        } catch (_error) { /* optional */ }
    };

    const setupBell = () => {
        const root = document.querySelector('[data-customer-bell]');
        if (!root) return;
        const toggle = root.querySelector('[data-bell-toggle]');
        const panel = root.querySelector('[data-bell-panel]');
        const setOpen = (open) => {
            if (!panel || !toggle) return;
            panel.hidden = !open;
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) loadInbox();
        };
        toggle?.addEventListener('click', (event) => {
            event.stopPropagation();
            setOpen(Boolean(panel?.hidden));
        });
        document.addEventListener('click', (event) => {
            if (!root.contains(event.target)) setOpen(false);
        });
        root.addEventListener('click', async (event) => {
            const readAll = event.target.closest('[data-bell-read-all]');
            if (readAll) {
                await fetch('/client/api/notifications/read-all', { method: 'POST', headers: jsonHeaders }).catch(() => {});
                await loadInbox();
                return;
            }
            const item = event.target.closest('[data-bell-item]');
            if (!item) return;
            if (item.dataset.id) {
                await fetch(`/client/api/notifications/${encodeURIComponent(item.dataset.id)}/read`, {
                    method: 'POST',
                    headers: jsonHeaders
                }).catch(() => {});
            }
            window.location.href = retailHref(item.dataset.href || '/client/dashboard');
        });
        loadInbox();
        window.setInterval(loadInbox, 30000);
    };

    const setupMoreSheet = () => {
        const drawer = document.getElementById('customerMoreSheet');
        const open = () => {
            if (drawer && typeof drawer.showModal === 'function') drawer.showModal();
        };
        const close = () => {
            if (drawer && typeof drawer.close === 'function') drawer.close();
        };
        document.querySelectorAll('[data-cl-more-open]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                open();
            });
        });
        drawer?.querySelector('[data-cl-more-close]')?.addEventListener('click', close);
        window.openWalletHubMore = open;
        window.closeWalletHubMore = close;
    };

    setupBell();
    setupMoreSheet();
})();
