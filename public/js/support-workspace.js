(function supportWorkspaceBootstrap() {
    'use strict';

    const config = window.supportWorkspaceConfig || {};
    const requestedCategory = new URLSearchParams(window.location.search).get('category');
    const state = {
        tickets: [],
        agents: [],
        workspace: null,
        currentTicketId: '',
        page: 1,
        pagination: null,
        assignedFilter: '',
        unreadOnly: false,
        presence: null,
        heartbeatTimer: null,
        listTimer: null,
        detailTimer: null,
        searchTimer: null,
        socket: null
    };

    const statusLabels = {
        open: 'بانتظار الرد',
        answered: 'تم الرد',
        pending_internal: 'متابعة داخلية',
        resolved: 'تم الحل',
        closed: 'مغلقة'
    };

    const priorityLabels = {
        low: 'منخفضة',
        normal: 'عادية',
        high: 'مرتفعة',
        urgent: 'عاجلة'
    };

    const categoryLabels = {
        general: 'استفسار عام',
        transfer: 'عملية تحويل',
        deposit: 'إيداع أو خصم',
        account: 'الحساب والصلاحيات',
        whatsapp: 'واتساب',
        technical: 'مشكلة تقنية',
        password_reset: 'استعادة كلمة المرور',
        transaction: 'مشكلة في عملية',
        pending_transaction: 'عملية متأخرة',
        balance: 'الرصيد والمطابقة',
        report: 'التقارير',
        receipt: 'الإيصال أو الإثبات',
        cancellation: 'إلغاء عملية',
        application: 'مشكلة في التطبيق',
        notifications: 'الإشعارات',
        employee_account: 'حساب موظف',
        api: 'منفذ API',
        other: 'طلب آخر'
    };

    const entityLabels = {
        client_user: 'عميل أو وكيل',
        client_company: 'شركة أو موظف شركة',
        sub_client: 'عميل تابع لوكالة',
        executor: 'منفذ',
        whatsapp: 'جهة واتساب'
    };

    const accountTypeLabels = {
        client_user: 'عميل مباشر',
        agent: 'وكيل',
        client_company_employee: 'موظف شركة',
        company: 'شركة',
        sub_client: 'عميل تابع',
        agent_employee: 'موظف وكالة',
        executor: 'موظف تنفيذ',
        whatsapp: 'جهة واتساب'
    };

    const transactionStatusLabels = {
        pending: 'جديدة',
        processing: 'قيد التنفيذ',
        accepted: 'مقبولة',
        completed: 'ناجحة',
        rejected: 'ملغاة',
        cancelled_by_admin: 'ملغاة إداريًا',
        deposit_pending: 'إيداع معلق',
        deposit: 'إيداع',
        deduction: 'خصم'
    };

    const transferTypeLabels = {
        vodafone: 'محافظ كاش',
        cash_wallet: 'محافظ كاش',
        post_account: 'بريد حساب',
        post_card: 'بريد بطاقة',
        bank: 'تحويل بنكي',
        insta_pay: 'إنستا باي',
        nita: 'NITA',
        nita_account: 'NITA ACCOUNT',
        bankak: 'بنكك السودان',
        internal_transfer: 'تحويل بين الحسابات'
    };

    const quickReplies = [
        'تم استلام طلبك وجارٍ مراجعته الآن.',
        'نحتاج إلى صورة أوضح للبيانات لإكمال المراجعة.',
        'تم تصعيد الطلب إلى القسم المختص وسنوافيك بالتحديث.',
        'تم حل المشكلة، يرجى المحاولة مرة أخرى وإبلاغنا بالنتيجة.'
    ];

    const byId = (id) => document.getElementById(id);

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));

    const safeMediaUrl = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (/^data:image\/(png|jpe?g|webp);base64,/i.test(raw)) return raw;
        try {
            const target = new URL(raw, window.location.origin);
            return ['http:', 'https:'].includes(target.protocol) ? target.href : '';
        } catch (_error) {
            return '';
        }
    };

    const requestJson = async (url, options = {}) => {
        const requestOptions = { ...options };
        const method = String(requestOptions.method || 'GET').toUpperCase();
        const headers = new Headers(requestOptions.headers || {});
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('x-csrf-token', config.csrfToken || '');
        requestOptions.headers = headers;
        const response = await fetch(url, requestOptions);
        let data = {};
        try { data = await response.json(); } catch (_error) {}
        if (!response.ok || data.success === false) {
            const error = new Error(data.error || 'تعذر إكمال الطلب.');
            error.status = response.status;
            error.code = data.code || '';
            error.data = data;
            throw error;
        }
        return data;
    };

    const formatDateTime = (value) => {
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '---';
        return new Intl.DateTimeFormat('ar-LY', {
            timeZone: 'Africa/Tripoli',
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        }).format(date);
    };

    const formatTime = (value) => {
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat('ar-LY', {
            timeZone: 'Africa/Tripoli', hour: '2-digit', minute: '2-digit'
        }).format(date);
    };

    const formatRelative = (value) => {
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return 'الآن';
        const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
        if (seconds < 60) return 'الآن';
        if (seconds < 3600) return `منذ ${Math.floor(seconds / 60)} د`;
        if (seconds < 86400) return `منذ ${Math.floor(seconds / 3600)} س`;
        return `منذ ${Math.floor(seconds / 86400)} ي`;
    };

    const formatMoney = (value, currency = 'د.ل') => {
        const amount = Number(value || 0);
        return `${new Intl.NumberFormat('ar-LY', { maximumFractionDigits: 2 }).format(amount)} ${currency}`;
    };

    const formatDuration = (milliseconds) => {
        if (milliseconds == null || !Number.isFinite(milliseconds)) return '--:--';
        const overdue = milliseconds < 0;
        const totalSeconds = Math.floor(Math.abs(milliseconds) / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const value = hours > 0
            ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
            : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        return overdue ? `-${value}` : value;
    };

    const initials = (name) => String(name || 'ع')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join('');

    const showToast = (message, type = 'success') => {
        document.querySelector('.support-toast')?.remove();
        const toast = document.createElement('div');
        toast.className = `support-toast is-${type}`;
        toast.innerHTML = `<i class="fa-solid ${type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check'}"></i><span>${escapeHtml(message)}</span>`;
        document.body.appendChild(toast);
        window.setTimeout(() => toast.remove(), 3600);
    };

    const setLoadingState = (target, message = 'جاري التحميل...') => {
        if (!target) return;
        target.innerHTML = `<div class="support-list-state"><i class="fa-solid fa-spinner fa-spin"></i><strong>${escapeHtml(message)}</strong></div>`;
    };

    const buildListQuery = () => {
        const params = new URLSearchParams({ page: String(state.page), limit: '50' });
        const search = byId('supportTicketSearch')?.value.trim();
        const status = byId('supportStatusFilter')?.value;
        const priority = byId('supportPriorityFilter')?.value;
        const channel = byId('supportChannelFilter')?.value;
        if (search) params.set('search', search);
        if (status) params.set('status', status);
        if (priority) params.set('priority', priority);
        if (channel) params.set('channel', channel);
        if (requestedCategory) params.set('category', requestedCategory);
        if (state.assignedFilter) params.set('assigned', state.assignedFilter);
        if (state.unreadOnly) params.set('unread', 'true');
        return params;
    };

    const renderMetrics = (summary = {}) => {
        const values = {
            supportMetricActive: summary.active,
            supportMetricUnread: summary.unread,
            supportMetricUrgent: summary.urgent,
            supportMetricUnassigned: summary.unassigned,
            supportMetricOverdue: summary.overdue
        };
        Object.entries(values).forEach(([id, value]) => {
            const target = byId(id);
            if (target) target.textContent = Number(value || 0).toLocaleString('ar-LY');
        });
    };

    const loadSummary = async () => {
        try {
            const data = await requestJson('/api/support/summary');
            renderMetrics(data.summary);
        } catch (_error) {}
    };

    const loadAgents = async () => {
        try {
            const data = await requestJson('/api/support/agents');
            state.agents = Array.isArray(data.agents) ? data.agents : [];
        } catch (_error) {
            state.agents = [config.admin].filter(Boolean);
        }
    };

    const ticketChannelIcon = (channel) => channel === 'whatsapp'
        ? '<i class="fa-brands fa-whatsapp" title="واتساب"></i>'
        : '<i class="fa-regular fa-window-maximize" title="بوابة العميل"></i>';

    const ticketSlaHtml = (ticket) => {
        const dueAt = ticket.sla?.nextDueAt;
        if (!dueAt) return '';
        const remaining = new Date(dueAt).getTime() - Date.now();
        return `<span class="ticket-sla ${remaining < 0 ? 'is-overdue' : ''}" data-sla-due="${escapeHtml(dueAt)}">${formatDuration(remaining)}</span>`;
    };

    const renderTicketList = () => {
        const list = byId('supportTicketList');
        if (!list) return;
        byId('supportQueueCount').textContent = String(state.pagination?.total ?? state.tickets.length);

        if (!state.tickets.length) {
            list.innerHTML = '<div class="support-list-state"><i class="fa-regular fa-folder-open"></i><strong>لا توجد تذاكر مطابقة</strong><small>غيّر البحث أو عوامل التصفية لعرض نتائج أخرى.</small></div>';
            return;
        }

        list.innerHTML = state.tickets.map((ticket) => {
            const locked = ticket.lock?.active && !ticket.lock?.mine;
            const assignee = ticket.assignedToName || 'غير معيّنة';
            return `
                <button type="button" class="support-ticket ${state.currentTicketId === ticket._id ? 'is-active' : ''}" data-ticket-id="${escapeHtml(ticket._id)}">
                    <span class="ticket-priority-line priority-${escapeHtml(ticket.priority || 'normal')}"></span>
                    <span class="ticket-main">
                        <span class="ticket-title-row">
                            <span class="ticket-name">${escapeHtml(ticket.name || 'عميل')}</span>
                            <span class="ticket-channel">${ticketChannelIcon(ticket.channel)}</span>
                            ${locked ? '<i class="fa-solid fa-lock ticket-channel" title="يعالجها مدير آخر"></i>' : ''}
                        </span>
                        <span class="ticket-preview">${escapeHtml(ticket.lastMessagePreview || 'لا توجد معاينة للرسالة')}</span>
                        <span class="ticket-meta-row">
                            <span>${escapeHtml(statusLabels[ticket.status] || ticket.status)}</span>
                            <span>•</span>
                            <span class="ticket-assignee"><i class="fa-regular fa-user"></i> ${escapeHtml(assignee)}</span>
                            ${ticketSlaHtml(ticket)}
                        </span>
                    </span>
                    <span class="ticket-side">
                        <span class="ticket-age">${escapeHtml(formatRelative(ticket.lastMessageAt || ticket.updatedAt))}</span>
                        ${ticket.unreadAdmin > 0 ? `<span class="ticket-unread">${Math.min(99, ticket.unreadAdmin)}</span>` : '<span></span>'}
                    </span>
                </button>
            `;
        }).join('');
    };

    const loadTickets = async ({ silent = false } = {}) => {
        const list = byId('supportTicketList');
        if (!silent && !state.tickets.length) setLoadingState(list, 'جاري تحميل المحادثات...');
        try {
            const data = await requestJson(`/api/support/tickets?${buildListQuery().toString()}`);
            state.tickets = Array.isArray(data.tickets) ? data.tickets : [];
            state.pagination = data.pagination || null;
            renderTicketList();
        } catch (error) {
            if (list) list.innerHTML = `<div class="support-list-state"><i class="fa-solid fa-circle-exclamation"></i><strong>${escapeHtml(error.message)}</strong></div>`;
        }
    };

    const presenceRequest = async (ticketId, action, keepalive = false) => {
        const response = await fetch(`/api/support/tickets/${ticketId}/presence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
            keepalive
        });
        let data = {};
        try { data = await response.json(); } catch (_error) {}
        if (response.status === 404) return null;
        if (!response.ok && response.status !== 409) throw new Error(data.error || 'تعذر تحديث حضور موظف الدعم.');
        return data.presence || null;
    };

    const stopHeartbeat = () => {
        if (state.heartbeatTimer) window.clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
    };

    const applyPresenceToWorkspace = (presence) => {
        if (!state.workspace?.summary) return;
        const active = Boolean(presence?.expiresAt && new Date(presence.expiresAt).getTime() > Date.now());
        state.workspace.summary.lock = {
            active,
            mine: active && String(presence.holderId) === String(config.admin?.id),
            holderId: active ? String(presence.holderId || '') : '',
            holderName: active ? String(presence.holderName || '') : '',
            expiresAt: active ? presence.expiresAt : null
        };
    };

    const startHeartbeat = () => {
        stopHeartbeat();
        if (!state.currentTicketId || !state.presence?.acquired) return;
        state.heartbeatTimer = window.setInterval(async () => {
            try {
                const presence = await presenceRequest(state.currentTicketId, 'heartbeat');
                if (!presence?.acquired) {
                    state.presence = presence;
                    applyPresenceToWorkspace(presence);
                    renderConversation();
                    stopHeartbeat();
                }
            } catch (_error) {}
        }, 20000);
    };

    const releaseCurrentPresence = async (keepalive = false) => {
        const ticketId = state.currentTicketId;
        stopHeartbeat();
        if (!ticketId || !state.presence?.acquired) return;
        state.presence = null;
        try { await presenceRequest(ticketId, 'release', keepalive); } catch (_error) {}
    };

    const setMobilePanel = (name) => {
        document.querySelectorAll('.support-panel').forEach((panel) => panel.classList.remove('is-mobile-active'));
        const target = byId(name === 'queue' ? 'supportQueuePanel' : name === 'context' ? 'supportContextPanel' : 'supportConversationPanel');
        target?.classList.add('is-mobile-active');
    };

    const showConversationLoading = () => {
        const panel = byId('supportConversationPanel');
        if (!panel) return;
        panel.innerHTML = '<div class="support-empty-state"><i class="fa-solid fa-spinner fa-spin"></i><h3>جاري فتح المحادثة</h3><p>يتم تحميل الرسائل وسياق الحساب والمعاملات المرتبطة.</p></div>';
    };

    const openTicket = async (ticketId, { refresh = false } = {}) => {
        if (!ticketId) return;
        const switching = state.currentTicketId && state.currentTicketId !== ticketId;
        if (switching) await releaseCurrentPresence();

        const draft = byId('supportReplyInput')?.value || '';
        state.currentTicketId = ticketId;
        renderTicketList();
        setMobilePanel('conversation');
        if (!refresh) showConversationLoading();

        try {
            const data = await requestJson(`/api/support/tickets/${ticketId}`);
            if (state.currentTicketId !== ticketId) return;
            state.workspace = data;

            const editable = !['closed', 'resolved'].includes(data.ticket.status);
            if (!refresh && editable) {
                state.presence = await presenceRequest(ticketId, 'acquire');
                applyPresenceToWorkspace(state.presence);
                startHeartbeat();
            } else if (state.presence) {
                applyPresenceToWorkspace(state.presence);
            }

            renderConversation(draft);
            renderContext();
            await Promise.all([loadTickets({ silent: true }), loadSummary()]);
        } catch (error) {
            const panel = byId('supportConversationPanel');
            if (panel) panel.innerHTML = `<div class="support-empty-state"><i class="fa-solid fa-circle-exclamation"></i><h3>تعذر فتح التذكرة</h3><p>${escapeHtml(error.message)}</p></div>`;
        }
    };

    const optionHtml = (items, selected) => Object.entries(items)
        .map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`)
        .join('');

    const agentOptionsHtml = (selected) => {
        const options = ['<option value="">غير معيّنة</option>'];
        state.agents.forEach((agent) => {
            options.push(`<option value="${escapeHtml(agent.id)}" ${String(agent.id) === String(selected || '') ? 'selected' : ''}>${escapeHtml(agent.name)}</option>`);
        });
        return options.join('');
    };

    const renderPasswordResetActions = (ticket, disabled) => {
        const metadata = ticket.metadata || {};
        if (metadata.type !== 'password_reset') return '';
        const pending = (metadata.passwordResetStatus || 'pending_admin') === 'pending_admin' && ticket.status !== 'closed';
        if (!pending) {
            const approved = metadata.passwordResetStatus === 'approved';
            return `<div class="support-password-action"><span><i class="fa-solid ${approved ? 'fa-check text-success' : 'fa-xmark text-danger'}"></i> ${approved ? 'تم اعتماد كلمة المرور الجديدة' : 'تم إلغاء طلب الاستعادة'}</span></div>`;
        }
        return `
            <div class="support-password-action">
                <span><i class="fa-solid fa-key"></i> طلب استعادة كلمة مرور ينتظر القرار</span>
                <span class="support-password-buttons">
                    <button type="button" class="btn btn-success" data-action="password-reset" data-reset-action="approve" ${disabled ? 'disabled' : ''}>اعتماد</button>
                    <button type="button" class="btn btn-outline-danger" data-action="password-reset" data-reset-action="reject" ${disabled ? 'disabled' : ''}>رفض</button>
                </span>
            </div>
        `;
    };

    const renderExecutorDepositActions = (ticket, disabled) => {
        const deposit = ticket.metadata?.depositRequest;
        if (ticket.metadata?.type !== 'executor_deposit' || !deposit) return '';

        const toReceiptUrl = (imagePath) => {
            const value = String(imagePath || '').trim();
            if (!value) return '';
            if (value.startsWith('http') || value.startsWith('/')) return safeMediaUrl(value) || value;
            return safeMediaUrl(`/uploads/${value.replace(/^\/+/, '')}`) || `/uploads/${value.replace(/^\/+/, '')}`;
        };

        const receiptUrls = (Array.isArray(deposit.receiptImages) ? deposit.receiptImages : [])
            .map(toReceiptUrl)
            .filter(Boolean);
        if (!receiptUrls.length) {
            (ticket.messages || []).forEach((message) => {
                if (message.messageType === 'image' && message.imageUrl) {
                    const media = toReceiptUrl(message.imageUrl);
                    if (media) receiptUrls.push(media);
                }
            });
        }

        const status = deposit.status || 'pending';
        const statusLabel = status === 'approved'
            ? 'مقبول'
            : (status === 'rejected' ? 'مرفوض' : 'قيد المراجعة');
        const statusClass = status === 'approved'
            ? 'is-approved'
            : (status === 'rejected' ? 'is-rejected' : 'is-pending');
        const companyName = ticket.metadata?.executorGroupName || ticket.name || 'شركة التنفيذ';
        const isMaster = config.admin?.role === 'master';
        const galleryHtml = receiptUrls.length
            ? `<div class="deposit-review-gallery">${receiptUrls.map((url, index) => `
                <button type="button" class="deposit-review-thumb" data-action="deposit-lightbox" data-image-url="${escapeHtml(url)}" title="إيصال ${index + 1}">
                    <img src="${escapeHtml(url)}" alt="إيصال ${index + 1}">
                    <span>${index + 1}</span>
                </button>`).join('')}</div>`
            : '<div class="deposit-review-empty"><i class="fa-regular fa-image"></i> لا توجد صور إيصالات مرفقة.</div>';

        let actionsHtml = '';
        if (status === 'approved') {
            actionsHtml = `<div class="deposit-review-footnote is-success"><i class="fa-solid fa-circle-check"></i> تم قبول الإيداع وإضافة الرصيد للشركة${deposit.reviewedByName ? ` بواسطة ${escapeHtml(deposit.reviewedByName)}` : ''}${deposit.reviewedAt ? ` · ${escapeHtml(formatDateTime(deposit.reviewedAt))}` : ''}.</div>`;
        } else if (status === 'rejected') {
            actionsHtml = `<div class="deposit-review-footnote is-danger"><i class="fa-solid fa-circle-xmark"></i> تم رفض طلب الإيداع${deposit.reviewedByName ? ` بواسطة ${escapeHtml(deposit.reviewedByName)}` : ''}.${deposit.rejectionReason ? `<strong>السبب:</strong> ${escapeHtml(deposit.rejectionReason)}` : ''}</div>`;
        } else if (!isMaster) {
            actionsHtml = `<div class="deposit-review-footnote is-warn"><i class="fa-solid fa-lock"></i> يمكنك مراجعة الإيصالات هنا. القبول النهائي وإضافة الرصيد للمدير الأساسي فقط.</div>`;
        } else {
            actionsHtml = `<div class="deposit-review-actions"><button type="button" class="btn btn-success" data-action="executor-deposit" data-deposit-action="approve" ${disabled ? 'disabled' : ''}><i class="fa-solid fa-circle-check ms-1"></i> قبول وإضافة الرصيد</button><button type="button" class="btn btn-outline-danger" data-action="executor-deposit" data-deposit-action="reject" ${disabled ? 'disabled' : ''}><i class="fa-solid fa-ban ms-1"></i> رفض مع سبب</button></div>`;
        }

        return `
            <section class="deposit-review-panel">
                <header class="deposit-review-header">
                    <div>
                        <span class="deposit-review-kicker"><i class="fa-solid fa-building-columns"></i> طلب إيداع شركة تنفيذ</span>
                        <h3 class="deposit-review-title">${escapeHtml(deposit.customId || 'طلب إيداع')}</h3>
                        <p class="deposit-review-subtitle">${escapeHtml(companyName)}${deposit.submittedByName ? ` · ${escapeHtml(deposit.submittedByName)}` : ''}</p>
                    </div>
                    <span class="deposit-review-status ${statusClass}">${escapeHtml(statusLabel)}</span>
                </header>
                <dl class="deposit-review-grid">
                    <div><dt>القيمة</dt><dd dir="ltr">${escapeHtml(formatMoney(deposit.amount, 'EGP'))}</dd></div>
                    <div><dt>عدد الإيصالات</dt><dd>${escapeHtml(String(receiptUrls.length || deposit.receiptCount || 0))}</dd></div>
                    <div class="is-wide"><dt>ملاحظة الشركة</dt><dd>${escapeHtml(deposit.note || 'لا توجد ملاحظة')}</dd></div>
                </dl>
                <div class="deposit-review-gallery-wrap">
                    <div class="deposit-review-gallery-label"><i class="fa-solid fa-images"></i> معرض الإيصالات</div>
                    ${galleryHtml}
                </div>
                ${actionsHtml}
            </section>
        `;
    };

    const renderMessages = (messages = [], ticket = null) => {
        if (!messages.length) {
            return '<div class="support-empty-state"><i class="fa-regular fa-comments"></i><h3>لا توجد رسائل بعد</h3><p>اكتب أول رد لبدء المحادثة مع العميل.</p></div>';
        }

        const isExecutorDeposit = ticket?.metadata?.type === 'executor_deposit';
        const visibleMessages = isExecutorDeposit
            ? messages.filter((message) => !(message.messageType === 'image' && message.imageUrl))
            : messages;

        if (!visibleMessages.length) {
            return '<div class="support-empty-state"><i class="fa-regular fa-comments"></i><h3>تفاصيل الطلب في البطاقة أعلاه</h3><p>يمكنك متابعة المحادثة أو إرسال رد للشركة عند الحاجة.</p></div>';
        }

        return visibleMessages.map((message) => {
            const isAdmin = ['admin', 'ai', 'system'].includes(message.sender);
            const media = safeMediaUrl(message.imageUrl);
            const channelIcon = message.channel === 'whatsapp' ? '<i class="fa-brands fa-whatsapp"></i>' : '<i class="fa-regular fa-window-maximize"></i>';
            const delivery = message.deliveryStatus === 'failed'
                ? '<span class="text-danger"><i class="fa-solid fa-triangle-exclamation"></i> لم تُسلّم</span>'
                : message.deliveryStatus === 'sent'
                    ? '<span><i class="fa-solid fa-check"></i> أُرسلت</span>'
                    : '';
            return `
                <div class="message-row ${isAdmin ? 'is-admin' : 'is-customer'}">
                    <article class="message-bubble">
                        <div class="message-sender">
                            <span>${isAdmin ? '<i class="fa-solid fa-headset"></i>' : '<i class="fa-regular fa-user"></i>'} ${escapeHtml(message.senderName || (isAdmin ? 'الإدارة' : 'العميل'))}</span>
                            <span>${channelIcon}</span>
                        </div>
                        ${media ? `<a href="${escapeHtml(media)}" target="_blank" rel="noopener noreferrer"><img class="message-media" src="${escapeHtml(media)}" alt="مرفق المحادثة"></a>` : ''}
                        ${message.imageUrl && !media ? '<div class="message-text"><i class="fa-regular fa-image"></i> مرفق يحتاج مراجعة</div>' : ''}
                        ${message.text ? `<div class="message-text">${escapeHtml(message.text)}</div>` : ''}
                        <div class="message-meta"><span>${escapeHtml(formatTime(message.createdAt))}</span>${delivery}</div>
                    </article>
                </div>
            `;
        }).join('');
    };

    const renderConversation = (draft = '') => {
        const panel = byId('supportConversationPanel');
        const workspace = state.workspace;
        if (!panel || !workspace?.ticket) return;

        const ticket = workspace.ticket;
        const summary = workspace.summary || {};
        const lock = summary.lock || {};
        const lockedByOther = lock.active && !lock.mine;
        const closed = ['closed', 'resolved'].includes(ticket.status);
        const disabled = lockedByOther || closed;
        const slaDue = summary.sla?.nextDueAt;
        const slaRemaining = slaDue ? new Date(slaDue).getTime() - Date.now() : null;
        const isWhatsApp = ticket.channel === 'whatsapp' || ticket.metadata?.replyChannel === 'whatsapp';

        panel.innerHTML = `
            <div class="conversation-shell">
                <header class="conversation-header">
                    <div class="conversation-person">
                        <button type="button" class="support-icon-btn support-mobile-back" data-action="mobile-queue" title="العودة إلى المحادثات"><i class="fa-solid fa-arrow-right"></i></button>
                        <span class="conversation-avatar">${escapeHtml(initials(ticket.name))}</span>
                        <div class="conversation-person-copy">
                            <h2>${escapeHtml(ticket.name || 'عميل')}</h2>
                            <div class="conversation-subtitle">
                                <span>${escapeHtml(ticket.ticketId || '')}</span>
                                <span class="channel-badge ${isWhatsApp ? 'whatsapp' : 'portal'}">${isWhatsApp ? '<i class="fa-brands fa-whatsapp"></i> واتساب' : '<i class="fa-regular fa-window-maximize"></i> البوابة'}</span>
                                <span>${escapeHtml(entityLabels[ticket.entityType] || ticket.entityType || '')}</span>
                            </div>
                        </div>
                    </div>
                    <div class="conversation-header-actions">
                        ${slaDue ? `<div class="conversation-sla ${slaRemaining < 0 ? 'is-overdue' : ''}" data-sla-due="${escapeHtml(slaDue)}"><span class="conversation-sla-label">زمن الاستجابة</span><span class="conversation-sla-time">${formatDuration(slaRemaining)}</span></div>` : ''}
                        ${isWhatsApp && !closed ? '<button type="button" class="support-icon-btn" data-action="ticket-whatsapp-test" title="اختبار واتساب"><i class="fa-brands fa-whatsapp"></i></button>' : ''}
                        <button type="button" class="support-icon-btn support-mobile-context-toggle" data-action="toggle-context" title="بيانات العميل"><i class="fa-regular fa-address-card"></i></button>
                        ${!closed ? '<button type="button" class="support-icon-btn" data-action="close-ticket" title="إغلاق التذكرة"><i class="fa-solid fa-lock"></i></button>' : ''}
                    </div>
                </header>
                <div class="conversation-controls">
                    <div class="conversation-control"><label for="supportStateStatus">الحالة</label><select id="supportStateStatus" data-state-field="status" ${lockedByOther ? 'disabled' : ''}>${optionHtml(statusLabels, ticket.status)}</select></div>
                    <div class="conversation-control"><label for="supportStatePriority">الأولوية</label><select id="supportStatePriority" data-state-field="priority" ${lockedByOther ? 'disabled' : ''}>${optionHtml(priorityLabels, ticket.priority || 'normal')}</select></div>
                    <div class="conversation-control"><label for="supportStateAssignee">المسؤول</label><select id="supportStateAssignee" data-state-field="assigneeId" ${lockedByOther ? 'disabled' : ''}>${agentOptionsHtml(ticket.assignedToId)}</select></div>
                    <div class="conversation-control"><label for="supportStateCategory">التصنيف</label><select id="supportStateCategory" data-state-field="category" ${lockedByOther ? 'disabled' : ''}>${optionHtml(categoryLabels, ticket.category || 'general')}</select></div>
                </div>
                ${lockedByOther ? `<div class="conversation-lock"><i class="fa-solid fa-user-lock"></i><span>يعالج ${escapeHtml(lock.holderName || 'مدير آخر')} هذه التذكرة الآن. تم تعطيل الرد لمنع إرسال ردين متعارضين.</span></div>` : ''}
                ${renderPasswordResetActions(ticket, disabled)}
                ${renderExecutorDepositActions(ticket, disabled)}
                <div class="conversation-messages" id="supportMessages">${renderMessages(ticket.messages, ticket)}</div>
                ${!closed ? `<div class="conversation-quick-replies">${quickReplies.map((reply) => `<button type="button" class="quick-reply" data-action="quick-reply" data-reply="${escapeHtml(reply)}" ${disabled ? 'disabled' : ''}>${escapeHtml(reply)}</button>`).join('')}</div>` : ''}
                ${!closed ? `<form class="conversation-composer" id="supportReplyForm"><textarea id="supportReplyInput" maxlength="4096" placeholder="اكتب ردًا واضحًا للعميل..." ${disabled ? 'disabled' : ''}>${escapeHtml(draft)}</textarea><button type="submit" title="إرسال الرد" ${disabled ? 'disabled' : ''}><i class="fa-solid fa-paper-plane"></i></button></form>` : '<div class="conversation-lock"><i class="fa-solid fa-circle-check"></i><span>هذه التذكرة منتهية. يمكن إعادة فتحها من قائمة الحالة عند الحاجة.</span></div>'}
            </div>
        `;

        window.requestAnimationFrame(() => {
            const messages = byId('supportMessages');
            if (messages) messages.scrollTop = messages.scrollHeight;
            byId('supportReplyInput')?.focus({ preventScroll: true });
        });
    };

    const accountParentLabel = (account) => account?.parent?.name
        ? `${account.parent.type === 'company' ? 'الشركة' : account.parent.type === 'agent' ? 'الوكالة' : 'الجهة'}: ${account.parent.name}`
        : '';

    const renderAccountContext = (account, ticket) => {
        if (!account) return '<div class="context-empty">لا توجد بيانات حساب مرتبطة بهذه التذكرة.</div>';
        return `
            <div class="customer-identity">
                <span class="customer-avatar">${escapeHtml(initials(account.name || ticket.name))}</span>
                <div><h3>${escapeHtml(account.name || ticket.name || 'عميل')}</h3><p>${escapeHtml(account.phone || ticket.phone || ticket.phoneNormalized || 'لا يوجد رقم هاتف')}</p></div>
            </div>
            <dl class="context-data-list">
                <div class="context-data-row"><dt>نوع الحساب</dt><dd>${escapeHtml(accountTypeLabels[account.type] || entityLabels[ticket.entityType] || 'غير محدد')}</dd></div>
                <div class="context-data-row"><dt>كود الحساب</dt><dd dir="ltr">${escapeHtml(account.accountCode || '---')}</dd></div>
                <div class="context-data-row"><dt>اسم المستخدم</dt><dd dir="ltr">${escapeHtml(account.username || '---')}</dd></div>
                <div class="context-data-row"><dt>الحالة</dt><dd>${escapeHtml(account.status || '---')}</dd></div>
                ${accountParentLabel(account) ? `<div class="context-data-row"><dt>الجهة التابعة</dt><dd>${escapeHtml(accountParentLabel(account))}</dd></div>` : ''}
            </dl>
            ${account.type !== 'whatsapp' ? `<div class="account-balance-strip"><div class="account-balance-value"><span>الرصيد الحالي</span><strong>${escapeHtml(formatMoney(account.balance))}</strong></div><div class="account-balance-value"><span>الحد الائتماني</span><strong>${escapeHtml(formatMoney(account.creditLimit))}</strong></div></div>` : ''}
        `;
    };

    const renderTransactions = (transactions = []) => {
        if (!transactions.length) return '<div class="context-empty">لا توجد عمليات حديثة مرتبطة بالحساب.</div>';
        return `<div class="context-list">${transactions.map((transaction) => {
            const recipient = transaction.vodafoneNumber || transaction.accountNumber || transaction.accountName || '---';
            return `<div class="context-list-item"><div class="context-list-title"><span>${escapeHtml(transaction.customId || 'عملية')}</span><span class="status-text-${escapeHtml(transaction.status)}">${escapeHtml(transactionStatusLabels[transaction.status] || transaction.status)}</span></div><div class="context-list-meta"><span>${escapeHtml(transferTypeLabels[transaction.transferType] || transaction.transferType || 'تحويل')} • ${escapeHtml(recipient)}</span><strong>${escapeHtml(formatMoney(transaction.amount, 'ج.م'))}</strong></div><div class="context-list-meta"><span>${escapeHtml(formatDateTime(transaction.createdAt))}</span><span>${escapeHtml(formatMoney(transaction.costLYD))}</span></div></div>`;
        }).join('')}</div>`;
    };

    const renderPreviousTickets = (tickets = []) => {
        if (!tickets.length) return '<div class="context-empty">هذه أول تذكرة مسجلة للعميل.</div>';
        return `<div class="context-list">${tickets.map((ticket) => `<button type="button" class="context-list-item" data-ticket-id="${escapeHtml(ticket._id)}"><span class="context-list-title"><span>${escapeHtml(ticket.ticketId || '')}</span><span>${escapeHtml(statusLabels[ticket.status] || ticket.status)}</span></span><span class="context-list-meta"><span>${escapeHtml(ticket.lastMessagePreview || 'بدون معاينة')}</span><span>${escapeHtml(formatRelative(ticket.updatedAt))}</span></span></button>`).join('')}</div>`;
    };

    const renderContext = () => {
        const panel = byId('supportContextPanel');
        const workspace = state.workspace;
        if (!panel || !workspace?.ticket) return;
        const ticket = workspace.ticket;
        panel.innerHTML = `
            <div class="support-panel-heading"><h2><i class="fa-regular fa-address-card"></i> سياق العميل</h2><button type="button" class="support-icon-btn support-mobile-context-toggle" data-action="close-context" title="إغلاق"><i class="fa-solid fa-xmark"></i></button></div>
            <div class="support-context-scroll">
                <section class="context-section"><h3 class="context-section-title"><i class="fa-regular fa-user"></i> بيانات الحساب</h3>${renderAccountContext(workspace.account, ticket)}</section>
                <section class="context-section"><h3 class="context-section-title"><i class="fa-solid fa-arrow-right-arrow-left"></i> آخر العمليات</h3>${renderTransactions(workspace.recentTransactions)}</section>
                <section class="context-section"><h3 class="context-section-title"><i class="fa-regular fa-clock"></i> التذاكر السابقة</h3>${renderPreviousTickets(workspace.previousTickets)}</section>
                <section class="context-section"><h3 class="context-section-title"><i class="fa-solid fa-gauge-high"></i> مؤشرات الخدمة</h3><dl class="context-data-list"><div class="context-data-row"><dt>الأولوية</dt><dd>${escapeHtml(priorityLabels[ticket.priority || 'normal'])}</dd></div><div class="context-data-row"><dt>وقت الإنشاء</dt><dd>${escapeHtml(formatDateTime(ticket.createdAt))}</dd></div><div class="context-data-row"><dt>أول رد</dt><dd>${escapeHtml(ticket.firstResponseAt ? formatDateTime(ticket.firstResponseAt) : 'لم يتم بعد')}</dd></div><div class="context-data-row"><dt>المسؤول</dt><dd>${escapeHtml(ticket.assignedToName || 'غير معيّنة')}</dd></div></dl></section>
            </div>
        `;
    };

    const refreshCurrentTicket = async () => {
        if (!state.currentTicketId) return;
        await openTicket(state.currentTicketId, { refresh: true });
    };

    const updateTicketState = async (field, value, select) => {
        if (!state.currentTicketId) return;
        select.disabled = true;
        try {
            await requestJson(`/api/support/tickets/${state.currentTicketId}/state`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: value })
            });
            showToast('تم تحديث التذكرة.');
            await refreshCurrentTicket();
        } catch (error) {
            showToast(error.message, 'error');
            await refreshCurrentTicket();
        } finally {
            select.disabled = false;
        }
    };

    const submitReply = async (form) => {
        const input = byId('supportReplyInput');
        const text = input?.value.trim();
        if (!text || !state.currentTicketId) return;
        const button = form.querySelector('button[type="submit"]');
        input.disabled = true;
        button.disabled = true;
        try {
            const data = await requestJson(`/api/support/tickets/${state.currentTicketId}/reply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            input.value = '';
            if (data.warning) {
                await Swal.fire({ icon: 'warning', title: 'تم حفظ الرد في البوابة', text: data.warning, confirmButtonText: 'حسنًا' });
            } else {
                showToast(data.channel === 'whatsapp' ? 'تم إرسال الرد عبر واتساب.' : 'تم إرسال الرد للعميل.');
            }
            await refreshCurrentTicket();
        } catch (error) {
            showToast(error.message, 'error');
            input.disabled = false;
            button.disabled = false;
            input.focus();
        }
    };

    const closeTicket = async () => {
        if (!state.currentTicketId) return;
        const result = await Swal.fire({
            icon: 'warning', title: 'إغلاق التذكرة؟', text: 'ستنتهي المحادثة الحالية، ويمكن للعميل فتح تذكرة جديدة عند الحاجة.',
            showCancelButton: true, confirmButtonText: 'إغلاق', cancelButtonText: 'تراجع', confirmButtonColor: '#c73c4a'
        });
        if (!result.isConfirmed) return;
        try {
            await requestJson(`/api/support/tickets/${state.currentTicketId}/close`, { method: 'POST' });
            state.presence = null;
            stopHeartbeat();
            showToast('تم إغلاق التذكرة.');
            await refreshCurrentTicket();
        } catch (error) {
            showToast(error.message, 'error');
        }
    };

    const sendTicketWhatsAppTest = async () => {
        if (!state.currentTicketId) return;
        const result = await Swal.fire({
            icon: 'question', title: 'إرسال رسالة اختبار؟', text: 'ستُرسل رسالة حقيقية إلى رقم واتساب المرتبط بالتذكرة.',
            showCancelButton: true, confirmButtonText: 'إرسال', cancelButtonText: 'إلغاء', confirmButtonColor: '#0d8f67'
        });
        if (!result.isConfirmed) return;
        try {
            await requestJson(`/api/support/tickets/${state.currentTicketId}/whatsapp-test`, { method: 'POST' });
            showToast('قبل WhatChimp رسالة الاختبار.');
            await refreshCurrentTicket();
        } catch (error) {
            showToast(error.message, 'error');
        }
    };

    const openWhatsAppTestDialog = async () => {
        const result = await Swal.fire({
            icon: 'question', title: 'اختبار واتساب', input: 'tel', inputLabel: 'رقم واتساب العميل', inputPlaceholder: '0940000000',
            inputAttributes: { dir: 'ltr', inputmode: 'tel' }, showCancelButton: true, confirmButtonText: 'إنشاء تذكرة وإرسال', cancelButtonText: 'إلغاء',
            confirmButtonColor: '#0d8f67', inputValidator: (value) => String(value || '').trim() ? undefined : 'أدخل رقم الهاتف.'
        });
        if (!result.isConfirmed) return;
        try {
            const data = await requestJson('/api/support/whatsapp-test', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: result.value })
            });
            await loadTickets({ silent: true });
            if (data.ticketId) await openTicket(data.ticketId);
            showToast('قبل WhatChimp رسالة الاختبار.');
        } catch (error) {
            showToast(error.message, 'error');
        }
    };

    const handlePasswordReset = async (action) => {
        if (!state.currentTicketId) return;
        const approve = action === 'approve';
        const result = await Swal.fire({
            icon: approve ? 'question' : 'warning',
            title: approve ? 'اعتماد كلمة المرور الجديدة؟' : 'رفض طلب الاستعادة؟',
            text: approve ? 'سيتم تغيير كلمة المرور وتفعيل الحساب فورًا.' : 'ستبقى كلمة المرور القديمة كما هي.',
            showCancelButton: true, confirmButtonText: approve ? 'اعتماد' : 'رفض', cancelButtonText: 'تراجع',
            confirmButtonColor: approve ? '#0d8f67' : '#c73c4a'
        });
        if (!result.isConfirmed) return;
        try {
            await requestJson(`/api/support/tickets/${state.currentTicketId}/password-reset/${action}`, { method: 'POST' });
            showToast(approve ? 'تم اعتماد كلمة المرور.' : 'تم رفض الطلب.');
            await refreshCurrentTicket();
        } catch (error) {
            showToast(error.message, 'error');
        }
    };

    const handleExecutorDeposit = async (action) => {
        if (!state.currentTicketId) return;
        let reason = '';
        if (action === 'reject') {
            const result = await Swal.fire({ title: 'سبب رفض الإيداع', input: 'textarea', inputPlaceholder: 'اكتب سببًا واضحًا للشركة...', inputValidator: value => value && value.trim().length >= 3 ? undefined : 'سبب الرفض مطلوب.', showCancelButton: true, confirmButtonText: 'تأكيد الرفض', cancelButtonText: 'تراجع', confirmButtonColor: '#c73c4a' });
            if (!result.isConfirmed) return;
            reason = result.value.trim();
        } else {
            const deposit = state.workspace?.ticket?.metadata?.depositRequest;
            const companyName = state.workspace?.ticket?.metadata?.executorGroupName || state.workspace?.ticket?.name || 'شركة التنفيذ';
            const amountText = deposit?.amount != null
                ? `${Number(deposit.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} EGP`
                : '';
            const result = await Swal.fire({
                icon: 'warning',
                title: 'قبول الإيداع وإضافة الرصيد؟',
                html: `<p>سيُضاف <b dir="ltr">${escapeHtml(amountText)}</b> إلى رصيد <b>${escapeHtml(companyName)}</b> مرة واحدة فقط.</p><p class="small text-muted mb-0">لا يمكن التراجع من هذه الشاشة بعد التأكيد.</p>`,
                showCancelButton: true,
                confirmButtonText: 'قبول وإضافة الرصيد',
                cancelButtonText: 'تراجع',
                confirmButtonColor: '#0d8f67'
            });
            if (!result.isConfirmed) return;
        }
        try {
            await requestJson(`/api/support/tickets/${state.currentTicketId}/executor-deposit/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
            showToast(action === 'approve' ? 'تم قبول الإيداع وإضافة الرصيد.' : 'تم رفض طلب الإيداع.');
            await refreshCurrentTicket();
        } catch (error) { showToast(error.message, 'error'); }
    };

    const updateCountdowns = () => {
        document.querySelectorAll('[data-sla-due]').forEach((element) => {
            const due = new Date(element.dataset.slaDue).getTime();
            if (!Number.isFinite(due)) return;
            const remaining = due - Date.now();
            element.classList.toggle('is-overdue', remaining < 0);
            const value = element.querySelector('.conversation-sla-time') || element;
            value.textContent = formatDuration(remaining);
        });
    };

    const bindEvents = () => {
        document.addEventListener('click', async (event) => {
            const ticketButton = event.target.closest('[data-ticket-id]');
            if (ticketButton) {
                await openTicket(ticketButton.dataset.ticketId);
                return;
            }

            const actionButton = event.target.closest('[data-action]');
            if (!actionButton) return;
            const action = actionButton.dataset.action;
            if (action === 'refresh') await Promise.all([loadTickets(), loadSummary()]);
            if (action === 'whatsapp-test') await openWhatsAppTestDialog();
            if (action === 'ticket-whatsapp-test') await sendTicketWhatsAppTest();
            if (action === 'close-ticket') await closeTicket();
            if (action === 'executor-deposit') await handleExecutorDeposit(actionButton.dataset.depositAction);
            if (action === 'deposit-lightbox') {
                const imageUrl = actionButton.dataset.imageUrl;
                if (imageUrl) {
                    await Swal.fire({
                        imageUrl,
                        imageAlt: 'إيصال الإيداع',
                        showConfirmButton: false,
                        showCloseButton: true,
                        width: 'min(920px, 96vw)',
                        background: 'rgba(15, 23, 42, 0.96)',
                        customClass: { image: 'deposit-lightbox-image' }
                    });
                }
            }
            if (action === 'quick-reply') {
                const input = byId('supportReplyInput');
                if (input) { input.value = actionButton.dataset.reply || ''; input.focus(); }
            }
            if (action === 'mobile-queue') setMobilePanel('queue');
            if (action === 'toggle-context') {
                byId('supportContextPanel')?.classList.add('is-open');
                setMobilePanel('context');
            }
            if (action === 'close-context') {
                byId('supportContextPanel')?.classList.remove('is-open');
                setMobilePanel('conversation');
            }
            if (action === 'password-reset') await handlePasswordReset(actionButton.dataset.resetAction);
        });

        document.addEventListener('change', async (event) => {
            const field = event.target.dataset.stateField;
            if (field) await updateTicketState(field, event.target.value, event.target);
            if (event.target.matches('#supportStatusFilter, #supportPriorityFilter, #supportChannelFilter')) {
                state.page = 1;
                await loadTickets();
            }
        });

        document.addEventListener('submit', async (event) => {
            if (event.target.id !== 'supportReplyForm') return;
            event.preventDefault();
            await submitReply(event.target);
        });

        byId('supportTicketSearch')?.addEventListener('input', () => {
            window.clearTimeout(state.searchTimer);
            state.searchTimer = window.setTimeout(() => { state.page = 1; loadTickets(); }, 320);
        });

        document.querySelectorAll('[data-assigned-filter]').forEach((button) => {
            button.addEventListener('click', async () => {
                document.querySelectorAll('[data-assigned-filter]').forEach((item) => item.classList.remove('is-active'));
                button.classList.add('is-active');
                state.assignedFilter = button.dataset.assignedFilter || '';
                state.unreadOnly = false;
                state.page = 1;
                await loadTickets();
            });
        });

        document.querySelectorAll('[data-metric-filter]').forEach((button) => {
            button.addEventListener('click', async () => {
                const filter = button.dataset.metricFilter;
                if (filter === 'active') {
                    byId('supportStatusFilter').value = 'active';
                    byId('supportPriorityFilter').value = '';
                    byId('supportChannelFilter').value = '';
                    state.assignedFilter = '';
                    state.unreadOnly = false;
                    document.querySelectorAll('[data-assigned-filter]').forEach((item) => item.classList.toggle('is-active', item.dataset.assignedFilter === ''));
                }
                if (filter === 'urgent') {
                    byId('supportPriorityFilter').value = 'urgent';
                    state.unreadOnly = false;
                }
                if (filter === 'unassigned') {
                    state.assignedFilter = 'unassigned';
                    state.unreadOnly = false;
                    document.querySelectorAll('[data-assigned-filter]').forEach((item) => item.classList.toggle('is-active', item.dataset.assignedFilter === 'unassigned'));
                }
                if (filter === 'unread') {
                    byId('supportStatusFilter').value = 'active';
                    state.unreadOnly = true;
                }
                await loadTickets();
            });
        });

        window.addEventListener('beforeunload', () => { releaseCurrentPresence(true); });
    };

    const connectRealtime = () => {
        if (typeof window.io !== 'function') return;
        state.socket = window.io();
        state.socket.on('support:ticket-updated', (payload) => {
            loadTickets({ silent: true });
            loadSummary();
            if (payload?.ticketId && payload.ticketId === state.currentTicketId) refreshCurrentTicket();
        });
    };

    const initialise = async () => {
        bindEvents();
        setMobilePanel('queue');
        await Promise.all([loadAgents(), loadSummary(), loadTickets()]);
        connectRealtime();
        window.setInterval(updateCountdowns, 1000);
        state.listTimer = window.setInterval(() => {
            loadTickets({ silent: true });
            loadSummary();
        }, 15000);
        state.detailTimer = window.setInterval(() => {
            if (state.currentTicketId) refreshCurrentTicket();
        }, 20000);
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialise);
    else initialise();
})();
