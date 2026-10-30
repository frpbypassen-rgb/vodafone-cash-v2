(() => {
    'use strict';
    const root = document.querySelector('[data-retail-sessions]');
    if (!root) return;
    const find = (selector) => root.querySelector(selector);
    const devicesNode = find('[data-devices]'),
        requestsNode = find('[data-requests]');
    const refresh = find('[data-refresh]'),
        bulk = find('[data-revoke-others]');
    const dialog = document.getElementById('retailSessionConfirm');
    const confirm = dialog.querySelector('[data-session-confirm]');
    let snapshot = null,
        fresh = false,
        loading = false,
        busy = false,
        version = 0,
        pending = null;
    const element = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const dateOf = (value) => {
        if (!value) return null;
        const d = new Date(value);
        return Number.isFinite(d.getTime()) ? d : null;
    };
    const formatDate = (value) => {
        const d = dateOf(value);
        return d
            ? new Intl.DateTimeFormat('ar-LY', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                  timeZone: 'Africa/Tripoli',
              }).format(d)
            : 'غير متوفر';
    };
    const lastSeen = (value) => {
        const d = dateOf(value);
        if (!d) return 'غير متوفر';
        const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
        if (seconds < 0) return formatDate(value);
        if (seconds < 60) return 'خلال الدقيقة الأخيرة';
        const unit = seconds < 3600 ? 'minute' : seconds < 86400 ? 'hour' : 'day';
        const divisor = unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400;
        return new Intl.RelativeTimeFormat('ar', { numeric: 'auto' }).format(
            -Math.floor(seconds / divisor),
            unit
        );
    };
    const message = (text, error = false) => {
        const node = find('[data-status]');
        node.textContent = text;
        node.hidden = !text;
        node.classList.toggle('is-error', error);
    };
    const controls = () => {
        const disabled = !fresh || loading || busy;
        refresh.disabled = loading || busy;
        bulk.disabled =
            disabled ||
            !snapshot?.devices.some((device) => device.current === true) ||
            !snapshot?.devices.some((device) => device.current !== true);
        root.querySelectorAll('[data-revoke],[data-request-reject]').forEach((button) => {
            button.disabled = disabled;
        });
        devicesNode.setAttribute('aria-busy', String(loading));
    };
    const api = async (path, options = {}) => {
        const controller = new AbortController(),
            timer = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(path, {
                credentials: 'same-origin',
                cache: 'no-store',
                ...options,
                signal: controller.signal,
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || '',
                    ...options.headers,
                },
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success !== true)
                throw new Error(data.error || 'تعذر تأكيد استجابة الخادم. حدّث القائمة.');
            return data;
        } finally {
            clearTimeout(timer);
        }
    };
    const row = (list, label, value) => {
        const wrap = element('div');
        wrap.append(element('dt', '', label), element('dd', '', value));
        list.append(wrap);
    };
    const ask = (title, copy, label, action) => {
        if (!fresh || loading || busy) return;
        document.getElementById('retailSessionConfirmTitle').textContent = title;
        document.getElementById('retailSessionConfirmCopy').textContent = copy;
        confirm.textContent = label;
        pending = action;
        dialog.showModal();
    };
    const renderDevices = (devices) => {
        devicesNode.replaceChildren();
        if (!devices.length) {
            devicesNode.append(element('p', 'rs-empty', 'لا توجد أجهزة نشطة مسجلة.'));
            return;
        }
        [...devices]
            .sort((a, b) => Number(b.current === true) - Number(a.current === true))
            .forEach((device) => {
                const card = element('article', 'rs-device' + (device.current === true ? ' is-current' : '')),
                    head = element('header', 'rs-device-head');
                const icon = element('span', 'retail-settings-icon');
                const iconClass =
                    device.deviceType === 'phone' || device.channel === 'app'
                        ? 'fa-mobile-screen-button'
                        : device.deviceType === 'tablet'
                          ? 'fa-tablet-screen-button'
                          : 'fa-desktop';
                const glyph = element('i', 'fa-solid ' + iconClass);
                glyph.setAttribute('aria-hidden', 'true');
                icon.append(glyph);
                const title = String(device.displayName || 'جهاز غير معروف'),
                    copy = element('div', 'rs-device-title');
                copy.append(
                    element('h3', '', title),
                    element(
                        'p',
                        '',
                        [device.platform, device.browser].filter(Boolean).join(' · ') ||
                            (device.channel === 'app' ? 'تطبيق الهاتف' : 'موقع الويب')
                    )
                );
                head.append(icon, copy);
                if (device.current === true) head.append(element('span', 'rs-current', 'هذا الجهاز'));
                card.append(head);
                const activity = element('p', 'rs-last-seen', 'آخر نشاط: ' + lastSeen(device.lastSeenAt));
                card.append(activity);
                const details = element('details', 'rs-device-details');
                details.append(element('summary', '', 'عرض التفاصيل'));
                const values = element('dl');
                row(values, 'عنوان IP', device.lastIp || 'غير متوفر');
                row(values, 'آخر نشاط', formatDate(device.lastSeenAt));
                row(values, 'تاريخ اعتماد الجهاز', formatDate(device.approvedAt));
                row(values, 'نوع الاتصال', device.channel === 'app' ? 'تطبيق الهاتف' : 'موقع الويب');
                details.append(values);
                card.append(details);
                if (device.current !== true) {
                    const button = element('button', 'rs-danger', 'تسجيل خروج هذا الجهاز');
                    button.type = 'button';
                    button.dataset.revoke = String(device.id);
                    button.addEventListener('click', () =>
                        ask(
                            'تسجيل خروج الجهاز؟',
                            `سيتم إنهاء جلسة «${title}». سيحتاج هذا الجهاز إلى تسجيل الدخول مجددًا. تبقى جلستك الحالية.`,
                            'تأكيد تسجيل الخروج',
                            () =>
                                mutate(
                                    '/security/sessions/' + encodeURIComponent(device.id) + '/revoke',
                                    'تم إنهاء جلسة الجهاز.'
                                )
                        )
                    );
                    card.append(button);
                }
                devicesNode.append(card);
            });
    };
    const renderRequests = (requests) => {
        requestsNode.replaceChildren();
        find('[data-request-count]').textContent = String(requests.length);
        if (!requests.length) {
            requestsNode.append(element('p', 'rs-empty', 'لا توجد طلبات أجهزة جديدة.'));
            return;
        }
        requests.forEach((request) => {
            const card = element('article', 'rs-request');
            card.append(
                element('strong', '', request.displayName || 'جهاز جديد'),
                element('p', '', 'ينتهي الطلب: ' + formatDate(request.expiresAt))
            );
            const button = element('button', 'rs-danger', 'رفض الطلب');
            button.type = 'button';
            button.dataset.requestReject = String(request.id);
            button.addEventListener('click', () =>
                ask(
                    'رفض طلب الجهاز؟',
                    `هل تريد رفض طلب «${request.displayName || 'جهاز جديد'}»؟`,
                    'تأكيد الرفض',
                    () =>
                        mutate(
                            '/security/session-requests/' + encodeURIComponent(request.id) + '/reject',
                            'تم رفض طلب الجهاز.'
                        )
                )
            );
            card.append(button);
            requestsNode.append(card);
        });
    };
    const load = async (preserveMessage = false) => {
        if (busy && !preserveMessage) return;
        const ownVersion = ++version;
        loading = true;
        controls();
        if (!preserveMessage) message('');
        try {
            const data = await api(root.dataset.endpoint);
            if (ownVersion !== version) return;
            if (
                !Array.isArray(data.devices) ||
                !Array.isArray(data.requests) ||
                [...data.devices, ...data.requests].some(
                    (row) => !row || typeof row.id !== 'string' || !row.id
                )
            )
                throw new Error('بيانات الجلسات غير مكتملة. أعد التحديث.');
            snapshot = data;
            fresh = true;
            renderDevices(data.devices);
            renderRequests(data.requests);
            find('[data-session-count]').textContent = String(data.devices.length);
            find('[data-freshness]').textContent =
                data.devices.length && !data.devices.some((device) => device.current === true)
                    ? 'الجهاز الحالي غير مسجل؛ الخروج الجماعي غير متاح.'
                    : 'تم التحقق من حالة الأجهزة.';
            const time = find('[data-last-updated]');
            time.hidden = false;
            time.dateTime = new Date().toISOString();
            time.textContent = 'آخر تحديث ناجح: ' + formatDate(time.dateTime);
        } catch (error) {
            if (ownVersion !== version) return;
            fresh = false;
            find('[data-freshness]').textContent = 'تعذر التحقق — حدّث القائمة قبل إدارة الجلسات.';
            if (!snapshot) {
                find('[data-session-count]').textContent = '—';
                find('[data-request-count]').textContent = '—';
                devicesNode.replaceChildren(
                    element('p', 'rs-empty is-error', 'تعذر تحميل الجلسات. اضغط تحديث للمحاولة مجددًا.')
                );
                requestsNode.replaceChildren(element('p', 'rs-empty', 'تعذر تحميل طلبات الأجهزة.'));
            }
            message(error.name === 'AbortError' ? 'انتهت مهلة التحميل. أعد المحاولة.' : error.message, true);
        } finally {
            if (ownVersion === version) {
                loading = false;
                controls();
            }
        }
    };
    const mutate = async (path, success) => {
        if (busy || loading || !fresh) return;
        busy = true;
        ++version;
        controls();
        try {
            const result = await api(path, { method: 'POST', body: '{}' });
            if (result.currentRevoked) {
                window.location.assign('/client/logout');
                return;
            }
            message(
                result.revokedCount !== undefined
                    ? `تم إنهاء ${result.revokedCount} جهاز آخر. جلستك الحالية مستمرة.`
                    : success
            );
            await load(true);
        } catch (error) {
            fresh = false;
            find('[data-freshness]').textContent = 'حدّث القائمة للتحقق من حالة الجلسات.';
            message('تعذر تأكيد النتيجة؛ حدّث القائمة قبل إعادة المحاولة.', true);
        } finally {
            busy = false;
            controls();
        }
    };
    bulk.addEventListener('click', () =>
        ask(
            'تسجيل خروج الأجهزة الأخرى؟',
            'سيتم إنهاء جميع الأجهزة الأخرى. ستبقى جلستك الحالية مفتوحة.',
            'تسجيل خروج الأجهزة الأخرى',
            () => mutate('/security/sessions/revoke-others', 'تم إنهاء الجلسات الأخرى.')
        )
    );
    confirm.addEventListener('click', () => {
        const action = pending;
        pending = null;
        dialog.close();
        if (action) action();
    });
    dialog.querySelector('[data-session-cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
        pending = null;
    });
    refresh.addEventListener('click', () => load());
    load();
})();
