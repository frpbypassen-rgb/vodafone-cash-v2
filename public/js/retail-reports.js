(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.mount(root);
})(typeof window === 'undefined' ? this : window, function () {
    'use strict';
    const keys = ['dateType', 'dateValue', 'dateFrom', 'dateTo', 'search', 'status', 'service'];
    const todayKey = (now = new Date()) => {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Africa/Tripoli',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(now);
        const get = (key) => parts.find((p) => p.type === key).value;
        return get('year') + '-' + get('month') + '-' + get('day');
    };
    const readState = (search, stored, now = new Date()) => {
        const params = new URLSearchParams(search),
            explicit = keys.some((key) => params.has(key));
        let input = {};
        if (explicit) for (const key of keys) input[key] = params.get(key) || '';
        else
            try {
                input = JSON.parse(stored || '{}') || {};
            } catch (_) {}
        const dateType = ['day', 'month', 'range'].includes(input.dateType) ? input.dateType : 'month',
            today = todayKey(now);
        return {
            dateType,
            dateValue:
                dateType === 'range'
                    ? ''
                    : String(input.dateValue || (dateType === 'day' ? today : today.slice(0, 7))),
            dateFrom: dateType === 'range' ? String(input.dateFrom || today) : '',
            dateTo: dateType === 'range' ? String(input.dateTo || today) : '',
            search: String(input.search || '').slice(0, 80),
            status: String(input.status || ''),
            service: String(input.service || ''),
        };
    };
    const toQuery = (state) => {
        const params = new URLSearchParams();
        for (const key of keys) if (state[key]) params.set(key, state[key]);
        return params;
    };
    const mount = (window) => {
        const document = window.document,
            page = document.querySelector('[data-retail-reports]');
        if (!page) return;
        const find = (selector) => page.querySelector(selector),
            filterDialog = document.querySelector('[data-rr-dialog]'),
            filterForm = filterDialog.querySelector('[data-rr-filter-form]'),
            searchForm = find('[data-rr-search-form]');
        let stored = '';
        try {
            stored = window.sessionStorage.getItem(page.dataset.reportStorage) || '';
        } catch (_) {}
        let state = readState(window.location.search, stored),
            controller,
            generation = 0,
            nextCursor = null,
            asOf = null,
            shown = 0,
            busy = false,
            saveWarning = '';
        const money = (value, currency = 'LYD', digits = 2) =>
            Number(value || 0).toLocaleString('en-US', {
                minimumFractionDigits: digits,
                maximumFractionDigits: digits,
            }) +
            ' ' +
            currency;
        const date = (value) =>
            new Date(value).toLocaleString('ar-LY', {
                timeZone: 'Africa/Tripoli',
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            });
        const node = (parent, tag, text, className) => {
            const el = document.createElement(tag);
            if (text !== undefined) el.textContent = text;
            if (className) el.className = className;
            parent.append(el);
            return el;
        };
        const message = (text) => {
            find('[data-rr-message]').textContent = text;
        };
        const persist = () => {
            try {
                window.sessionStorage.setItem(page.dataset.reportStorage, JSON.stringify(state));
            } catch (_) {
                saveWarning = 'تعذر حفظ الاختيارات في جلسة المتصفح؛ يحتفظ الرابط الحالي بها.';
            }
            const url = new window.URL(window.location.href);
            for (const key of [...keys, 'cursor']) url.searchParams.delete(key);
            url.searchParams.set('tab', 'operations');
            for (const [key, value] of toQuery(state)) url.searchParams.set(key, value);
            window.history.replaceState(null, '', url);
        };
        const renderFilters = () => {
            searchForm.elements.search.value = state.search;
            page.querySelectorAll('[data-rr-period]').forEach((button) => {
                button.setAttribute('aria-pressed', String(button.dataset.rrPeriod === state.dateType));
                if (button.dataset.rrPeriod === 'month')
                    button.textContent =
                        state.dateType === 'month' && state.dateValue !== todayKey().slice(0, 7)
                            ? 'شهر محدد'
                            : 'هذا الشهر';
                if (button.dataset.rrPeriod === 'day')
                    button.textContent =
                        state.dateType === 'day' && state.dateValue !== todayKey() ? 'يوم محدد' : 'اليوم';
            });
            find('[data-rr-period-label]').textContent =
                state.dateType === 'range' ? state.dateFrom + ' — ' + state.dateTo : state.dateValue;
            const chips = find('[data-rr-chips]');
            chips.replaceChildren();
            const labels = {
                search: 'بحث: ' + state.search,
                status:
                    filterForm.elements.status.querySelector(
                        `option[value="${['pending', 'processing', 'accepted', 'completed', 'rejected', 'cancelled_by_admin'].includes(state.status) ? state.status : ''}"]`
                    )?.textContent || state.status,
                service:
                    [...filterForm.elements.service.options].find((option) => option.value === state.service)
                        ?.textContent || state.service,
            };
            for (const key of ['search', 'status', 'service'])
                if (state[key]) {
                    const button = node(chips, 'button', labels[key] + ' ×', 'rr-chip');
                    button.type = 'button';
                    button.setAttribute('aria-label', 'إزالة ' + labels[key]);
                    button.addEventListener('click', () => {
                        state[key] = '';
                        apply();
                    });
                }
            const count = Number(Boolean(state.status)) + Number(Boolean(state.service));
            find('[data-rr-filter-count]').textContent = count ? String(count) : '';
            if (state.search || state.status || state.service) {
                const reset = node(chips, 'button', 'مسح الفلاتر', 'rr-clear');
                reset.type = 'button';
                reset.addEventListener('click', resetFilters);
            }
        };
        const summary = (data) => {
            find('[data-rr-summary]').hidden = false;
            find('[data-rr-count]').textContent = data.count.toLocaleString('en-US');
            const amounts = find('[data-rr-amounts]');
            amounts.replaceChildren();
            if (!data.amounts.length) node(amounts, 'span', 'لا توجد عمليات');
            else data.amounts.forEach((item) => node(amounts, 'bdi', money(item.amount, item.currency)));
            find('[data-rr-cost]').textContent = money(data.completedCostLYD, 'LYD', 3);
        };
        const status = (parent, tx) => {
            const badge = node(parent, 'span', tx.statusLabel, 'rr-status');
            badge.dataset.tone = tx.tone;
        };
        const appendRows = (rows) => {
            const mobile = find('[data-rr-mobile]'),
                table = find('[data-rr-table]');
            if (!rows.length && !shown) {
                node(mobile, 'p', 'لا توجد عمليات مطابقة لهذه الفترة والفلاتر.', 'rr-empty');
                const row = node(table, 'tr');
                const cell = node(row, 'td', 'لا توجد عمليات مطابقة.', 'rr-empty');
                cell.colSpan = 7;
            }
            rows.forEach((tx) => {
                const card = node(mobile, 'button', undefined, 'rr-card');
                card.type = 'button';
                card.dataset.homeTransaction = tx.id;
                card.setAttribute('aria-label', 'تفاصيل العملية ' + tx.reference);
                const head = node(card, 'span', undefined, 'rr-card-head');
                node(head, 'strong', tx.service);
                status(head, tx);
                const body = node(card, 'span', undefined, 'rr-card-main');
                const recipient = node(body, 'span', undefined, 'rr-recipient');
                node(recipient, 'bdi', tx.recipient || 'غير مسجل');
                if (tx.recipientName) node(recipient, 'small', tx.recipientName);
                node(body, 'bdi', money(tx.amount, tx.currency), 'rr-amount');
                const foot = node(card, 'span', undefined, 'rr-card-foot');
                const ref = node(foot, 'span');
                node(ref, 'bdi', tx.reference);
                node(ref, 'small', date(tx.createdAt));
                node(foot, 'span', 'التكلفة ' + money(tx.costLYD, 'LYD', 3));
                const row = node(table, 'tr');
                row.dataset.homeTransaction = tx.id;
                const refCell = node(row, 'td');
                const refButton = node(refCell, 'button', tx.reference, 'rr-ref');
                refButton.type = 'button';
                refButton.dataset.homeTransaction = tx.id;
                refButton.setAttribute('aria-label', 'تفاصيل العملية ' + tx.reference);
                node(refCell, 'small', date(tx.createdAt));
                node(row, 'td', tx.service);
                const to = node(row, 'td');
                node(to, 'bdi', tx.recipient || 'غير مسجل');
                if (tx.recipientName) node(to, 'small', tx.recipientName);
                node(row, 'td', money(tx.amount, tx.currency), 'rr-number');
                node(row, 'td', money(tx.costLYD, 'LYD', 3), 'rr-number');
                status(node(row, 'td'), tx);
                const action = node(node(row, 'td'), 'button', 'عرض', 'button');
                action.type = 'button';
                action.dataset.homeTransaction = tx.id;
                action.setAttribute('aria-label', 'عرض تفاصيل العملية ' + tx.reference);
            });
            shown += rows.length;
        };
        const load = async (more = false) => {
            controller?.abort();
            controller = new window.AbortController();
            const own = controller,
                token = ++generation;
            busy = true;
            find('[data-rr-more]').disabled = true;
            find('[data-rr-retry]').hidden = true;
            message(more ? 'جارٍ تحميل المزيد…' : 'جارٍ تحميل التقرير…');
            page.setAttribute('aria-busy', 'true');
            if (!more) {
                shown = 0;
                nextCursor = null;
                asOf = null;
                find('[data-rr-mobile]').replaceChildren();
                find('[data-rr-table]').replaceChildren();
                find('[data-rr-results]').hidden = true;
                find('[data-rr-summary]').hidden = true;
            }
            try {
                const params = toQuery(state);
                if (more && nextCursor) params.set('cursor', nextCursor);
                if (more && asOf) params.set('asOf', asOf);
                const response = await window.fetch('/client/api/retail-reports?' + params.toString(), {
                    signal: own.signal,
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'تعذر تحميل التقرير.');
                if (own.signal.aborted || token !== generation) return;
                state = data.filters;
                persist();
                renderFilters();
                summary(data.summary);
                appendRows(data.rows);
                nextCursor = data.nextCursor;
                asOf = data.asOf;
                find('[data-rr-results]').hidden = false;
                find('[data-rr-more]').hidden = !nextCursor;
                find('[data-rr-shown]').textContent = 'عرض ' + shown + ' من ' + data.summary.count + ' عملية';
                find('[data-rr-updated]').textContent = 'آخر تحديث: ' + date(data.updatedAt);
                message(
                    saveWarning ||
                        (!shown
                            ? 'يمكنك تغيير الفترة أو إزالة الفلاتر.'
                            : 'اضغط على العملية لعرض التفاصيل والإثبات.')
                );
            } catch (error) {
                if (!own.signal.aborted && token === generation) {
                    message(
                        more
                            ? 'تعذر تحميل المزيد. حاول مجددًا؛ العمليات الحالية محفوظة.'
                            : error.message || 'تعذر تحميل التقرير.'
                    );
                    find('[data-rr-retry]').hidden = more;
                }
            } finally {
                if (token === generation) {
                    busy = false;
                    find('[data-rr-more]').disabled = false;
                    page.setAttribute('aria-busy', 'false');
                }
            }
        };
        const apply = () => {
            persist();
            renderFilters();
            void load();
        };
        const resetFilters = () => {
            state = readState('', null);
            if (filterDialog.open) filterDialog.close();
            apply();
        };
        const syncDates = () => {
            const type = filterForm.elements.dateType.value;
            for (const key of ['day', 'month', 'range'])
                filterDialog.querySelector('[data-rr-date-' + key + ']').hidden = type !== key;
            for (const [name, enabled] of [
                ['day', type === 'day'],
                ['month', type === 'month'],
                ['dateFrom', type === 'range'],
                ['dateTo', type === 'range'],
            ]) {
                filterForm.elements[name].disabled = !enabled;
                filterForm.elements[name].required = enabled;
            }
        };
        const openFilters = () => {
            const today = todayKey();
            filterForm.elements.dateType.value = state.dateType;
            filterForm.elements.day.value = state.dateType === 'day' ? state.dateValue : today;
            filterForm.elements.month.value =
                state.dateType === 'month' ? state.dateValue : today.slice(0, 7);
            filterForm.elements.dateFrom.value = state.dateFrom || today.slice(0, 7) + '-01';
            filterForm.elements.dateTo.value = state.dateTo || today;
            filterForm.elements.status.value = state.status;
            filterForm.elements.service.value = state.service;
            syncDates();
            filterDialog.showModal();
            document.body.classList.add('rr-filter-open');
        };
        searchForm.addEventListener('submit', (event) => {
            event.preventDefault();
            state.search = searchForm.elements.search.value.trim();
            apply();
        });
        find('[data-rr-filter]').addEventListener('click', openFilters);
        filterDialog
            .querySelector('[data-rr-filter-close]')
            .addEventListener('click', () => filterDialog.close());
        filterDialog.addEventListener('close', () => document.body.classList.remove('rr-filter-open'));
        filterForm.elements.dateType.addEventListener('change', syncDates);
        filterForm.addEventListener('submit', (event) => {
            event.preventDefault();
            const f = filterForm.elements;
            state = {
                ...state,
                dateType: f.dateType.value,
                dateValue:
                    f.dateType.value === 'range'
                        ? ''
                        : f.dateType.value === 'day'
                          ? f.day.value
                          : f.month.value,
                dateFrom: f.dateType.value === 'range' ? f.dateFrom.value : '',
                dateTo: f.dateType.value === 'range' ? f.dateTo.value : '',
                status: f.status.value,
                service: f.service.value,
            };
            filterDialog.close();
            apply();
        });
        filterDialog.querySelector('[data-rr-reset]').addEventListener('click', resetFilters);
        page.querySelectorAll('[data-rr-period]').forEach((button) =>
            button.addEventListener('click', () => {
                if (button.dataset.rrPeriod === 'range') {
                    openFilters();
                    filterForm.elements.dateType.value = 'range';
                    syncDates();
                    return;
                }
                const today = todayKey();
                state = {
                    ...state,
                    dateType: button.dataset.rrPeriod,
                    dateValue: button.dataset.rrPeriod === 'day' ? today : today.slice(0, 7),
                    dateFrom: '',
                    dateTo: '',
                };
                apply();
            })
        );
        find('[data-rr-more]').addEventListener('click', () => {
            if (!busy && nextCursor) void load(true);
        });
        find('[data-rr-refresh]').addEventListener('click', () => void load());
        find('[data-rr-retry]').addEventListener('click', () => void load());
        window.addEventListener('popstate', () => {
            state = readState(window.location.search, null);
            renderFilters();
            void load();
        });
        renderFilters();
        void load();
    };
    return { readState, toQuery, todayKey, mount };
});
