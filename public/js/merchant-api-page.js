(() => {
    'use strict';
    const statusLabel = (value) =>
        ({
            completed: ['مكتملة', 'success'],
            pending: ['قيد الانتظار', 'warning'],
            processing: ['جارٍ التنفيذ', 'info'],
            accepted: ['مقبولة', 'info'],
            rejected: ['مرفوضة', 'danger'],
            cancelled_by_admin: ['ملغاة', 'danger'],
        })[value] || ['غير معروف', 'muted'];
    const buildExample = (base) =>
        [
            `curl --request GET "${base}/balance"`,
            '  --header "x-api-key: <API_KEY>"',
            '  --header "Accept: application/json"',
        ].join(' \\\n');
    if (typeof module !== 'undefined' && module.exports)
        module.exports = { statusLabel, buildExample };
    if (typeof document === 'undefined') return;
    const root = document.querySelector('[data-api-page]');
    if (!root) return;
    const config = JSON.parse(
        document.getElementById('api-page-config').textContent,
    );
    const get = (key) => root.querySelector('[data-api-' + key + ']');
    const dialog = get('dialog');
    const base =
        config.portalBase === '/agent-portal' ? '/agent-portal' : '/client';
    let status = config.status,
        busy = false,
        unavailable = false,
        refreshing = false,
        returnFocus;
    const date = (value) =>
        value && Number.isFinite(new Date(value).getTime())
            ? new Date(value).toLocaleString('ar-LY', {
                  timeZone: 'Africa/Tripoli',
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
              })
            : '—';
    const tell = (text, tone = 'success') => {
        const box = get('notice');
        box.hidden = false;
        box.className = 'wh-notice wh-' + tone;
        box.textContent = text;
    };
    const controls = () => {
        get('rotate').disabled =
            busy || refreshing || unavailable || !status.apiEnabled;
        get('revoke').disabled =
            busy ||
            refreshing ||
            unavailable ||
            !status.apiEnabled ||
            !status.keyActive;
        get('refresh').disabled = busy || refreshing;
        get('ip-manage').disabled = busy || refreshing || unavailable;
        dialog
            .querySelectorAll('button')
            .forEach(
                (button) =>
                    (button.disabled =
                        busy ||
                        (button.type === 'submit' &&
                            (unavailable ||
                                (dialog.dataset.mode !== 'ip-policy' &&
                                    !status.apiEnabled)))),
            );
    };
    const render = () => {
        const badge = get('state');
        badge.textContent = status.apiEnabled
            ? status.keyActive
                ? 'مفعّلة'
                : 'بدون مفتاح نشط'
            : 'موقوفة من الإدارة';
        badge.className =
            'wh-badge wh-' +
            (status.apiEnabled && status.keyActive ? 'success' : 'muted');
        get('description').textContent = status.apiEnabled
            ? 'استبدال المفتاح يوقف المفتاح السابق فورًا.'
            : 'تواصل مع الإدارة لتفعيل خدمة API لهذا الحساب.';
        get('hint').textContent = status.keyHint
            ? '•••• •••• ' + status.keyHint
            : 'لا يوجد مفتاح حالي';
        get('created').textContent = date(status.keyCreatedAt);
        get('rotate').textContent = status.keyActive
            ? 'استبدال المفتاح'
            : 'إنشاء مفتاح';
        get('revoke').hidden = !status.keyActive || !status.apiEnabled;
        get('webhooks').hidden = !status.webhooksEnabled;
        get('webhooks-locked').hidden = status.webhooksEnabled;
        get('ip-state').textContent = status.ipAllowlistEnabled
            ? 'مفعّلة'
            : 'غير مفعّلة';
        get('ip-state').className =
            'wh-badge wh-' + (status.ipAllowlistEnabled ? 'success' : 'muted');
        const ips = Array.isArray(status.allowedIps) ? status.allowedIps : [];
        get('ip-addresses').textContent = ips.length
            ? ips.slice(0, 3).join(' · ') +
              (ips.length > 3 ? ` · +${ips.length - 3}` : '')
            : 'لا توجد عناوين مسجلة.';
        controls();
    };
    const api = async (suffix = '', body) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(base + '/api/integrations' + suffix, {
                method: body ? 'POST' : 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                signal: controller.signal,
                headers: {
                    Accept: 'application/json',
                    ...(body
                        ? {
                              'Content-Type': 'application/json',
                              'X-CSRF-Token': config.csrf,
                          }
                        : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (response.redirected || response.status === 401)
                throw new Error('انتهت الجلسة. سجّل الدخول مجددًا.');
            if (response.status === 429)
                throw new Error('طلبات كثيرة. انتظر قليلًا قبل المحاولة.');
            if (
                !response.headers
                    .get('content-type')
                    ?.includes('application/json')
            )
                throw new Error('تعذر الاتصال. حدّث الحالة وأعد المحاولة.');
            const result = await response.json();
            if (!response.ok || result.success !== true)
                throw new Error(result.error || 'تعذر تنفيذ الطلب.');
            return result.data;
        } catch (error) {
            if (error.name === 'AbortError')
                throw new Error(
                    'انتهت مهلة الاتصال. حدّث الحالة قبل تكرار الإجراء.',
                );
            throw error;
        } finally {
            clearTimeout(timer);
        }
    };
    const loadActivity = async () => {
        try {
            const data = await api('/activity');
            if (!Array.isArray(data.rows)) throw new Error();
            const area = get('history');
            area.replaceChildren();
            get('last').textContent = date(data.rows[0]?.createdAt);
            if (!data.rows.length) {
                const text = document.createElement('p');
                text.className = 'api-caption';
                text.textContent = 'لا توجد عمليات API بعد.';
                area.append(text);
                return;
            }
            const list = document.createElement('ul');
            for (const row of data.rows.slice(0, 5)) {
                const item = document.createElement('li'),
                    ref = document.createElement('span'),
                    badge = document.createElement('span'),
                    when = document.createElement('time');
                ref.className = 'api-reference';
                ref.textContent = row.reference;
                const label = statusLabel(row.status);
                badge.className = 'wh-badge wh-' + label[1];
                badge.textContent = label[0];
                when.textContent = date(row.createdAt);
                item.append(ref, badge, when);
                list.append(item);
            }
            area.append(list);
        } catch {
            get('history').textContent =
                'تعذر تحميل السجل. استخدم زر التحديث للمحاولة مجددًا.';
            get('last').textContent = 'غير متاح';
        }
    };
    const refresh = async () => {
        if (refreshing) return false;
        refreshing = true;
        controls();
        try {
            status = await api();
            unavailable = false;
            render();
            return true;
        } catch (error) {
            unavailable = true;
            get('state').textContent = 'تعذر تحديث الحالة';
            tell(error.message, 'danger');
            return false;
        } finally {
            refreshing = false;
            controls();
        }
    };
    const close = () => {
        if (!busy) dialog.close();
    };
    dialog.addEventListener('close', () => {
        dialog.replaceChildren();
        if (returnFocus?.isConnected && !returnFocus.disabled)
            returnFocus.focus();
        else get('refresh').focus();
    });
    dialog.addEventListener('cancel', (event) => {
        if (busy) event.preventDefault();
    });
    const open = (title, content, footer) => {
        dialog.dataset.mode = 'key';
        if (!dialog.open) returnFocus = document.activeElement;
        // Only application-owned static templates are inserted here. All API data uses textContent/value.
        dialog.innerHTML =
            '<div class="wh-dialog-head"><h2 id="api-dialog-title"></h2><button type="button" class="wh-icon-button" data-close aria-label="إغلاق النافذة">×</button></div><div class="wh-dialog-content">' +
            content +
            '</div><div class="wh-dialog-footer">' +
            footer +
            '</div>';
        dialog.querySelector('h2').textContent = title;
        dialog
            .querySelectorAll('[data-close]')
            .forEach((button) => button.addEventListener('click', close));
        if (!dialog.open) dialog.showModal();
        (
            dialog.querySelector('input,textarea') ||
            dialog.querySelector('[data-close]')
        ).focus();
    };
    const copy = async (value, input) => {
        try {
            await navigator.clipboard.writeText(value);
            return true;
        } catch {
            input?.focus();
            input?.select();
            return false;
        }
    };
    const showToken = (token) => {
        open(
            'المفتاح الجديد',
            '<p class="wh-helper">المفتاح السابق متوقف. احفظ الجديد الآن؛ لن يظهر كاملًا بعد إغلاق النافذة.</p><label class="wh-field">مفتاح API<textarea class="wh-input api-secret" readonly dir="ltr" rows="3" autocomplete="off" spellcheck="false"></textarea></label><p class="wh-helper" data-copy-result role="status"></p>',
            '<button type="button" class="wh-button" data-close>تم الحفظ</button><button type="button" class="wh-button wh-primary" data-copy-token>نسخ المفتاح</button>',
        );
        const field = dialog.querySelector('textarea');
        field.value = token;
        dialog
            .querySelector('[data-copy-token]')
            .addEventListener('click', async () => {
                const copied = await copy(field.value, field);
                dialog.querySelector('[data-copy-result]').textContent = copied
                    ? 'تم النسخ.'
                    : 'حدد المفتاح وانسخه يدويًا.';
            });
    };
    const confirmAction = (action) => {
        if (busy || unavailable || !status.apiEnabled) return;
        const rotating = action === '/rotate';
        open(
            rotating
                ? status.keyActive
                    ? 'استبدال المفتاح'
                    : 'إنشاء مفتاح'
                : 'إيقاف المفتاح',
            '<p class="wh-helper">' +
                (rotating
                    ? 'بعد التأكيد، يتوقف المفتاح السابق فورًا. حدّث نظامك بالمفتاح الجديد لإكمال الربط.'
                    : 'ستُرفض الطلبات التي تستخدم المفتاح الحالي. لاستئناف الربط ستحتاج إنشاء مفتاح جديد.') +
                '</p><form id="api-confirm-form"><label class="wh-field">كلمة المرور الحالية<input class="wh-input" name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><p class="wh-dialog-error" data-error role="alert" hidden></p></form>',
            '<button type="button" class="wh-button" data-close>إلغاء</button><button type="submit" form="api-confirm-form" class="wh-button ' +
                (rotating ? 'wh-primary' : 'wh-danger-button') +
                '">' +
                (rotating ? 'تأكيد وإصدار المفتاح' : 'تأكيد الإيقاف') +
                '</button>',
        );
        const form = dialog.querySelector('form');
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (busy || !form.reportValidity()) return;
            busy = true;
            controls();
            const password = form.elements.currentPassword;
            try {
                const result = await api(action, {
                    currentPassword: password.value,
                });
                password.value = '';
                if (rotating) {
                    if (typeof result.token !== 'string' || !result.token)
                        throw new Error(
                            'تعذر عرض المفتاح. حدّث الحالة قبل أي محاولة أخرى.',
                        );
                    showToken(result.token);
                    controls();
                } else {
                    busy = false;
                    dialog.close();
                    busy = true;
                    tell('تم إيقاف المفتاح.');
                }
                const synced = await refresh();
                if (!synced && rotating)
                    tell(
                        'تم إصدار المفتاح؛ احفظه من النافذة الحالية ثم حدّث الحالة.',
                        'warning',
                    );
            } catch (error) {
                password.value = '';
                const box = dialog.querySelector('[data-error]');
                if (box) {
                    box.hidden = false;
                    box.textContent = error.message;
                } else tell(error.message, 'danger');
                // Re-read the administrative gate without repeating the mutation.
                await refresh();
            } finally {
                busy = false;
                controls();
            }
        });
    };
    const openIpPolicy = () => {
        if (busy || unavailable) return;
        const revision = status.revision;
        open(
            'القائمة البيضاء IP',
            '<p class="wh-helper">أضف IP العام لسيرفر شركتك، وليس IP الهاتف. عند التفعيل تُرفض طلبات API من أي عنوان آخر. تظل إدارة الحساب متاحة.</p><form id="api-ip-form"><label class="wh-check"><input type="checkbox" name="ipEnabled"><span>تفعيل القائمة البيضاء</span></label><label class="wh-field">عناوين السيرفر<textarea class="wh-input api-ip-input" name="addresses" dir="ltr" rows="3" maxlength="1400" spellcheck="false" placeholder="192.0.2.10&#10;2001:db8::10"></textarea></label><p class="wh-helper">عنوان IPv4 أو IPv6 في كل سطر، بحد أقصى 20 عنوانًا.</p><label class="wh-field">كلمة المرور الحالية<input type="password" class="wh-input" name="currentPassword" required maxlength="128" autocomplete="current-password"></label><p class="wh-dialog-error" data-error role="alert" hidden></p></form>',
            '<button type="button" class="wh-button" data-close>إلغاء</button><button type="submit" form="api-ip-form" class="wh-button wh-primary">حفظ الإعدادات</button>',
        );
        dialog.dataset.mode = 'ip-policy';
        const form = dialog.querySelector('form');
        form.elements.ipEnabled.checked = Boolean(status.ipAllowlistEnabled);
        form.elements.addresses.value = (status.allowedIps || []).join('\n');
        form.elements.addresses.focus();
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (busy || !form.reportValidity()) return;
            const addresses = form.elements.addresses.value
                .split(/[\s,،]+/)
                .filter(Boolean);
            const errorBox = form.querySelector('[data-error]');
            if (form.elements.ipEnabled.checked && !addresses.length) {
                errorBox.hidden = false;
                errorBox.textContent =
                    'أضف عنوان IP واحدًا على الأقل قبل التفعيل.';
                return;
            }
            busy = true;
            controls();
            try {
                status = await api('/ip-policy', {
                    revision,
                    ipAllowlistEnabled: form.elements.ipEnabled.checked,
                    allowedIps: addresses,
                    currentPassword: form.elements.currentPassword.value,
                });
                form.elements.currentPassword.value = '';
                render();
                busy = false;
                dialog.close();
                tell(
                    status.ipAllowlistEnabled
                        ? 'تم تفعيل القائمة البيضاء. تُقبل طلبات API من العناوين المحددة فقط.'
                        : 'تم إيقاف القائمة البيضاء. يبقى التوكن مطلوبًا لكل طلب.',
                );
            } catch (error) {
                form.elements.currentPassword.value = '';
                errorBox.hidden = false;
                errorBox.textContent = error.message;
                await refresh();
            } finally {
                busy = false;
                controls();
            }
        });
        controls();
    };
    get('ip-manage').addEventListener('click', openIpPolicy);
    get('rotate').addEventListener('click', () => confirmAction('/rotate'));
    get('revoke').addEventListener('click', () => confirmAction('/revoke'));
    get('refresh').addEventListener('click', async () => {
        if (busy) return;
        await Promise.all([refresh(), loadActivity()]);
    });
    get('copy-base').addEventListener('click', async () =>
        tell(
            (await copy(config.apiBase, document.getElementById('api-address')))
                ? 'تم نسخ عنوان الخدمة.'
                : 'حدد العنوان وانسخه يدويًا.',
            'info',
        ),
    );
    const example = buildExample(config.apiBase);
    get('example').textContent = example;
    get('copy-example').addEventListener('click', async () =>
        tell(
            (await copy(example))
                ? 'تم نسخ المثال.'
                : 'يمكنك تحديد المثال ونسخه يدويًا.',
            'info',
        ),
    );
    window.addEventListener('pagehide', () => dialog.replaceChildren());
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            dialog.close();
            refresh();
        }
    });
    window.addEventListener('focus', () => {
        if (!busy && !dialog.open) refresh();
    });
    window.setInterval(() => {
        if (!busy && !dialog.open && document.visibilityState === 'visible')
            refresh();
    }, 15000);
    render();
    loadActivity();
})();
