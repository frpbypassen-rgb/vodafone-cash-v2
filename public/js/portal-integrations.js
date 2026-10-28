(() => {
    'use strict';
    const root = document.querySelector('[data-merchant-integrations]');
    if (!root) return;
    const get = (name) => root.querySelector('[data-mi-' + name + ']');
    const active = () => {
        const panel = root.closest('.bw-settings-panel');
        return (
            !document.hidden &&
            (!panel || window.location.hash === '#' + panel.id)
        );
    };
    const labels = {
        IP_NOT_ALLOWED: 'طلب مرفوض بسبب IP',
        WEBHOOK_DELIVERY_FAILED: 'فشل تسليم Webhook',
        WEBHOOK_ADMIN_DISABLED: 'أوقفت الإدارة تسليم Webhooks',
        IDEMPOTENCY_CONFLICT: 'مفتاح منع تكرار مستخدم لطلب مختلف',
        IDEMPOTENCY_IN_PROGRESS: 'طلب مكرر ما زال قيد التحقق',
        FINANCIAL_TRANSACTIONS_UNAVAILABLE: 'المعاملات المالية غير جاهزة',
        IDEMPOTENCY_INDEX_UNAVAILABLE: 'فهرس منع تكرار التحويل غير جاهز',
    };
    const operation = {
        balance: 'الرصيد',
        transfer: 'إنشاء تحويل',
        status: 'حالة تحويل',
        webhook: 'Webhooks',
    };
    const date = (value) =>
        value && Number.isFinite(new Date(value).getTime())
            ? new Date(value).toLocaleString('ar-LY', {
                  timeZone: 'Africa/Tripoli',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
              })
            : 'لم يُسجّل بعد';
    let data = null,
        loading = false,
        timer,
        controller,
        lastAttempt = 0,
        delay = 30000;
    const node = (tag, text) => {
        const element = document.createElement(tag);
        element.textContent = text;
        return element;
    };
    const badge = (name, label, state) => {
        const element = get(name);
        element.textContent = label;
        element.className =
            'mi-badge' +
            (['ready', 'error'].includes(state)
                ? ' is-' + state
                : ['stopped', 'incomplete', 'available'].includes(state)
                  ? ' is-warning'
                  : '');
    };
    const link = (name, allowed, reason) => {
        get(name + '-link').setAttribute('aria-disabled', String(!allowed));
        get(name + '-reason').textContent = reason || '';
    };
    for (const name of ['api', 'webhook'])
        get(name + '-link').addEventListener('click', (event) => {
            if (get(name + '-link').getAttribute('aria-disabled') === 'true')
                event.preventDefault();
        });
    const render = () => {
        root.removeAttribute('data-stale');
        get('notice').hidden = true;
        badge('api-state', data.api.label, data.api.state);
        badge('webhook-state', data.webhooks.label, data.webhooks.state);
        get('key-meta').textContent = data.access.keyActive
            ? 'نشط' + (data.access.keyHint ? ' · …' + data.access.keyHint : '')
            : 'غير نشط';
        get('ip-state').textContent = data.access.ipAllowlistEnabled
            ? 'مفعّلة · ' + data.access.allowedIps.length + ' عنوان'
            : 'غير مفعّلة';
        get('api-description').textContent =
            data.api.reason ||
            (!data.access.apiEnabled
                ? 'تحتاج الخدمة إلى تفعيل من الإدارة.'
                : !data.access.keyActive
                  ? 'أنشئ توكنًا لإكمال الربط.'
                  : data.access.ipAllowlistEnabled && !data.api.proxyReady
                    ? 'يلزم ضبط البروكسي الموثوق للقائمة البيضاء.'
                    : 'التوكن مطلوب لكل طلب. إعادة الطلب بمفتاح Idempotency-Key تحفظ نتيجته.');
        get('webhook-count').textContent =
            data.webhooks.enabled + ' مفعّل / ' + data.webhooks.total;
        get('webhook-success').textContent = date(data.webhooks.lastSuccessAt);
        get('webhook-failure').textContent = date(data.webhooks.lastFailureAt);
        const queue=data.webhooks.queue;
        get('queue-pending').textContent=queue?.available?`${queue.pendingEvents} حدث · ${queue.pendingDeliveries} إرسال`:'غير متاح';
        get('queue-age').textContent=queue?.available?(queue.oldestAgeSeconds?`${queue.oldestAgeSeconds} ثانية`:'لا انتظار'):'تعذر التحقق';
        get('webhook-description').textContent = data.webhooks.reason;
        link(
            'api',
            data.access.apiEnabled,
            data.access.apiEnabled ? '' : 'غير متاح: الخدمة موقوفة من الإدارة.',
        );
        link(
            'webhook',
            data.access.webhooksEnabled,
            data.access.webhooksEnabled
                ? ''
                : 'غير متاح: الخدمة موقوفة من الإدارة.',
        );
        get('last-check').textContent =
            'آخر تحقق ناجح: ' + date(data.checkedAt);
        get('check-list').replaceChildren(
            ...data.checks.map((check) => {
                const li = node('li', '');
                li.append(
                    node('strong', (check.ok ? '✓ ' : '! ') + check.label),
                    node('span', check.message),
                );
                return li;
            }),
        );
        get('events').replaceChildren(
            ...(data.eventsAvailable
                ? data.events.length
                    ? data.events.map((event) => {
                          const li = node('li', '');
                          li.append(
                              node(
                                  'strong',
                                  labels[event.code] || 'خطأ في الربط',
                              ),
                              node(
                                  'span',
                                  [
                                      operation[event.operation] || '',
                                      date(event.lastSeenAt),
                                      event.httpStatus
                                          ? 'HTTP ' + event.httpStatus
                                          : '',
                                      event.sourceIp
                                          ? 'IP ' + event.sourceIp
                                          : '',
                                      'تكرار: ' + event.count,
                                  ]
                                      .filter(Boolean)
                                      .join(' · '),
                              ),
                          );
                          return li;
                      })
                    : [node('li', 'لا توجد أخطاء مسجلة خلال آخر 7 أيام.')]
                : [
                      node(
                          'li',
                          'السجل غير متاح حاليًا؛ لا يؤثر ذلك على صلاحية التوكن.',
                      ),
                  ]),
        );
    };
    const stale = (message, clear = false) => {
        if (clear) {
            data = null;
            for (const key of [
                'key-meta',
                'ip-state',
                'webhook-count',
                'webhook-success',
                'webhook-failure',
                'queue-pending',
                'queue-age',
            ])
                get(key).textContent = '—';
            get('events').replaceChildren(
                node('li', 'سجّل الدخول لعرض السجل.'),
            );
            get('check-list').replaceChildren();
        }
        root.setAttribute('data-stale', 'true');
        badge('api-state', 'تعذر التحقق', 'error');
        badge('webhook-state', 'تعذر التحقق', 'error');
        link('api', false, 'معطّل مؤقتًا: يلزم التحقق من الحالة أولًا.');
        link('webhook', false, 'معطّل مؤقتًا: يلزم التحقق من الحالة أولًا.');
        get('api-description').textContent = 'لا يمكن تأكيد الحالة الحالية.';
        get('webhook-description').textContent =
            'لا يمكن تأكيد جاهزية التسليم.';
        get('notice').hidden = false;
        get('notice').className = 'mi-notice is-error';
        get('notice').textContent =
            message + (data ? ' البيانات المعروضة أدناه سابقة.' : '');
        get('last-check').textContent = data
            ? 'آخر تحقق ناجح: ' + date(data.checkedAt)
            : 'لم يكتمل تحقق ناجح بعد.';
    };
    const schedule = () => {
        clearTimeout(timer);
        if (active()) timer = setTimeout(() => load(), delay);
    };
    const load = async ({ force = false, showChecks = false } = {}) => {
        if (
            loading ||
            !active() ||
            (!force && Date.now() - lastAttempt < 10000)
        )
            return;
        loading = true;
        lastAttempt = Date.now();
        get('refresh').disabled = true;
        get('check').disabled = true;
        get('result').textContent = showChecks ? 'جارٍ فحص الإعدادات…' : '';
        controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch(
                root.dataset.base + '/api/integrations/overview',
                {
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                    signal: controller.signal,
                },
            );
            if (response.redirected || [401, 403].includes(response.status))
                throw Object.assign(
                    new Error(
                        'انتهت الجلسة أو لم تعد تملك صلاحية إدارة التكاملات.',
                    ),
                    { clear: true },
                );
            if (
                !response.headers
                    .get('content-type')
                    ?.includes('application/json')
            )
                throw new Error('تعذر التحقق من الحالة. أعد المحاولة.');
            const payload = await response.json();
            if (
                !response.ok ||
                payload.success !== true ||
                !payload.data?.readOnly ||
                !Array.isArray(payload.data.checks) ||
                !Array.isArray(payload.data.events)
            )
                throw new Error('تعذر التحقق من الحالة. أعد المحاولة.');
            data = payload.data;
            render();
            delay = 30000;
            get('result').textContent = showChecks
                ? 'اكتمل فحص الإعدادات دون إنشاء تحويل أو إرسال إشعار.'
                : '';
            if (showChecks) get('checks').open = true;
        } catch (error) {
            delay = Math.min(delay * 2, 120000);
            if (active()) {
                stale(
                    error.clear
                        ? error.message
                        : error.name === 'AbortError'
                          ? 'انتهت مهلة التحقق. أعد المحاولة.'
                          : 'تعذر التحقق من الحالة. أعد المحاولة.',
                    error.clear,
                );
                get('result').textContent = '';
            }
        } finally {
            clearTimeout(timeout);
            loading = false;
            controller = null;
            get('refresh').disabled = false;
            get('check').disabled = false;
            schedule();
        }
    };
    get('refresh').addEventListener('click', () => load({ force: true }));
    get('check').addEventListener('click', () =>
        load({ force: true, showChecks: true }),
    );
    const activate = () => {
        if (active()) load();
        else {
            clearTimeout(timer);
            controller?.abort();
        }
    };
    window.addEventListener('hashchange', activate);
    window.addEventListener('focus', activate);
    document.addEventListener('visibilitychange', activate);
    window.addEventListener('pagehide', () => {
        clearTimeout(timer);
        controller?.abort();
    });
    activate();
})();
