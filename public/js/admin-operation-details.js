(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AdminOperationDetails = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const EMPTY_NONE = 'لا يوجد';
    const EMPTY_UNASSIGNED = 'لم يُعيَّن بعد';
    const PENDING_STATUSES = ['pending', 'processing', 'accepted', 'deposit_pending'];
    const SUCCESS_STATUSES = ['completed', 'deposit', 'deduction'];
    const FAIL_STATUSES = ['rejected', 'cancelled_by_admin'];
    const PROGRESS_STATUSES = ['processing', 'accepted'];

    const STATUS_META = {
        completed: { label: 'مكتملة', badgeClass: 'st-done', tone: 'success', icon: 'fa-circle-check' },
        pending: { label: 'معلقة', badgeClass: 'st-wait', tone: 'pending', icon: 'fa-circle-pause' },
        processing: { label: 'موجهة للتنفيذ', badgeClass: 'st-proc', tone: 'progress', icon: 'fa-spinner' },
        accepted: { label: 'قيد العمل', badgeClass: 'st-work', tone: 'progress', icon: 'fa-user-check' },
        deposit_pending: { label: 'طلب إيداع معلق', badgeClass: 'st-wait', tone: 'pending', icon: 'fa-hand-holding-dollar' },
        deposit: { label: 'إيداع', badgeClass: 'st-done', tone: 'success', icon: 'fa-arrow-down' },
        deduction: { label: 'خصم', badgeClass: 'st-fail', tone: 'success', icon: 'fa-arrow-up' },
        rejected: { label: 'مرفوضة', badgeClass: 'st-fail', tone: 'fail', icon: 'fa-ban' },
        cancelled_by_admin: { label: 'ملغية', badgeClass: 'st-fail', tone: 'fail', icon: 'fa-ban' }
    };

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function isBlank(value) {
        const text = String(value ?? '').trim();
        return !text || text === '---' || text === '—' || text === '-' || text === 'undefined' || text === 'null';
    }

    function displayValue(value, kind) {
        if (isBlank(value)) return kind === 'unassigned' ? EMPTY_UNASSIGNED : EMPTY_NONE;
        return String(value).trim();
    }

    function statusMeta(status) {
        return STATUS_META[status] || { label: status || 'غير محددة', badgeClass: 'st-wait', tone: 'pending', icon: 'fa-circle-question' };
    }

    function statusTone(status) {
        if (FAIL_STATUSES.includes(status)) return 'fail';
        if (PROGRESS_STATUSES.includes(status)) return 'progress';
        if (SUCCESS_STATUSES.includes(status)) return 'success';
        if (PENDING_STATUSES.includes(status)) return 'pending';
        return 'pending';
    }

    function cashNetworkLabel(number) {
        const num = String(number || '');
        if (num.startsWith('011')) return 'اتصالات كاش';
        if (num.startsWith('012')) return 'اورانج كاش';
        if (num.startsWith('015')) return 'وي باي';
        if (num.startsWith('010')) return 'فودافون كاش';
        return 'محفظة كاش';
    }

    function isBankTransfer(tx) {
        if (!tx) return false;
        const type = String(tx.transferType || '').trim().toLowerCase();
        const canonical = String(tx.canonicalServiceKey || '').trim().toLowerCase();
        return type === 'bank_account' || type === 'bank_transfer'
            || canonical === 'bank_account' || canonical === 'bank_transfer';
    }

    function bankLabel(tx) {
        const details = tx && tx.serviceDetails ? tx.serviceDetails : {};
        return String((details && details.bankName) || (tx && tx.bankName) || '').trim();
    }

    function accountNumberMarkup(tx) {
        const number = displayValue(tx && (tx.vodafoneNumber || tx.accountNumber));
        const bank = bankLabel(tx);
        const bankLabelHtml = isBankTransfer(tx)
            ? `<div class="fw-bold small mt-1">تحويل بنكي</div>${bank ? `<div class="small text-muted">${escapeHtml(bank)}</div>` : ''}`
            : '';
        return `<div><span class="mono-num" dir="ltr">${escapeHtml(number)}</span>${bankLabelHtml}</div>`;
    }

    function typeLabel(tx) {
        if (!tx) return 'عملية';
        if (tx.transferType === 'balance_transfer') return 'تحويل داخلي';
        if (tx.status === 'deposit' || tx.status === 'deposit_pending') return 'إيداع';
        if (tx.status === 'deduction') return 'خصم';
        if (tx.transferType === 'post_account') return 'حساب بريد';
        if (tx.transferType === 'post_card') return 'بطاقة بريد';
        if (isBankTransfer(tx)) return 'تحويل بنكي';
        if (tx.transferType === 'nita_transfer') return 'سفا للنيجر';
        if (tx.transferType === 'bankak_transfer') return 'بنكك للسودان';
        return cashNetworkLabel(tx.vodafoneNumber || tx.accountNumber);
    }

    function entityName(tx) {
        if (!tx) return EMPTY_NONE;
        if (tx.companyName && tx.companyName !== 'عميل فردي') return tx.companyName;
        return displayValue(tx.employeeName || 'عميل فردي');
    }

    function hasAssignedExecutor(tx) {
        if (!tx) return false;
        if (tx.transferType === 'balance_transfer') return true;
        const name = tx.executorName || tx.assignedExecutorName;
        if (isBlank(name) || name === 'قيد الانتظار') return false;
        return true;
    }

    function executorDisplayName(tx) {
        if (!tx) return EMPTY_UNASSIGNED;
        if (tx.transferType === 'balance_transfer') return 'النظام (تلقائي)';
        if (hasAssignedExecutor(tx)) return String(tx.executorName || tx.assignedExecutorName).trim();
        return EMPTY_UNASSIGNED;
    }

    function formatMoney(value, currency) {
        const amount = Number(value);
        if (!Number.isFinite(amount)) return EMPTY_NONE;
        const formatted = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return currency ? `${formatted} ${currency}` : formatted;
    }

    function exchangeRateValue(tx) {
        if (!tx) return null;
        const explicit = Number(tx.exchangeRate);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        const amount = Number(tx.amount);
        const cost = Number(tx.costLYD);
        if (Number.isFinite(amount) && Number.isFinite(cost) && cost > 0) return amount / cost;
        return null;
    }

    function formatRate(tx) {
        const rate = exchangeRateValue(tx);
        return rate == null ? EMPTY_NONE : Number(rate).toFixed(2);
    }

    function formatDuration(ms) {
        const total = Math.max(0, Math.round(Number(ms) || 0));
        if (total < 60 * 1000) return 'أقل من دقيقة';
        const minutes = Math.floor(total / 60000);
        if (minutes < 60) return `${minutes} د`;
        const hours = Math.floor(minutes / 60);
        const remMin = minutes % 60;
        if (hours < 24) return remMin ? `${hours} س و ${remMin} د` : `${hours} س`;
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        return remHours ? `${days} ي و ${remHours} س` : `${days} ي`;
    }

    function defaultFormatDate(value) {
        if (!value) return EMPTY_NONE;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return EMPTY_NONE;
        return date.toLocaleString('en-GB', { timeZone: 'Africa/Tripoli' }).replace(',', '');
    }

    function collectProofs(tx) {
        const items = [];
        if (!tx || !tx._id) return items;
        const officialReceipt = tx.proofImage || (Array.isArray(tx.proofImages) ? tx.proofImages.find(Boolean) : '');
        if (officialReceipt) {
            items.push({
                kind: 'official',
                label: isBankTransfer(tx) ? 'إثبات التحويل البنكي المرسل للعميل' : 'الإيصال النظامي المرسل للعميل',
                audience: 'عام للعميل',
                url: `/proxy/image/${tx._id}/0`,
                uploader: hasAssignedExecutor(tx) ? String(tx.executorName || tx.assignedExecutorName).trim() : '',
                time: tx.completedAt || (tx.status === 'completed' ? tx.updatedAt : null)
            });
        }
        const executorProofs = Array.isArray(tx.executorProofImages) ? tx.executorProofImages.filter(Boolean) : [];
        const offset = officialReceipt ? 1 : 0;
        executorProofs.forEach((_file, index) => {
            items.push({
                kind: 'executor',
                label: `إثبات المنفذ ${index + 1}`,
                audience: 'للإدارة فقط',
                url: `/proxy/image/${tx._id}/${offset + index}`,
                uploader: hasAssignedExecutor(tx) ? String(tx.executorName || tx.assignedExecutorName).trim() : '',
                time: tx.completedAt || tx.updatedAt || null
            });
        });
        return items;
    }

    function missingItems(tx, proofs) {
        const items = [];
        if (!tx || !PENDING_STATUSES.includes(tx.status)) return items;
        if (tx.status === 'deposit_pending') {
            items.push({ key: 'accept-deposit', label: 'قبول الإيداع' });
            if (!(proofs || []).length) items.push({ key: 'proof', label: 'إثبات' });
            return items;
        }
        if (!hasAssignedExecutor(tx)) items.push({ key: 'assign', label: 'تعيين منفّذ' });
        if (tx.status === 'pending' || tx.status === 'processing') items.push({ key: 'accept', label: 'قبول' });
        if (!(proofs || []).length) items.push({ key: 'proof', label: 'إثبات' });
        return items;
    }

    function humanSummary(tx) {
        if (!tx) return 'لا تتوفر بيانات لهذه العملية.';
        const type = typeLabel(tx);
        const amount = formatMoney(tx.amount, tx.transferType === 'balance_transfer' ? 'د.ل' : 'ج.م');
        const company = entityName(tx);
        const executor = executorDisplayName(tx);
        const status = tx.status;

        if (status === 'completed') {
            return `اكتملت عملية ${type} بقيمة ${amount} من ${company}${executor !== EMPTY_UNASSIGNED ? ` بواسطة ${executor}` : ''}.`;
        }
        if (status === 'accepted') {
            return `عملية ${type} بقيمة ${amount} قيد العمل لدى ${executor}.`;
        }
        if (status === 'processing') {
            const routedTo = executor !== EMPTY_UNASSIGNED ? ` لدى ${executor}` : '';
            const router = !isBlank(tx.routedByAdminName) ? ` وجّهها ${String(tx.routedByAdminName).trim()}.` : '';
            return `عملية ${type} بقيمة ${amount} من ${company} تم توجيهها للتنفيذ${routedTo}.${router}`;
        }
        if (status === 'pending') {
            return `عملية ${type} بقيمة ${amount} من ${company} بانتظار التنفيذ.`;
        }
        if (status === 'deposit_pending') {
            return `طلب إيداع بقيمة ${amount} من ${company} بانتظار اعتماد الإدارة.`;
        }
        if (status === 'deposit') {
            const actor = !isBlank(tx.performedByAdminName) ? ` أودعها ${String(tx.performedByAdminName).trim()}.` : '';
            return `تم اعتماد إيداع بقيمة ${amount} لصالح ${company}.${actor}`;
        }
        if (status === 'deduction') {
            const actor = !isBlank(tx.performedByAdminName) ? ` خصمها ${String(tx.performedByAdminName).trim()}.` : '';
            return `تم تسجيل خصم بقيمة ${amount} على ${company}.${actor}`;
        }
        if (status === 'rejected' || status === 'cancelled_by_admin') {
            return `أُلغيت عملية ${type} بقيمة ${amount} الخاصة بـ ${company}.`;
        }
        return `عملية ${type} بقيمة ${amount} من ${company}.`;
    }

    function buildTimeline(tx, formatDate) {
        const fmt = formatDate || defaultFormatDate;
        const events = [];
        if (!tx) return events;
        const seen = new Set();

        const pushEvent = (key, title, at, actor, tone) => {
            if (!at) return;
            const date = new Date(at);
            if (Number.isNaN(date.getTime())) return;
            const stamp = `${key}:${date.getTime()}`;
            if (seen.has(stamp)) return;
            seen.add(stamp);
            events.push({
                key,
                title,
                at,
                atLabel: fmt(at),
                actor: displayValue(actor, 'unassigned'),
                ts: date.getTime(),
                tone: tone || 'neutral'
            });
        };

        const creator = tx.employeeName || tx.companyName || 'العميل';
        const executor = tx.executorName || tx.assignedExecutorName;
        pushEvent('created', 'إنشاء الطلب', tx.createdAt, creator, 'neutral');
        if (!isBlank(tx.routedByAdminName)) {
            pushEvent('routed', 'توجيه العملية', tx.routedAt || tx.executorReceivedAt || tx.updatedAt, tx.routedByAdminName, 'progress');
        }
        pushEvent('assigned', 'تعيين المنفّذ', tx.assignedExecutorAt, tx.assignedExecutorName || executor, 'progress');
        pushEvent('received', 'وصول العملية للمنفّذ', tx.executorReceivedAt, executor, 'progress');

        if ((tx.status === 'processing' || tx.status === 'accepted') && !tx.assignedExecutorAt && !tx.executorReceivedAt) {
            pushEvent('accepted', tx.status === 'processing' ? 'توجيه العملية' : 'قبول العملية', tx.updatedAt, executor || 'النظام', 'progress');
        }

        if (tx.completedAt) {
            pushEvent('completed', 'الإكمال النهائي', tx.completedAt, executor || 'النظام', 'success');
        } else if (tx.status === 'completed') {
            pushEvent('completed', 'الإكمال النهائي', tx.updatedAt, executor || 'النظام', 'success');
        }

        if (tx.cancelledAt) {
            pushEvent('cancelled', 'إلغاء / رفض العملية', tx.cancelledAt, tx.cancelledBy || 'الإدارة', 'fail');
        } else if (FAIL_STATUSES.includes(tx.status)) {
            pushEvent('cancelled', 'إلغاء / رفض العملية', tx.updatedAt, tx.cancelledBy || 'الإدارة', 'fail');
        }
        if ((tx.status === 'deposit' || tx.status === 'deduction') && !isBlank(tx.performedByAdminName)) {
            pushEvent('performed', tx.status === 'deduction' ? 'تسجيل الخصم' : 'تسجيل الإيداع', tx.performedByAdminAt || tx.createdAt, tx.performedByAdminName, 'success');
        }

        events.sort((a, b) => a.ts - b.ts);
        const unique = events;

        unique.forEach((event, index) => {
            const prev = unique[index - 1];
            if (prev) event.waitFromPrevious = formatDuration(event.ts - prev.ts);
        });

        if (PENDING_STATUSES.includes(tx.status) && unique.length) {
            const last = unique[unique.length - 1];
            const now = Date.now();
            unique.push({
                key: 'waiting',
                title: tx.status === 'accepted' ? 'ما زالت قيد العمل' : 'ما زالت معلّقة',
                at: null,
                atLabel: 'الآن',
                actor: executorDisplayName(tx),
                ts: now,
                tone: 'pending',
                waitFromPrevious: formatDuration(now - last.ts)
            });
        }

        return unique;
    }

    function extractReference(noteView, tx) {
        const explicit = tx && tx.settlementDetails && tx.settlementDetails.externalReference;
        if (!isBlank(explicit)) return String(explicit).trim();
        const text = String((noteView && noteView.customerText) || '');
        const match = text.match(/(?:الرقم المرجعي|رقم مرجعي|مرجع|reference|ref)\s*[:：-]?\s*(\S+)/i);
        return match ? match[1] : '';
    }

    function financeRows(tx, ledgerInfo) {
        const rows = [];
        if (!tx) return rows;
        const isBalance = tx.transferType === 'balance_transfer';
        const amountCurrency = isBalance ? 'LYD' : 'EGP';
        const amountTone = tx.status === 'deduction' ? 'neg' : 'pos';
        rows.push({ label: isBalance ? 'المبلغ المحول' : 'المبلغ', value: formatMoney(tx.amount, amountCurrency), tone: amountTone });
        if (!isBalance && tx.status !== 'deposit' && tx.status !== 'deduction') {
            rows.push({ label: 'سعر الصرف', value: formatRate(tx), tone: 'rate' });
            rows.push({ label: 'التكلفة', value: Number(tx.costLYD) ? formatMoney(tx.costLYD, 'LYD') : EMPTY_NONE, tone: 'neg' });
        }
        const commission = Number(tx.commission || tx.masterProfit || (tx.agencyPricing && tx.agencyPricing.profitLYD));
        if (Number.isFinite(commission) && commission !== 0) {
            rows.push({ label: 'العمولة / الربح', value: formatMoney(commission, 'LYD'), tone: 'pos' });
        }
        if (Number(tx.subAccountCostLYD)) {
            rows.push({ label: 'تكلفة الحساب الفرعي', value: formatMoney(tx.subAccountCostLYD, 'LYD'), tone: 'neg' });
        }
        const pricing = tx.agencyPricing || {};
        if (Number(pricing.customerChargeLYD)) {
            rows.push({ label: 'تحصيل العميل', value: formatMoney(pricing.customerChargeLYD, 'LYD'), tone: 'neg' });
        }
        if (Number(pricing.agentCostLYD)) {
            rows.push({ label: 'تكلفة الوكيل', value: formatMoney(pricing.agentCostLYD, 'LYD'), tone: 'neg' });
        }
        (ledgerInfo || []).forEach((item) => {
            const amount = Number(item.amount || 0);
            rows.push({
                label: `${item.type || 'قيد مالي'}${item.description ? ` — ${item.description}` : ''}`,
                value: formatMoney(amount, 'LYD'),
                tone: amount < 0 ? 'neg' : 'pos'
            });
        });
        return rows;
    }

    function defaultTab(tx, proofs) {
        if (!tx) return 'summary';
        if (tx.status === 'completed' && (proofs || []).length) return 'proofs';
        if (PROGRESS_STATUSES.includes(tx.status)) return 'summary';
        return 'summary';
    }

    function emphasisCopy(tx, proofs) {
        if (!tx) return '';
        const tone = statusTone(tx.status);
        if (tone === 'pending') return 'هذه العملية معلّقة — راجع العناصر الناقصة أدناه قبل الإغلاق.';
        if (tone === 'progress') {
            const lastUpdate = tx.updatedAt || tx.executorReceivedAt || tx.assignedExecutorAt;
            const when = lastUpdate ? defaultFormatDate(lastUpdate) : EMPTY_NONE;
            return `العملية قيد التنفيذ لدى ${executorDisplayName(tx)} — آخر تحديث: ${when}.`;
        }
        if (tone === 'success') {
            const proofNote = (proofs || []).length ? 'الإثباتات جاهزة للمعاينة.' : 'لا يوجد إثبات مرفق بعد.';
            return `العملية مكتملة. ${proofNote} يمكن إصدار الفاتورة مباشرة.`;
        }
        if (tone === 'fail') return 'العملية ملغاة أو مرفوضة، وتمت تسوية الأرصدة المرتبطة إن وُجدت.';
        return '';
    }

    function buildViewModel(tx, options) {
        const opts = options || {};
        const formatDate = opts.formatDate || defaultFormatDate;
        const noteView = opts.noteView || { customerText: '', systemText: '' };
        const proofs = collectProofs(tx);
        const missing = missingItems(tx, proofs);
        const timeline = buildTimeline(tx, formatDate);
        const status = statusMeta(tx && tx.status);
        const tone = statusTone(tx && tx.status);
        const amountCurrency = tx && tx.transferType === 'balance_transfer' ? 'LYD' : 'EGP';
        return {
            tx: tx || {},
            opNumber: displayValue(tx && (tx.customId || tx._id)),
            status,
            tone,
            amount: formatMoney(tx && tx.amount, amountCurrency),
            costLYD: Number(tx && tx.costLYD) ? formatMoney(tx.costLYD, 'LYD') : EMPTY_NONE,
            rate: formatRate(tx),
            company: entityName(tx),
            executor: executorDisplayName(tx),
            type: typeLabel(tx),
            humanSummary: humanSummary(tx),
            missingItems: missing,
            proofs,
            timeline,
            finance: financeRows(tx, opts.ledgerInfo),
            notes: {
                customer: displayValue(noteView.customerText),
                reference: displayValue(extractReference(noteView, tx)),
                internal: displayValue(noteView.systemText || (tx && tx.adminNotes))
            },
            defaultTab: defaultTab(tx, proofs),
            emphasis: emphasisCopy(tx, proofs),
            ledgerInfo: opts.ledgerInfo || null,
            balanceTransferPair: opts.balanceTransferPair || null,
            allBotsMap: opts.allBotsMap || {},
            executorBots: opts.executorBots || [],
            formatDate
        };
    }

    function metricCard(label, value, extraClass) {
        return `<div class="od-metric ${extraClass || ''}"><span class="od-metric-label">${escapeHtml(label)}</span><span class="od-metric-value">${value}</span></div>`;
    }

    function kvRow(label, valueHtml, extraClass) {
        return `<div class="od-kv ${extraClass || ''}"><span class="od-kv-label">${escapeHtml(label)}</span><span class="od-kv-value">${valueHtml}</span></div>`;
    }

    function copyButton(value) {
        if (isBlank(value) || value === EMPTY_NONE || value === EMPTY_UNASSIGNED) return '';
        return `<button type="button" class="od-icon-btn" data-copy="${escapeHtml(value)}" title="نسخ" aria-label="نسخ"><i class="fa-regular fa-copy"></i></button>`;
    }

    function renderHeaderMeta(model) {
        const status = model.status;
        return `
            <div class="od-header-chips">
                <span class="badge-st ${status.badgeClass}"><i class="fa-solid ${status.icon}"></i> ${escapeHtml(status.label)}</span>
                <span class="od-chip od-chip-type">${escapeHtml(model.type)}</span>
                <span class="od-chip od-chip-amount pos">${escapeHtml(model.amount)}</span>
                <span class="od-chip od-chip-cost neg">${escapeHtml(model.costLYD)}</span>
                <span class="od-chip od-chip-rate">سعر ${escapeHtml(model.rate)}</span>
                <span class="od-chip">${escapeHtml(model.company)}</span>
                <span class="od-chip od-executor-chip">المنفّذ: ${escapeHtml(model.executor)}</span>
            </div>
        `;
    }

    function renderMissing(model) {
        if (!model.missingItems.length) return '';
        const chips = model.missingItems.map((item) => (
            `<span class="od-missing-chip" data-missing="${escapeHtml(item.key)}"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(item.label)}</span>`
        )).join('');
        return `<div class="od-missing" id="od-missing-items"><div class="od-missing-title">ما ينقص لإكمال العملية</div><div class="od-missing-list">${chips}</div></div>`;
    }

    function renderBotEditor(model) {
        const tx = model.tx;
        if (!tx || tx.transferType === 'balance_transfer' || tx.status === 'deposit' || tx.status === 'deduction' || tx.status === 'deposit_pending') {
            return '';
        }
        const currentName = tx.executorBotName || (tx.executorBotId ? (model.allBotsMap[tx.executorBotId] || EMPTY_NONE) : EMPTY_UNASSIGNED);
        const botOptions = (model.executorBots || [])
            .filter((bot) => (bot.supportedTransferTypes || ['vodafone']).includes(tx.transferType || 'vodafone'))
            .map((bot) => `<option value="${escapeHtml(bot._id)}">${escapeHtml(bot.name)} - ${escapeHtml(bot.serviceLabel || '')}</option>`)
            .join('');
        const canMove = tx.status === 'completed' && tx.executorBotId;
        return `
            <div class="od-bot-row">
                <div class="d-flex align-items-center gap-2 flex-wrap">
                    <strong>${escapeHtml(displayValue(currentName, 'unassigned'))}</strong>
                    ${canMove ? `<button type="button" class="btn btn-sm btn-outline-warning py-0 px-2 fw-bold" onclick="document.getElementById('m_bot_edit_form').style.display='block'; this.style.display='none';"><i class="fa-solid fa-right-left"></i> نقل</button>` : ''}
                </div>
                <div id="m_bot_edit_form" style="display:none; margin-top: 8px;">
                    <form method="POST" action="/transaction/${escapeHtml(tx._id)}/change-bot" onsubmit="return confirm('سيتم نقل العملية وتعديل أرصدة البوتات والوكلاء محاسبياً. هل أنت متأكد؟')">
                        <div class="input-group input-group-sm">
                            <button type="submit" class="btn btn-success border-0 px-2"><i class="fa-solid fa-check"></i></button>
                            <select name="newGroupId" class="form-select border-0 fw-bold text-end" required>
                                <option value="">- اختر بوت -</option>
                                ${botOptions}
                            </select>
                        </div>
                    </form>
                </div>
            </div>
        `;
    }

    function renderBalanceTransfer(model) {
        const tx = model.tx;
        const pairInfo = model.balanceTransferPair || {};
        const ledgerInfo = model.ledgerInfo;
        const source = pairInfo.source || {};
        const target = pairInfo.target || {};
        const senderLedger = ledgerInfo ? ledgerInfo.find((item) => item.amount < 0) : null;
        const receiverLedger = ledgerInfo ? ledgerInfo.find((item) => item.amount > 0) : null;
        const sourceName = source.name || tx.accountName || tx.employeeName || EMPTY_NONE;
        const sourceCode = source.code || tx.accountNumber || tx.vodafoneNumber || EMPTY_NONE;
        const targetName = target.name || EMPTY_NONE;
        const targetCode = target.code || EMPTY_NONE;
        const transferId = pairInfo.transferId || String(tx.customId || '').replace(/-[CD]$/, '');
        const fmt = model.formatDate;
        return `
            <div class="od-transfer">
                <div class="od-transfer-flow">
                    <div class="od-transfer-node">
                        <div class="small text-muted fw-bold mb-1">المرسل</div>
                        <div class="fw-bold text-danger fs-5">${escapeHtml(sourceName)}</div>
                        <div class="mono-num text-muted mt-1">${escapeHtml(sourceCode)}</div>
                    </div>
                    <div class="od-transfer-arrow"><i class="fa-solid fa-circle-arrow-left"></i></div>
                    <div class="od-transfer-node">
                        <div class="small text-muted fw-bold mb-1">المستقبل</div>
                        <div class="fw-bold text-success fs-5">${escapeHtml(targetName)}</div>
                        <div class="mono-num text-muted mt-1">${escapeHtml(targetCode)}</div>
                    </div>
                </div>
                <div class="text-center mt-3">
                    <div class="small text-muted fw-bold">المبلغ المحول</div>
                    <div class="od-transfer-amount pos">${escapeHtml(formatMoney(tx.amount, 'LYD'))}</div>
                    ${model.proofs.length ? '<button type="button" class="btn btn-success fw-bold rounded-pill px-4 mt-3" data-od-tab="proofs"><i class="fa-solid fa-receipt me-1"></i> عرض إيصال التحويل</button>' : ''}
                </div>
                <div class="row g-3 mt-1">
                    <div class="col-md-6">
                        <div class="od-balance-card neg">
                            <div class="fw-bold text-danger mb-2"><i class="fa-solid fa-wallet me-1"></i> رصيد المرسل</div>
                            ${kvRow('قبل العملية', escapeHtml(Number.isFinite(Number(source.balanceBefore ?? senderLedger?.balanceBefore)) ? formatMoney(source.balanceBefore ?? senderLedger?.balanceBefore, 'LYD') : EMPTY_NONE))}
                            ${kvRow('بعد العملية', escapeHtml(Number.isFinite(Number(source.balanceAfter ?? senderLedger?.balanceAfter)) ? formatMoney(source.balanceAfter ?? senderLedger?.balanceAfter, 'LYD') : EMPTY_NONE))}
                        </div>
                    </div>
                    <div class="col-md-6">
                        <div class="od-balance-card pos">
                            <div class="fw-bold text-success mb-2"><i class="fa-solid fa-wallet me-1"></i> رصيد المستقبل</div>
                            ${kvRow('قبل العملية', escapeHtml(Number.isFinite(Number(target.balanceBefore ?? receiverLedger?.balanceBefore)) ? formatMoney(target.balanceBefore ?? receiverLedger?.balanceBefore, 'LYD') : EMPTY_NONE))}
                            ${kvRow('بعد العملية', escapeHtml(Number.isFinite(Number(target.balanceAfter ?? receiverLedger?.balanceAfter)) ? formatMoney(target.balanceAfter ?? receiverLedger?.balanceAfter, 'LYD') : EMPTY_NONE))}
                        </div>
                    </div>
                </div>
                ${kvRow('رقم عملية الخصم', `<span class="mono-num">${escapeHtml(source.customId || `${transferId}-D`)}</span>`)}
                ${kvRow('رقم عملية الإيداع', `<span class="mono-num">${escapeHtml(target.customId || `${transferId}-C`)}</span>`)}
                ${kvRow('تاريخ العملية', escapeHtml(fmt(tx.createdAt)))}
            </div>
        `;
    }

    function renderCancellation(tx, formatDate) {
        if (!tx || !FAIL_STATUSES.includes(tx.status)) return '';
        const meta = [
            tx.cancellationNumber ? `رقم الإلغاء: ${tx.cancellationNumber}` : '',
            tx.cancelledBy ? `بواسطة: ${tx.cancelledBy}` : '',
            tx.cancelledAt ? `تاريخ الإلغاء: ${formatDate(tx.cancelledAt)}` : ''
        ].filter(Boolean).join(' · ');
        return `
            <div class="od-alert od-alert-fail">
                <div class="fs-2 text-danger"><i class="fa-solid fa-circle-xmark"></i></div>
                <div>
                    <h6 class="fw-bold m-0 text-danger">هذه العملية ملغية / مرفوضة</h6>
                    <div class="small fw-bold text-muted mt-1">تم إرجاع كافة الأرصدة والمديونيات المرتبطة بالعملية تلقائياً.</div>
                    ${meta ? `<div class="small fw-bold mt-2">${escapeHtml(meta)}</div>` : ''}
                    ${tx.cancellationReason ? `<div class="small text-muted mt-1">السبب: ${escapeHtml(tx.cancellationReason)}</div>` : ''}
                </div>
            </div>
        `;
    }

    function renderSummaryPane(model) {
        const tx = model.tx;
        const isBalance = tx.transferType === 'balance_transfer';
        const isDepositOrDeduction = (tx.status === 'deposit' || tx.status === 'deduction' || tx.status === 'deposit_pending') && !isBalance;
        let body = '';
        if (isBalance) {
            body = renderBalanceTransfer(model);
        } else if (isDepositOrDeduction) {
            const typeLabelText = tx.status === 'deposit' ? 'إيداع (سداد رصيد للعميل)' : tx.status === 'deposit_pending' ? 'طلب إيداع معلق' : 'خصم رصيد (تسوية)';
            body = `
                <div class="od-settle">
                    <div class="od-settle-amount ${tx.status === 'deduction' ? 'neg' : 'pos'}">${escapeHtml(formatMoney(tx.amount, 'EGP'))}</div>
                    <div class="badge-st ${model.status.badgeClass} mt-2">${escapeHtml(typeLabelText)}</div>
                    ${kvRow('الجهة / العميل المستهدف', escapeHtml(model.company))}
                    ${kvRow('الموظف المنفذ', escapeHtml(displayValue(tx.employeeName, 'unassigned')))}
                    ${!isBlank(tx.performedByAdminName) ? kvRow(tx.status === 'deduction' ? 'خصمها' : 'أودعها', escapeHtml(tx.performedByAdminName)) : ''}
                    ${kvRow('رقم العملية المالي', `<span class="mono-num">${escapeHtml(model.opNumber)}</span>`)}
                    ${kvRow('تاريخ التسجيل', escapeHtml(model.formatDate(tx.createdAt)))}
                </div>
            `;
        } else {
            const bank = bankLabel(tx);
            const recipient = tx.accountName && tx.transferType !== 'vodafone'
                ? `<div class="od-note-card"><div class="od-section-title"><i class="fa-solid fa-address-card"></i> ${isBankTransfer(tx) ? 'بيانات المستفيد' : 'بيانات مستلم البريد'}</div><div>${escapeHtml(tx.accountName)}</div>${bank ? `<div class="small text-muted mt-1">البنك: ${escapeHtml(bank)}</div>` : ''}</div>`
                : (isBankTransfer(tx) && bank
                    ? `<div class="od-note-card"><div class="od-section-title"><i class="fa-solid fa-building-columns"></i> البنك</div><div>${escapeHtml(bank)}</div></div>`
                    : '');
            body = `
                <div class="od-summary-grid">
                    ${metricCard('رقم العملية', `<span class="mono-num">${escapeHtml(model.opNumber)}</span>${copyButton(tx.customId || tx._id)}`)}
                    ${metricCard('المبلغ', escapeHtml(model.amount), 'pos')}
                    ${metricCard('التكلفة', escapeHtml(model.costLYD), 'neg')}
                    ${metricCard('سعر الصرف', escapeHtml(model.rate), 'rate')}
                    ${metricCard('الرقم / الحساب', accountNumberMarkup(tx))}
                    ${metricCard('المنفّذ', escapeHtml(model.executor), 'od-executor-chip')}
                    ${!isBlank(tx.routedByAdminName) ? metricCard('وجّهها', escapeHtml(tx.routedByAdminName)) : ''}
                </div>
                ${recipient}
            `;
        }
        return `${renderCancellation(tx, model.formatDate)}${body}`;
    }

    function renderPartiesPane(model) {
        const tx = model.tx;
        const executionNumber = tx.executorExecutionNumber || tx.executorSenderPhone || tx.executorExecutionNumberMasked;
        return `
            <div class="od-stack">
                ${kvRow('الجهة / الشركة', escapeHtml(model.company))}
                ${kvRow('الموظف الطالب', escapeHtml(displayValue(tx.employeeName, 'unassigned')))}
                ${kvRow('المنفّذ', escapeHtml(model.executor), 'od-executor-chip')}
                ${!isBlank(tx.routedByAdminName) ? kvRow('وجّهها', escapeHtml(tx.routedByAdminName)) : ''}
                ${kvRow('مجموعة التنفيذ', escapeHtml(displayValue(tx.executorGroupName, 'unassigned')))}
                ${kvRow('بوت التنفيذ', renderBotEditor(model) || escapeHtml(EMPTY_UNASSIGNED))}
                ${kvRow('نوع التحويل', escapeHtml(model.type))}
                ${kvRow('الرقم / الحساب', `<div class="d-inline-flex flex-column align-items-start">${accountNumberMarkup(tx)}${copyButton(tx.vodafoneNumber || tx.accountNumber)}</div>`)}
                ${tx.accountName ? kvRow('اسم المستلم / الحساب', escapeHtml(tx.accountName)) : kvRow('اسم المستلم / الحساب', escapeHtml(EMPTY_NONE))}
                ${isBankTransfer(tx) ? kvRow('البنك', escapeHtml(bankLabel(tx) || EMPTY_NONE)) : ''}
                ${executionNumber ? kvRow('رقم التنفيذ', `<span class="mono-num d-inline-flex align-items-center gap-2" dir="ltr">${escapeHtml(executionNumber)}${copyButton(executionNumber)}</span>`) : kvRow('رقم التنفيذ', escapeHtml(EMPTY_NONE))}
            </div>
        `;
    }

    function renderFinancePane(model) {
        if (!model.finance.length) {
            return `<div class="od-empty">لا توجد بيانات مالية إضافية.</div>`;
        }
        return `<div class="od-finance">${model.finance.map((row) => kvRow(row.label, escapeHtml(row.value), row.tone)).join('')}</div>`;
    }

    function proofMeta(item, formatDate) {
        const bits = [];
        if (!isBlank(item.uploader) && item.uploader !== EMPTY_NONE && item.uploader !== EMPTY_UNASSIGNED) bits.push(item.uploader);
        if (item.time) bits.push(formatDate(item.time));
        return bits.length ? `<div class="od-proof-meta">${bits.map((bit) => escapeHtml(bit)).join(' · ')}</div>` : '';
    }

    function renderProofsPane(model) {
        if (!model.proofs.length) {
            return `
                <div class="od-empty od-empty-proofs" id="od-proofs-gallery">
                    <i class="fa-solid fa-image"></i>
                    <strong>لم يتم إرفاق إثبات تنفيذ بعد</strong>
                    <span>ستظهر هنا صور الإيصال النظامي وإثباتات المنفذ عند توفرها.</span>
                </div>
            `;
        }
        const cards = model.proofs.map((item, index) => `
            <button type="button" class="od-proof-card" data-od-lightbox="${escapeHtml(item.url)}" data-od-caption="${escapeHtml(item.label)}" aria-label="${escapeHtml(item.label)}">
                <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.label)}" loading="${index === 0 ? 'eager' : 'lazy'}">
                <div class="od-proof-caption">
                    <strong>${escapeHtml(item.label)}</strong>
                    <span class="od-proof-audience">${escapeHtml(item.audience)}</span>
                    ${proofMeta(item, model.formatDate)}
                </div>
            </button>
        `).join('');
        return `<div class="od-proofs-gallery" id="od-proofs-gallery">${cards}</div>`;
    }

    function renderTimelinePane(model) {
        if (!model.timeline.length) {
            return `<div class="od-empty">لا توجد أحداث زمنية مسجّلة لهذه العملية.</div>`;
        }
        const items = model.timeline.map((event) => `
            <div class="od-tl-item od-tl-${event.tone}">
                <div class="od-tl-title">${escapeHtml(event.title)}</div>
                <div class="od-tl-actor">${escapeHtml(event.actor)}</div>
                <div class="od-tl-time mono-num">${escapeHtml(event.atLabel)}</div>
                ${event.waitFromPrevious ? `<div class="od-tl-wait">المدة منذ الحدث السابق: ${escapeHtml(event.waitFromPrevious)}</div>` : ''}
            </div>
        `).join('');
        return `<div class="od-timeline" id="od-timeline">${items}</div>`;
    }

    function renderNotesPane(model) {
        const noteBlock = (title, value) => `
            <div class="od-note-card">
                <div class="od-section-title">${escapeHtml(title)}</div>
                <div class="od-note-body">${escapeHtml(value)}</div>
            </div>
        `;
        return `
            <div class="od-stack">
                ${noteBlock('ملاحظة العميل', model.notes.customer)}
                ${noteBlock('الرقم المرجعي', model.notes.reference)}
                ${noteBlock('الملاحظات الداخلية', model.notes.internal)}
            </div>
        `;
    }

    function activateTab(root, tabId) {
        if (!root) return;
        root.querySelectorAll('[data-od-tab]').forEach((btn) => {
            const active = btn.getAttribute('data-od-tab') === tabId;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        root.querySelectorAll('[data-od-pane]').forEach((pane) => {
            pane.hidden = pane.getAttribute('data-od-pane') !== tabId;
        });
    }

    function openLightbox(url, caption) {
        const box = document.getElementById('od-lightbox');
        if (!box) return;
        if (typeof document !== 'undefined' && box.parentElement !== document.body) {
            document.body.appendChild(box);
        }
        const img = box.querySelector('img');
        const cap = box.querySelector('.od-lightbox-caption');
        if (img) img.src = url;
        if (cap) cap.textContent = caption || '';
        box.hidden = false;
        box.setAttribute('aria-hidden', 'false');
    }

    function closeLightbox() {
        const box = document.getElementById('od-lightbox');
        if (!box) return;
        box.hidden = true;
        box.setAttribute('aria-hidden', 'true');
        const img = box.querySelector('img');
        if (img) img.removeAttribute('src');
    }

    async function copyText(value, button) {
        const text = String(value || '');
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            if (button) {
                const original = button.innerHTML;
                button.innerHTML = '<i class="fa-solid fa-check"></i>';
                setTimeout(() => { button.innerHTML = original; }, 1200);
            }
        } catch (_) {}
    }

    function attachLightboxUi() {
        if (typeof document === 'undefined' || document.documentElement.dataset.odLightbox === '1') return;
        document.documentElement.dataset.odLightbox = '1';
        const box = document.getElementById('od-lightbox');
        if (box) {
            box.addEventListener('click', (event) => {
                if (event.target === box || event.target.closest('#od-lightbox-close')) closeLightbox();
            });
        }
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeLightbox();
        });
    }

    function ensureDelegated(root) {
        if (!root || root.dataset.odBound === '1') return;
        root.dataset.odBound = '1';
        root.addEventListener('click', (event) => {
            const tabBtn = event.target.closest('[data-od-tab]');
            if (tabBtn && root.contains(tabBtn)) {
                activateTab(root, tabBtn.getAttribute('data-od-tab'));
                return;
            }
            const copyBtn = event.target.closest('[data-copy]');
            if (copyBtn && root.contains(copyBtn)) {
                copyText(copyBtn.getAttribute('data-copy'), copyBtn);
                return;
            }
            const copyOp = event.target.closest('#od-copy-id');
            if (copyOp && root.contains(copyOp)) {
                copyText(copyOp.getAttribute('data-copy-value'), copyOp);
                return;
            }
            const lightboxBtn = event.target.closest('[data-od-lightbox]');
            if (lightboxBtn && root.contains(lightboxBtn)) {
                openLightbox(lightboxBtn.getAttribute('data-od-lightbox'), lightboxBtn.getAttribute('data-od-caption'));
            }
        });
    }

    function bind(root, model) {
        attachLightboxUi();
        ensureDelegated(root);
        const copyOp = root.querySelector('#od-copy-id');
        if (copyOp) copyOp.setAttribute('data-copy-value', model.tx.customId || model.tx._id || '');
        const printBtn = root.querySelector('#od-print-invoice');
        if (printBtn) printBtn.classList.toggle('od-invoice-emphasis', model.tone === 'success');
        activateTab(root, model.defaultTab);
    }

    function mount(root, payload) {
        const model = buildViewModel(payload.tx, payload);
        const loading = root.querySelector('#od-loading');
        const content = root.querySelector('#od-content');
        if (loading) loading.hidden = true;
        if (content) content.hidden = false;

        root.classList.remove('od-is-pending', 'od-is-progress', 'od-is-success', 'od-is-fail');
        root.classList.add(`od-is-${model.tone}`);

        const opNumber = root.querySelector('#od-op-number');
        if (opNumber) opNumber.textContent = model.opNumber;

        const headerMeta = root.querySelector('#od-header-meta');
        if (headerMeta) headerMeta.innerHTML = renderHeaderMeta(model);

        const summary = root.querySelector('#od-human-summary');
        if (summary) summary.textContent = model.humanSummary;

        const missingHost = root.querySelector('#od-missing-host');
        if (missingHost) missingHost.innerHTML = renderMissing(model);

        const emphasis = root.querySelector('#od-emphasis');
        if (emphasis) {
            emphasis.textContent = model.emphasis;
            emphasis.hidden = !model.emphasis;
            emphasis.className = `od-emphasis od-emphasis-${model.tone}`;
        }

        const panes = {
            summary: renderSummaryPane(model),
            parties: renderPartiesPane(model),
            finance: renderFinancePane(model),
            proofs: renderProofsPane(model),
            timeline: renderTimelinePane(model),
            notes: renderNotesPane(model)
        };
        Object.keys(panes).forEach((key) => {
            const pane = root.querySelector(`[data-od-pane="${key}"]`);
            if (pane) pane.innerHTML = panes[key];
        });

        bind(root, model);
        return model;
    }

    function showLoading(root) {
        const loading = root.querySelector('#od-loading');
        const content = root.querySelector('#od-content');
        if (loading) loading.hidden = false;
        if (content) content.hidden = true;
        const headerMeta = root.querySelector('#od-header-meta');
        if (headerMeta) headerMeta.innerHTML = '';
        const opNumber = root.querySelector('#od-op-number');
        if (opNumber) opNumber.textContent = '…';
    }

    return {
        EMPTY_NONE,
        EMPTY_UNASSIGNED,
        escapeHtml,
        isBlank,
        displayValue,
        statusMeta,
        statusTone,
        typeLabel,
        entityName,
        hasAssignedExecutor,
        executorDisplayName,
        formatMoney,
        formatRate,
        formatDuration,
        collectProofs,
        missingItems,
        humanSummary,
        buildTimeline,
        extractReference,
        financeRows,
        defaultTab,
        buildViewModel,
        renderHeaderMeta,
        renderSummaryPane,
        renderPartiesPane,
        renderProofsPane,
        activateTab,
        openLightbox,
        closeLightbox,
        copyText,
        mount,
        showLoading
    };
}));
