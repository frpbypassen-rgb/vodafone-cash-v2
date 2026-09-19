'use strict';

(() => {
    const config = window.businessPortal || {};
    if (config.workspaceType !== 'company') return;

    const csrf = config.csrfToken || '';
    const jsonHeaders = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-csrf-token': csrf
    };
    const THEMES = ['day', 'night', 'pharaonic'];
    const THEME_COLORS = { day: '#F4F6F8', night: '#12110F', pharaonic: '#1A1510' };
    const THEME_ICONS = { day: 'sun-day', night: 'moon', pharaonic: 'ankh' };

    const parseJson = async (response) => {
        const text = await response.text();
        try { return text ? JSON.parse(text) : {}; }
        catch (_) { return {}; }
    };

    const registerWorker = async () => {
        if (!('serviceWorker' in navigator)) return null;
        try {
            return await navigator.serviceWorker.register('/client/sw.js', { scope: '/client/' });
        } catch (_) {
            return null;
        }
    };

    const urlBase64ToUint8Array = (value) => {
        const padding = '='.repeat((4 - (value.length % 4)) % 4);
        const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = window.atob(base64);
        return Uint8Array.from(raw, (character) => character.charCodeAt(0));
    };

    const renderBell = (payload) => {
        const countEl = document.querySelector('[data-bell-count]');
        const groupsEl = document.querySelector('[data-bell-groups]');
        if (!groupsEl) return;
        const unread = Number(payload.unreadCount || payload.count || 0);
        if (countEl) {
            countEl.hidden = unread < 1;
            countEl.textContent = unread > 99 ? '99+' : String(unread);
        }
        const groups = Array.isArray(payload.groups) ? payload.groups : [];
        const hasItems = groups.some((group) => (group.items || []).length);
        if (!hasItems) {
            groupsEl.innerHTML = '<p class="cp-bell-empty">لا إشعارات حالياً</p>';
            return;
        }
        groupsEl.innerHTML = groups.map((group) => {
            const items = group.items || [];
            if (!items.length) return '';
            return `<section><div class="cp-bell-group-title">${group.label}</div>${items.map((item) => `
                <button type="button" class="cp-bell-item${item.isRead ? '' : ' is-unread'}" data-bell-item data-id="${item.id}" data-href="${item.href || '/client/services'}">
                    <span>${item.title}</span>
                    <small>${item.relativeTime || ''} · ${item.message || ''}</small>
                </button>`).join('')}</section>`;
        }).join('');
    };

    const loadInbox = async () => {
        try {
            const response = await fetch('/client/api/notifications', { headers: { Accept: 'application/json' } });
            const payload = await parseJson(response);
            if (payload.success) renderBell(payload);
        } catch (_) { /* optional */ }
    };

    const markRead = async (id) => {
        if (!id) return;
        await fetch(`/client/api/notifications/${encodeURIComponent(id)}/read`, {
            method: 'POST',
            headers: jsonHeaders
        }).catch(() => {});
    };

    const setupBell = () => {
        const root = document.querySelector('[data-company-bell]');
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
            await markRead(item.dataset.id);
            const href = item.dataset.href || '/client/services';
            window.location.href = href;
        });
        loadInbox();
        window.setInterval(loadInbox, 30000);
    };

    const setupPush = () => {
        const card = document.querySelector('[data-company-push]');
        if (!card) return;
        const statusEl = card.querySelector('[data-push-status]');
        const enableBtn = card.querySelector('[data-push-enable]');
        const testBtn = card.querySelector('[data-push-test]');
        const disableBtn = card.querySelector('[data-push-disable]');
        const setStatus = (text) => {
            if (statusEl) statusEl.textContent = text;
        };
        const refresh = async () => {
            const response = await fetch('/client/api/web-push/status', { headers: { Accept: 'application/json' } });
            const payload = await parseJson(response);
            if (!payload.configured) {
                setStatus('مفاتيح Web Push غير مضبوطة على الخادم.');
                return payload;
            }
            setStatus(payload.subscribed ? 'المتصفح مرتبط بإشعارات بوابة الشركات.' : 'الإشعارات مغلقة لهذا المتصفح.');
            return payload;
        };
        enableBtn?.addEventListener('click', async () => {
            try {
                const status = await refresh();
                if (!status?.configured || !status.publicKey) return;
                if (Notification.permission === 'denied') {
                    setStatus('المتصفح رفض الإذن. فعّله من إعدادات الموقع.');
                    return;
                }
                const permission = Notification.permission === 'granted'
                    ? 'granted'
                    : await Notification.requestPermission();
                if (permission !== 'granted') {
                    setStatus('لم يتم منح إذن الإشعارات.');
                    return;
                }
                const registration = await registerWorker() || await navigator.serviceWorker.ready;
                const subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(status.publicKey)
                });
                const response = await fetch('/client/api/web-push/subscribe', {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ subscription })
                });
                const payload = await parseJson(response);
                setStatus(payload.success ? 'تم تفعيل إشعارات المتصفح.' : (payload.error || 'تعذر حفظ الاشتراك.'));
            } catch (_) {
                setStatus('تعذر تفعيل الإشعارات في هذا المتصفح.');
            }
        });
        disableBtn?.addEventListener('click', async () => {
            await fetch('/client/api/web-push/unsubscribe', { method: 'POST', headers: jsonHeaders, body: '{}' }).catch(() => {});
            setStatus('تم إيقاف إشعارات هذا المتصفح.');
        });
        testBtn?.addEventListener('click', async () => {
            const response = await fetch('/client/api/web-push/test', { method: 'POST', headers: jsonHeaders });
            const payload = await parseJson(response);
            setStatus(payload.success ? 'تم إرسال إشعار الاختبار.' : (payload.error || 'تعذر إرسال الاختبار.'));
        });
        refresh().catch(() => {});
    };

    const setupTheme = () => {
        const root = document.documentElement;
        const body = document.body;
        const switcher = document.querySelector('[data-company-theme-switcher]');
        const applyTheme = (value, persist = true) => {
            const next = THEMES.includes(value) ? value : 'day';
            root.setAttribute('data-theme', next);
            body.setAttribute('data-theme', next);
            const meta = document.querySelector('meta[name="theme-color"]');
            if (meta) meta.setAttribute('content', THEME_COLORS[next]);
            document.querySelectorAll('[data-theme-option]').forEach((button) => {
                button.setAttribute('aria-pressed', button.dataset.themeOption === next ? 'true' : 'false');
            });
            const toggleIcon = document.querySelector('[data-theme-menu-toggle] use');
            if (toggleIcon) toggleIcon.setAttribute('href', `#cp-icon-${THEME_ICONS[next]}`);
            const select = document.querySelector('[data-preference="company-theme"]');
            if (select) select.value = next;
            if (!persist) return;
            localStorage.setItem('ahram_company_theme', next);
            fetch('/client/api/theme', {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ theme: next })
            }).catch(() => {});
        };

        const stored = localStorage.getItem('ahram_company_theme');
        const current = THEMES.includes(stored)
            ? stored
            : (THEMES.includes(root.getAttribute('data-theme')) ? root.getAttribute('data-theme') : 'day');
        applyTheme(current, Boolean(stored));

        if (!switcher) return;
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
            applyTheme(option.dataset.themeOption);
            setOpen(false);
        });
        const select = document.querySelector('[data-preference="company-theme"]');
        if (select) {
            select.value = current;
            select.addEventListener('change', () => applyTheme(select.value));
        }
    };

    registerWorker();
    setupTheme();
    setupBell();
    setupPush();
})();
