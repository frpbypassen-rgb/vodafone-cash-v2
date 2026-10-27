(() => {
    'use strict';
    const EVENTS = [
        'transfer.created',
        'transfer.completed',
        'transfer.cancelled',
    ];
    const eventLabel = (value) =>
        ({
            'transfer.created': 'إنشاء عملية',
            'transfer.completed': 'اكتمال عملية',
            'transfer.cancelled': 'إلغاء عملية',
        })[value] || 'حدث عملية';
    const escapeHtml = (value) =>
        String(value ?? '').replace(
            /[&<>"']/g,
            (char) =>
                ({
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;',
                })[char],
        );
    const deliveryLabel = (status) =>
        ({
            delivered: { text: 'ناجح', tone: 'success' },
            failed: { text: 'فشل', tone: 'danger' },
            pending: { text: 'بانتظار الإرسال', tone: 'warning' },
            sending: { text: 'جارٍ الإرسال', tone: 'info' },
        })[status] || { text: 'غير معروف', tone: 'muted' };
    const filterDeliveries = (rows, filter) =>
        filter === 'failed' || filter === 'delivered'
            ? rows.filter((row) => row.status === filter)
            : rows;
    const canRetry = (row) => row?.status === 'failed';
    const validateInput = (input) => {
        const name = String(input.name || '').trim();
        if (!name) throw new Error('WEBHOOK_NAME_REQUIRED');
        let url;
        try {
            url = new URL(String(input.url || '').trim());
        } catch {
            throw new Error('INVALID_WEBHOOK_URL');
        }
        if (url.protocol !== 'https:')
            throw new Error('WEBHOOK_HTTPS_REQUIRED');
        if (url.username || url.password)
            throw new Error('INVALID_WEBHOOK_URL');
        const events = [
            ...new Set(
                (Array.isArray(input.events) ? input.events : []).filter(
                    (event) => EVENTS.includes(event),
                ),
            ),
        ];
        if (!events.length) throw new Error('WEBHOOK_EVENTS_REQUIRED');
        return { name, url: url.toString(), events };
    };
    if (typeof module !== 'undefined' && module.exports)
        module.exports = {
            escapeHtml,
            filterDeliveries,
            deliveryLabel,
            canRetry,
            validateInput,
        };
    if (typeof window === 'undefined' || typeof customElements === 'undefined')
        return;

    const paths = {
        more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
        copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/>',
        close: '<path d="m6 6 12 12M18 6 6 18"/>',
        refresh:
            '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
        link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
        edit: '<path d="m14 4 6 6M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16l-1 4Z"/>',
        shield: '<path d="m12 3 8 4v5c0 4-4 7-8 9-4-2-8-5-8-9V7l8-4Z"/>',
        pause: '<path d="M8 5v14M16 5v14"/>',
        play: '<path d="m8 4 12 8-12 8V4Z"/>',
        trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
        history: '<path d="M4 5v5h5M4 10a8 8 0 1 1 1 8M12 7v5l3 2"/>',
    };
    const icon = (name) =>
        `<svg class="wh-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.link}</svg>`;
    const time = (value) => {
        const date = new Date(value);
        return value && Number.isFinite(date.getTime())
            ? date.toLocaleString('ar-LY', {
                  timeZone: 'Africa/Tripoli',
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
              })
            : '—';
    };
    const errorText = (error) =>
        ({
            WEBHOOK_NAME_REQUIRED: 'أدخل اسمًا للرابط.',
            WEBHOOK_HTTPS_REQUIRED: 'استخدم رابطًا يبدأ بـ https://.',
            INVALID_WEBHOOK_URL:
                'أدخل رابط HTTPS صحيحًا دون اسم مستخدم أو كلمة مرور.',
            WEBHOOK_PRIVATE_ADDRESS:
                'يلزم رابط HTTPS عام؛ العناوين المحلية غير مدعومة.',
            WEBHOOK_HOST_UNRESOLVED:
                'تعذر الوصول إلى اسم النطاق. تحقق من الرابط.',
            WEBHOOK_EVENTS_REQUIRED: 'اختر حدثًا واحدًا على الأقل.',
            WEBHOOK_DISABLED_BY_ADMIN: 'تم إيقاف Webhooks من الإدارة.',
            WEBHOOK_ACCESS_DENIED: 'لا تملك صلاحية إدارة هذا الربط.',
            WEBHOOK_NOT_FOUND: 'لم يعد هذا الرابط متاحًا. حدّث الصفحة.',
            WEBHOOK_NOT_FOUND_OR_DISABLED: 'الرابط غير متاح أو متوقف.',
            DELIVERY_NOT_FOUND: 'لم تعد المحاولة متاحة. حدّث سجل الإرسال.',
            WEBHOOK_TEST_DENIED:
                'تعذر إجراء الاختبار. تحقق من الصلاحية وحالة الرابط.',
            SESSION_EXPIRED:
                'انتهت جلسة الدخول. عد إلى الحساب لتسجيل الدخول مجددًا.',
            RATE_LIMITED: 'بلغت حد اختبارات الاتصال. حاول لاحقًا.',
            REQUEST_TIMEOUT:
                'تعذر تأكيد النتيجة في الوقت المحدد. حدّث الحالة قبل إعادة المحاولة.',
        })[error?.message] ||
        'تعذر إكمال الطلب. تحقق من الاتصال ثم حدّث الحالة قبل المحاولة مجددًا.';

    class MerchantWebhooks extends HTMLElement {
        constructor() {
            super();
            this.data = { endpoints: [], deliveries: [] };
            this.filter = 'all';
            this.limit = 8;
            this.loading = false;
            this.busy = false;
            this.loaded = false;
            this.onClick = (event) => this.handleClick(event);
            this.onSubmit = (event) => {
                if (event.target.matches('[data-editor]')) {
                    event.preventDefault();
                    this.saveEditor(event.target);
                }
            };
            this.onOutside = (event) => {
                if (!event.target.closest?.('.wh-menu')) this.closeMenus();
            };
            this.onKey = (event) => {
                if (event.key === 'Escape') this.closeMenus();
            };
            this.onCreate = () => this.openEditor();
        }
        connectedCallback() {
            if (this.initialized) return;
            this.initialized = true;
            let config = {};
            try {
                config = JSON.parse(
                    document.getElementById('webhook-config')?.textContent ||
                        '{}',
                );
            } catch {
                /* Fail closed with an empty CSRF token. */
            }
            this.base =
                config.portalBase === '/agent-portal'
                    ? '/agent-portal'
                    : '/client';
            this.csrf = config.csrf || '';
            this.innerHTML = `<div class="wh-notice" data-notice role="status" aria-live="polite" hidden></div>
                <div class="wh-layout"><section class="wh-panel" aria-labelledby="wh-endpoints-title"><div class="wh-section-head"><h2 id="wh-endpoints-title">نقاط الاتصال <span class="wh-count" data-count>0</span></h2></div><div class="wh-endpoints" data-endpoints><div class="wh-skeleton" aria-label="تحميل الروابط"></div></div></section>
                <section class="wh-panel" aria-labelledby="wh-history-title"><div class="wh-section-head"><h2 id="wh-history-title">سجل الإرسال</h2><button type="button" class="wh-icon-button" data-action="refresh" aria-label="تحديث سجل الإرسال">${icon('refresh')}</button></div><div class="wh-filters" aria-label="تصفية سجل الإرسال">${[
                    ['all', 'الكل'],
                    ['delivered', 'ناجح'],
                    ['failed', 'فاشل'],
                ]
                    .map(
                        ([value, label]) =>
                            `<button class="wh-filter" type="button" data-action="filter" data-filter="${value}" aria-pressed="${value === this.filter}">${label}</button>`,
                    )
                    .join(
                        '',
                    )}</div><div data-history><div class="wh-skeleton" aria-label="تحميل السجل"></div></div></section></div>
                <dialog class="wh-dialog" aria-labelledby="wh-dialog-title"></dialog>`;
            this.dialog = this.querySelector('dialog');
            this.dialog.addEventListener('close', () => {
                this.dialog.innerHTML = '';
                if (this.returnFocus?.isConnected) this.returnFocus.focus();
                else this.createButton?.focus();
            });
            this.dialog.addEventListener('cancel', (event) => {
                if (this.busy) event.preventDefault();
            });
            this.addEventListener('click', this.onClick);
            this.addEventListener('submit', this.onSubmit);
            document.addEventListener('click', this.onOutside);
            document.addEventListener('keydown', this.onKey);
            this.createButton = document.querySelector('[data-wh-create]');
            this.createButton?.addEventListener('click', this.onCreate);
            this.load();
        }
        disconnectedCallback() {
            document.removeEventListener('click', this.onOutside);
            document.removeEventListener('keydown', this.onKey);
            this.createButton?.removeEventListener('click', this.onCreate);
        }
        async api(suffix = '', options = {}) {
            const method = options.method || 'GET';
            const headers = new Headers({ Accept: 'application/json' });
            if (method !== 'GET') {
                headers.set('Content-Type', 'application/json');
                headers.set('x-csrf-token', this.csrf);
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            try {
                const response = await fetch(this.base + '/api/' + suffix, {
                    ...options,
                    method,
                    headers,
                    credentials: 'same-origin',
                    cache: 'no-store',
                    signal: controller.signal,
                });
                if (response.status === 401 || response.redirected)
                    throw new Error('SESSION_EXPIRED');
                if (response.status === 429) throw new Error('RATE_LIMITED');
                const body = await response.json();
                if (!response.ok || body.success !== true)
                    throw new Error(body.error || 'REQUEST_FAILED');
                return body;
            } catch (error) {
                if (error.name === 'AbortError')
                    throw new Error('REQUEST_TIMEOUT');
                throw error;
            } finally {
                clearTimeout(timer);
            }
        }
        syncBusy() {
            if (this.createButton)
                this.createButton.disabled = this.loading || this.busy;
            this.querySelectorAll(
                '[data-mutate], [data-save], [data-action="close"]',
            ).forEach((button) => {
                button.disabled =
                    this.busy || button.dataset.unavailable === 'true';
            });
            const refresh = this.querySelector('[data-action="refresh"]');
            if (refresh) refresh.disabled = this.loading || this.busy;
            this.setAttribute('aria-busy', String(this.loading));
        }
        async load() {
            if (this.loading) return;
            this.loading = true;
            this.syncBusy();
            try {
                const data = await this.api('webhooks');
                if (
                    !Array.isArray(data.endpoints) ||
                    !Array.isArray(data.deliveries)
                )
                    throw new Error('INVALID_RESPONSE');
                this.data = data;
                this.loaded = true;
                this.renderPanels();
                return true;
            } catch (error) {
                this.notice(errorText(error), 'danger');
                if (!this.loaded) this.renderUnavailable();
                return false;
            } finally {
                this.loading = false;
                this.syncBusy();
            }
        }
        notice(text, tone = 'success') {
            const box = this.querySelector('[data-notice]');
            box.hidden = false;
            box.className = 'wh-notice wh-' + tone;
            box.innerHTML = `<span>${escapeHtml(text)}</span><button type="button" class="wh-icon-button" data-action="dismiss" aria-label="إغلاق التنبيه">${icon('close')}</button>`;
        }
        reportError(error) {
            const field =
                this.dialog.open &&
                this.dialog.querySelector('[data-dialog-error]');
            if (field) {
                field.textContent = errorText(error);
                field.hidden = false;
            } else this.notice(errorText(error), 'danger');
        }
        empty(title, caption, name = 'link') {
            return `<div class="wh-empty">${icon(name)}<strong>${escapeHtml(title)}</strong><p>${escapeHtml(caption)}</p></div>`;
        }
        renderUnavailable() {
            this.querySelector('[data-endpoints]').innerHTML = this.empty(
                'تعذر عرض الروابط',
                'استخدم زر التحديث للمحاولة مجددًا.',
            );
            this.querySelector('[data-history]').innerHTML = this.empty(
                'السجل غير متاح حاليًا',
                'ستبقى بيانات حسابك محفوظة.',
                'history',
            );
        }
        badge(status) {
            const label = deliveryLabel(status);
            return `<span class="wh-badge wh-${label.tone}">${label.text}</span>`;
        }
        endpoint(id) {
            return this.data.endpoints.find(
                (endpoint) => String(endpoint.id) === String(id),
            );
        }
        delivery(id) {
            return this.data.deliveries.find(
                (delivery) => String(delivery._id) === String(id),
            );
        }
        renderPanels() {
            this.querySelector('[data-count]').textContent =
                this.data.endpoints.length;
            this.querySelector('[data-endpoints]').innerHTML =
                this.data.endpoints
                    .map((endpoint) => {
                        const id = escapeHtml(endpoint.id);
                        const label = escapeHtml(endpoint.name);
                        const recent = this.data.deliveries.find(
                            (delivery) =>
                                String(delivery.endpointId) ===
                                String(endpoint.id),
                        );
                        const last = recent
                            ? deliveryLabel(recent.status).text
                            : endpoint.lastAttemptAt
                              ? endpoint.failureCount
                                  ? 'فشل'
                                  : 'ناجح'
                              : 'لا يوجد إرسال بعد';
                        return `<article class="wh-endpoint"><div class="wh-endpoint-top"><div class="wh-endpoint-name"><strong>${label}</strong><span class="wh-badge ${endpoint.enabled ? 'wh-success' : 'wh-muted'}">${endpoint.enabled ? 'مفعّل' : 'متوقف'}</span></div>
                <details class="wh-menu"><summary class="wh-icon-button" aria-label="إجراءات ${label}">${icon('more')}</summary><div class="wh-menu-items">
                <button type="button" data-action="edit" data-id="${id}" data-mutate>${icon('edit')} تعديل</button>
                <button type="button" data-action="test" data-id="${id}" data-mutate data-unavailable="${!endpoint.enabled}" ${endpoint.enabled ? '' : 'disabled'}>${icon('play')} اختبار الاتصال</button>
                <button type="button" data-action="signing" data-id="${id}" data-mutate>${icon('shield')} مفتاح التوقيع</button>
                <button type="button" data-action="toggle" data-id="${id}" data-mutate>${icon(endpoint.enabled ? 'pause' : 'play')} ${endpoint.enabled ? 'إيقاف الرابط' : 'تفعيل الرابط'}</button>
                <button type="button" class="wh-delete" data-action="delete" data-id="${id}" data-mutate>${icon('trash')} حذف الرابط</button></div></details></div>
                <div class="wh-url-row"><span class="wh-url" title="${escapeHtml(endpoint.url)}">${escapeHtml(endpoint.url)}</span><button type="button" class="wh-icon-button wh-copy" data-action="copy-url" data-id="${id}" aria-label="نسخ رابط ${label}">${icon('copy')}</button></div>
                <div class="wh-endpoint-meta">${(endpoint.events || []).map((event) => `<span>${eventLabel(event)}</span>`).join('<span aria-hidden="true">·</span>')}</div><p class="wh-endpoint-last">آخر إرسال: ${last}${endpoint.lastAttemptAt ? ' · ' + escapeHtml(time(endpoint.lastAttemptAt)) : ''}</p></article>`;
                    })
                    .join('') ||
                this.empty(
                    'لا توجد روابط بعد',
                    'أضف رابط نظامك لتصله تحديثات العمليات.',
                );
            this.renderHistory();
            this.syncBusy();
        }
        renderHistory() {
            this.querySelectorAll('[data-filter]').forEach((button) =>
                button.setAttribute(
                    'aria-pressed',
                    String(button.dataset.filter === this.filter),
                ),
            );
            const rows = filterDeliveries(this.data.deliveries, this.filter);
            this.querySelector('[data-history]').innerHTML = rows.length
                ? `<table class="wh-table"><thead><tr><th scope="col">الحدث / الرابط</th><th scope="col">الحالة</th><th scope="col">الوقت</th><th scope="col">التفاصيل</th></tr></thead><tbody>${rows
                      .slice(0, this.limit)
                      .map(
                          (delivery) =>
                              `<tr><td><div class="wh-event">${eventLabel(delivery.eventType)}</div><div class="wh-endpoint-label">${escapeHtml(this.endpoint(delivery.endpointId)?.name || 'رابط Webhook')}</div></td><td>${this.badge(delivery.status)}</td><td class="wh-time">${escapeHtml(time(delivery.createdAt))}</td><td><button class="wh-details-button" type="button" data-action="details" data-id="${escapeHtml(delivery._id)}" aria-label="تفاصيل محاولة ${escapeHtml(delivery.eventId || delivery._id)}">تفاصيل</button></td></tr>`,
                      )
                      .join(
                          '',
                      )}</tbody></table>${rows.length > this.limit ? `<button type="button" class="wh-button wh-more" data-action="more">عرض المزيد (${rows.length - this.limit})</button>` : ''}`
                : this.empty(
                      this.filter === 'all'
                          ? 'لا توجد محاولات إرسال بعد'
                          : 'لا توجد نتائج لهذا الفلتر',
                      this.filter === 'all'
                          ? 'ستظهر هنا حالة تسليم الأحداث.'
                          : 'اختر «الكل» لعرض بقية المحاولات.',
                      'history',
                  );
        }
        closeMenus() {
            this.querySelectorAll('.wh-menu[open]').forEach((menu) => {
                menu.open = false;
            });
        }
        showDialog(title, content, footer, form = false) {
            if (!this.dialog.open) this.returnFocus = document.activeElement;
            this.dialog.innerHTML = `<div class="wh-dialog-head"><h2 id="wh-dialog-title">${escapeHtml(title)}</h2><button class="wh-icon-button" type="button" data-action="close" aria-label="إغلاق النافذة">${icon('close')}</button></div>${form ? '<form data-editor>' : '<div>'}<div class="wh-dialog-content">${content}</div><p class="wh-dialog-error" data-dialog-error role="alert" hidden></p><div class="wh-dialog-footer">${footer}</div>${form ? '</form>' : '</div>'}`;
            if (!this.dialog.open) this.dialog.showModal();
            (
                this.dialog.querySelector(
                    'input:not([type=checkbox]), textarea',
                ) || this.dialog.querySelector('[data-action="close"]')
            )?.focus();
        }
        openEditor(endpoint) {
            if (this.busy) return;
            const selected = endpoint?.events || EVENTS;
            this.showDialog(
                endpoint ? 'تعديل الرابط' : 'إضافة رابط',
                `<label class="wh-field">الاسم<input class="wh-input" name="name" required maxlength="100" autocomplete="off" placeholder="نظام المحاسبة" value="${escapeHtml(endpoint?.name || '')}"></label><label class="wh-field">رابط HTTPS<input class="wh-input" name="url" type="url" dir="ltr" required maxlength="2048" autocomplete="off" placeholder="https://example.com/webhooks/ahrampay" value="${escapeHtml(endpoint?.url || '')}"></label><fieldset class="wh-fieldset"><legend>الأحداث</legend>${EVENTS.map((event) => `<label class="wh-check"><input type="checkbox" name="events" value="${event}" ${selected.includes(event) ? 'checked' : ''}><span>${eventLabel(event)}</span></label>`).join('')}</fieldset>`,
                '<button class="wh-button" type="button" data-action="close">إلغاء</button><button class="wh-button wh-primary" type="submit" data-save>حفظ الرابط</button>',
                true,
            );
            this.dialog.querySelector('form').dataset.id = endpoint?.id || '';
        }
        async saveEditor(form) {
            if (this.busy) return;
            let payload;
            try {
                const data = new FormData(form);
                payload = validateInput({
                    name: data.get('name'),
                    url: data.get('url'),
                    events: data.getAll('events'),
                });
            } catch (error) {
                this.reportError(error);
                return;
            }
            const id = form.dataset.id;
            await this.mutate(async () => {
                const result = await this.api(
                    'webhooks' + (id ? '/' + encodeURIComponent(id) : ''),
                    {
                        method: id ? 'PATCH' : 'POST',
                        body: JSON.stringify(payload),
                    },
                );
                if (result.secret) this.showSecret(result.secret);
                else this.dialog.close();
                const refreshed = await this.load();
                this.notice(
                    refreshed
                        ? id
                            ? 'تم حفظ تعديلات الرابط.'
                            : 'تمت إضافة الرابط. احفظ مفتاح التوقيع.'
                        : 'تم حفظ الرابط، لكن تعذر تحديث القائمة. حدّث الحالة قبل إعادة الإجراء.',
                    refreshed ? 'success' : 'warning',
                );
            });
        }
        showSecret(secret) {
            if (typeof secret !== 'string' || !secret)
                throw new Error('SECRET_NOT_RETURNED');
            this.showDialog(
                'مفتاح التوقيع الجديد',
                `<p class="wh-helper">احفظه الآن في نظامك؛ لن يظهر مجددًا بعد إغلاق النافذة. يُستخدم للتحقق من توقيع الأحداث.</p><label class="wh-field">مفتاح HMAC<textarea class="wh-input wh-secret" data-copy-value readonly dir="ltr" spellcheck="false">${escapeHtml(secret)}</textarea></label>`,
                '<button class="wh-button" type="button" data-action="close">تم الحفظ</button><button class="wh-button wh-primary" type="button" data-action="copy-value">نسخ المفتاح</button>',
            );
        }
        openSigning(endpoint) {
            this.showDialog(
                'مفتاح التوقيع',
                `<p class="wh-helper">آخر أحرف المفتاح الحالي: <bdi>…${escapeHtml(endpoint.secretHint || '—')}</bdi></p><p class="wh-helper">استبدال المفتاح يوقف التوقيع بالمفتاح السابق فورًا. حدّث نظامك بالمفتاح الجديد بعد الاستبدال.</p>`,
                `<button class="wh-button" type="button" data-action="close">رجوع</button><button class="wh-button wh-danger-button" type="button" data-action="rotate" data-id="${escapeHtml(endpoint.id)}" data-mutate>استبدال المفتاح</button>`,
            );
        }
        showDetails(delivery) {
            const endpoint = this.endpoint(delivery.endpointId);
            this.showDialog(
                'تفاصيل محاولة الإرسال',
                `<dl class="wh-facts"><div><dt>الرابط</dt><dd>${escapeHtml(endpoint?.name || 'Webhook')}</dd></div><div><dt>الحالة</dt><dd>${this.badge(delivery.status)}</dd></div><div><dt>الحدث</dt><dd>${eventLabel(delivery.eventType)}</dd></div><div><dt>HTTP</dt><dd>${escapeHtml(delivery.responseCode || '—')}</dd></div><div><dt>عدد المحاولات</dt><dd>${escapeHtml(delivery.attemptCount || 0)}</dd></div><div><dt>الوقت</dt><dd>${escapeHtml(time(delivery.lastAttemptAt || delivery.createdAt))}</dd></div>${delivery.nextAttemptAt && delivery.status !== 'delivered' ? `<div class="wh-full"><dt>الموعد المجدول للمحاولة التالية</dt><dd>${escapeHtml(time(delivery.nextAttemptAt))}</dd></div>` : ''}${delivery.lastError ? `<div class="wh-full"><dt>سبب الفشل</dt><dd>${escapeHtml(delivery.lastError)}</dd></div>` : ''}</dl>${delivery.responsePreview ? `<details class="wh-response"><summary>استجابة الجهة المستقبلة</summary><pre class="wh-response-text" dir="auto">${escapeHtml(delivery.responsePreview)}</pre></details>` : ''}`,
                `<button class="wh-button" type="button" data-action="close">إغلاق</button>${canRetry(delivery) && endpoint?.enabled ? `<button class="wh-button wh-primary" type="button" data-action="retry" data-id="${escapeHtml(delivery._id)}" data-mutate>إعادة المحاولة</button>` : ''}`,
            );
        }
        async copy(value, secret = false) {
            try {
                if (!navigator.clipboard?.writeText)
                    throw new Error('CLIPBOARD_UNAVAILABLE');
                await navigator.clipboard.writeText(value);
                if (this.dialog.open) {
                    const box = this.dialog.querySelector(
                        '[data-dialog-error]',
                    );
                    box.className = 'wh-dialog-error wh-success';
                    box.textContent = 'تم النسخ.';
                    box.hidden = false;
                } else this.notice('تم نسخ الرابط.');
            } catch {
                if (secret) {
                    this.dialog.querySelector('[data-copy-value]')?.select();
                    const box = this.dialog.querySelector(
                        '[data-dialog-error]',
                    );
                    box.textContent = 'حدد النص وانسخه يدويًا.';
                    box.hidden = false;
                } else
                    this.showDialog(
                        'نسخ الرابط',
                        `<label class="wh-field">الرابط<input class="wh-input" dir="ltr" readonly data-copy-value value="${escapeHtml(value)}"></label><p class="wh-helper">يمكنك تحديد الرابط ونسخه يدويًا.</p>`,
                        '<button class="wh-button" type="button" data-action="close">إغلاق</button>',
                    );
            }
        }
        async mutate(task) {
            if (this.busy) return;
            this.busy = true;
            this.syncBusy();
            try {
                await task();
            } catch (error) {
                this.reportError(error);
            } finally {
                this.busy = false;
                this.syncBusy();
            }
        }
        deliveryNotice(result) {
            if (result?.delivered) this.notice('تم تسليم الحدث بنجاح.');
            else if (result?.skipped)
                this.notice(
                    'الإرسال متوقف من الخادم حاليًا. راجع الإدارة.',
                    'info',
                );
            else
                this.notice(
                    'لم يتم تأكيد التسليم. راجع تفاصيل المحاولة في السجل.',
                    'warning',
                );
        }
        async handleClick(event) {
            const button = event.target.closest?.('[data-action]');
            if (!button || !this.contains(button) || button.disabled) return;
            const { action, id } = button.dataset;
            const endpoint = this.endpoint(id);
            if (action !== 'filter') this.closeMenus();
            if (action === 'refresh') return this.load();
            if (action === 'dismiss') {
                this.querySelector('[data-notice]').hidden = true;
                return;
            }
            if (action === 'close') {
                if (!this.busy) this.dialog.close();
                return;
            }
            if (action === 'filter') {
                this.filter = button.dataset.filter;
                this.limit = 8;
                this.renderHistory();
                return;
            }
            if (action === 'more') {
                this.limit += 10;
                this.renderHistory();
                return;
            }
            if (action === 'edit' && endpoint) return this.openEditor(endpoint);
            if (action === 'copy-url' && endpoint)
                return this.copy(endpoint.url);
            if (action === 'copy-value')
                return this.copy(
                    this.dialog.querySelector('[data-copy-value]')?.value || '',
                    true,
                );
            if (action === 'signing' && endpoint)
                return this.openSigning(endpoint);
            if (action === 'details') {
                const delivery = this.delivery(id);
                if (delivery) this.showDetails(delivery);
                return;
            }
            if (action === 'delete' && endpoint)
                return this.showDialog(
                    'حذف الرابط',
                    `<p class="wh-helper">سيُحذف رابط «${escapeHtml(endpoint.name)}» وسجل محاولاته نهائيًا. يمكنك إيقاف الرابط بدلًا من حذفه.</p>`,
                    `<button type="button" class="wh-button" data-action="close">إلغاء</button><button type="button" class="wh-button wh-danger-button" data-action="confirm-delete" data-id="${escapeHtml(id)}" data-mutate>حذف نهائي</button>`,
                );
            if (action === 'toggle' && endpoint)
                return this.mutate(async () => {
                    await this.api('webhooks/' + encodeURIComponent(id), {
                        method: 'PATCH',
                        body: JSON.stringify({ enabled: !endpoint.enabled }),
                    });
                    await this.load();
                    this.notice(
                        endpoint.enabled
                            ? 'تم إيقاف الرابط.'
                            : 'تم تفعيل الرابط.',
                    );
                });
            if (action === 'rotate' && endpoint)
                return this.mutate(async () => {
                    const result = await this.api(
                        'webhooks/' + encodeURIComponent(id),
                        {
                            method: 'PATCH',
                            body: JSON.stringify({ rotateSecret: true }),
                        },
                    );
                    this.showSecret(result.secret);
                    await this.load();
                });
            if (action === 'test' && endpoint?.enabled)
                return this.mutate(async () => {
                    const result = await this.api(
                        'webhooks/' + encodeURIComponent(id) + '/test',
                        { method: 'POST', body: '{}' },
                    );
                    await this.load();
                    this.deliveryNotice(result.result);
                });
            if (action === 'confirm-delete' && endpoint)
                return this.mutate(async () => {
                    await this.api('webhooks/' + encodeURIComponent(id), {
                        method: 'DELETE',
                    });
                    this.dialog.close();
                    await this.load();
                    this.notice('تم حذف الرابط وسجله.');
                });
            if (action === 'retry' && canRetry(this.delivery(id)))
                return this.mutate(async () => {
                    const result = await this.api(
                        'webhook-deliveries/' +
                            encodeURIComponent(id) +
                            '/retry',
                        { method: 'POST', body: '{}' },
                    );
                    this.dialog.close();
                    await this.load();
                    this.deliveryNotice(result.result);
                });
        }
    }
    if (!customElements.get('merchant-webhooks'))
        customElements.define('merchant-webhooks', MerchantWebhooks);
})();
