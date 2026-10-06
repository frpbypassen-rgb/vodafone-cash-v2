/* exported showTaskBoardStatus, hideTaskBoardStatus, renderTaskLoadFallback, refreshTasks */
function showTaskBoardStatus(message, options) {
    const el = document.getElementById('taskBoardStatus');
    if (!el) return;
    const offline = Boolean(options && options.offline);
    el.hidden = false;
    el.className = 'executor-board-status' + (offline ? ' is-offline' : ' is-error');
    el.setAttribute('role', 'alert');
    el.innerHTML = `<i class="fa-solid ${offline ? 'fa-wifi' : 'fa-triangle-exclamation'}" aria-hidden="true"></i><span>${escapeTaskHtml(message)}</span><button type="button" class="executor-board-retry" onclick="refreshTasks()">إعادة المحاولة</button>`;
}

function hideTaskBoardStatus() {
    const el = document.getElementById('taskBoardStatus');
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
}

function renderTaskLoadFallback(message) {
    const container = document.getElementById('tasksList');
    if (!container || container.querySelector('.task-card')) return;
    container.innerHTML = `<div class="col-12"><div class="executor-board-fallback" role="alert"><p>${escapeTaskHtml(message)}</p><button type="button" class="executor-board-retry" onclick="refreshTasks()">إعادة المحاولة</button></div></div>`;
}

async function refreshTasks() {
    if (document.hidden) return;
    const requestId = ++liveTasksRequestId;
    try {
        const profileVisible = document.getElementById('profileSection')?.style.display !== 'none';
        const liveTasksUrl = profileVisible
            ? '/executor-portal/api/live-tasks'
            : '/executor-portal/api/live-tasks?lite=1';
        const res = await executorApiFetch(liveTasksUrl);
        const data = await readExecutorApiResponse(res);
        if (requestId !== liveTasksRequestId) return;
        hideTaskBoardStatus();
        const nextPollSeconds = Number(data.pollIntervalSeconds);
        if (Number.isFinite(nextPollSeconds) && nextPollSeconds >= 5 && nextPollSeconds <= 30) {
            liveTasksPollMs = nextPollSeconds * 1000;
        }
        manualTaskRoutingEnabled = Boolean(data.manualTaskRoutingEnabled);
        renderManualRoutingControl();
        if (data.executionPolicy) {
            executorManualPolicy = {
                proofRequired: Boolean(data.executionPolicy.proofRequired),
                quickExecuteEnabled: Boolean(data.executionPolicy.quickExecuteEnabled),
                allowedPhoneLengths: Array.isArray(data.executionPolicy.allowedPhoneLengths)
                    ? data.executionPolicy.allowedPhoneLengths
                    : executorManualPolicy.allowedPhoneLengths || [3, 4, 11],
                splitRequiresFullPhone: data.executionPolicy.splitRequiresFullPhone !== false,
            };
            if (typeof updateProofRequirement === 'function') updateProofRequirement();
        }
        if (data.quickExecute) {
            executorQuickExecute = {
                enabled: data.quickExecute.enabled === true,
                network: data.quickExecute.network || 'vodafone',
                pinRequired: data.quickExecute.pinRequired === true,
                pinSet: data.quickExecute.pinSet === true,
            };
        }

        // 📊 تحديث إحصائيات المعاملات المنجزة اليوم في صفحة حسابي
        if (data.completedToday) {
            const summary = data.completedTodaySummary || {};
            const hasServerSummary = Number.isFinite(Number(summary.amount));
            const count = Number.isFinite(Number(summary.count))
                ? Number(summary.count)
                : data.completedToday.length;
            let sum = hasServerSummary ? Number(summary.amount) : 0;
            let listHtml = '';

            data.completedToday.forEach((tx) => {
                const txAmt = parseFloat(tx.amount) || 0;
                if (!hasServerSummary) sum += txAmt;

                const typeMeta = taskTypeMeta(tx.transferType);
                const typeBadge = `<span class="badge bg-warning bg-opacity-10 text-warning border border-warning border-opacity-25" style="font-size: 0.72rem;"><i class="fa-solid ${typeMeta.icon} me-1"></i> ${typeMeta.short}</span>`;

                const timeStr = tx.updatedAt
                    ? new Date(tx.updatedAt).toLocaleTimeString('ar-LY', {
                          timeZone: 'Africa/Tripoli',
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                      })
                    : '---';

                listHtml += `
                        <div class="d-flex justify-content-between align-items-center p-2.5 rounded-3 border mb-1" style="background: rgba(128,128,128,0.03); border-color: var(--glass-border) !important;">
                            <div class="d-flex align-items-center gap-2">
                                <div class="rounded-circle d-flex align-items-center justify-content-center" style="width: 32px; height: 32px; background: rgba(16, 185, 129, 0.1); color: var(--accent-green);">
                                    <i class="fa-solid fa-check" style="font-size: 0.85rem;"></i>
                                </div>
                                <div>
                                    <div class="d-flex align-items-center gap-2 flex-wrap">
                                        <span class="fw-bold text-main" style="font-size: 0.85rem;">#${escapeTaskHtml(tx.customId)}</span>
                                        ${typeBadge}
                                    </div>
                                    <small class="text-muted d-block mt-1" style="font-size: 0.75rem;" dir="ltr">${escapeTaskHtml(tx.vodafoneNumber || tx.accountNumber || '---')}</small>
                                </div>
                            </div>
                            <div class="text-end">
                                <span class="fw-bold text-success d-block" style="font-size: 0.95rem; font-family: monospace;">+${escapeTaskHtml(tx.amount)}</span>
                                <small class="text-muted" style="font-size: 0.7rem;"><i class="fa-regular fa-clock me-1"></i> ${timeStr}</small>
                            </div>
                        </div>
                    `;
            });

            const countEl = document.getElementById('completedCount');
            if (countEl) countEl.innerText = count;

            const sumEl = document.getElementById('completedSum');
            if (sumEl) sumEl.innerText = sum.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' ج.م';

            const listEl = document.getElementById('completedTasksList');
            if (listEl) {
                listEl.innerHTML =
                    listHtml ||
                    `
                        <div class="text-center text-muted py-4">
                            <i class="fa-solid fa-satellite-dish fs-3 mb-2 opacity-50"></i>
                            <p class="m-0 small">لا يوجد عمليات منفذة اليوم بعد</p>
                        </div>
                    `;
            }
        }

        const monitorSummary = data.completedTodaySummary || {};
        const monitorCount = Number.isFinite(Number(monitorSummary.count))
            ? Number(monitorSummary.count)
            : Array.isArray(data.completedToday)
              ? data.completedToday.length
              : 0;
        const monitorAmount = Number.isFinite(Number(monitorSummary.amount))
            ? Number(monitorSummary.amount)
            : 0;
        const monitorActive = Array.isArray(data.tasks)
            ? data.tasks.filter((task) => task.status === 'accepted').length
            : 0;
        const monitorCountEl = document.getElementById('monitorCompletedCount');
        const monitorAmountEl = document.getElementById('monitorCompletedAmount');
        const monitorActiveEl = document.getElementById('monitorActiveCount');
        if (monitorCountEl) monitorCountEl.textContent = monitorCount.toLocaleString('en-US');
        if (monitorAmountEl)
            monitorAmountEl.textContent =
                monitorAmount.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' ج.م';
        if (monitorActiveEl) monitorActiveEl.textContent = monitorActive.toLocaleString('en-US');

        // 🚨 الطوارئ الذكية: تحديد إذا كان الموظف مشغولاً أم لا
        const amIBusy = data.tasks.some((t) => t.operatorId === myExecutorId && t.status === 'accepted');
        let targetAlert = null;
        if (!activeTaskId && data.alerts && data.alerts.length > 0) {
            targetAlert = data.alerts.find((a) => {
                if (dismissedAlertsIds.has(a._id)) return false;
                if (amIBusy) return a.operatorId === myExecutorId;
                else return a.status === 'processing';
            });
        }

        if (targetAlert) {
            if (currentEmergencyId !== targetAlert._id) {
                currentEmergencyId = targetAlert._id;
                document.getElementById('emergencyMessage').innerHTML =
                    `الطلب رقم: <code style="color:var(--accent-gold);">${escapeTaskHtml(targetAlert.customId)}</code><br><br>${escapeTaskHtml(targetAlert.emergencyAlert)}`;
                document.getElementById('emergencyOverlay').style.display = 'flex';
                const siren = document.getElementById('sirenSound');
                siren.volume = 1.0;
                const playPromise = siren.play();
                if (playPromise !== undefined) {
                    playPromise.catch(() => {
                        console.warn('المتصفح منع تشغيل الصوت تلقائياً.');
                    });
                }
            }
        } else {
            document.getElementById('emergencyOverlay').style.display = 'none';
            document.getElementById('sirenSound').pause();
            document.getElementById('sirenSound').currentTime = 0;
            currentEmergencyId = null;
        }

        // 💰 تنبيهات الإيداع
        if (!activeTaskId && data.depAlerts && data.depAlerts.length > 0) {
            for (const alertTx of data.depAlerts) {
                const alertData = alertTx.executorWebAlert;
                const alertType = ['success', 'error', 'warning'].includes(alertData.type)
                    ? alertData.type
                    : 'info';
                const alertTitle =
                    alertType === 'success'
                        ? 'إشعار إيداع'
                        : alertType === 'warning'
                          ? 'طلب إيداع جديد'
                          : 'تم الرفض';
                const alertTone =
                    alertType === 'success' ? 'success' : alertType === 'warning' ? 'warning' : 'danger';
                await Swal.fire({
                    title: alertTitle,
                    html: `<div class="fw-bold text-${alertTone}">${escapeTaskHtml(alertData.text)}</div>`,
                    icon: alertType,
                    confirmButtonText: 'حسناً',
                    confirmButtonColor: '#10b981',
                });
                await executorApiFetch('/executor-portal/api/clear-dep-alert/' + alertTx._id, {
                    method: 'POST',
                });
            }
        }

        const container = document.getElementById('tasksList');
        const ownedTasks = data.tasks.filter(
            (t) =>
                t.isOwnedByCurrentExecutor === true ||
                (t.operatorId === myExecutorId && t.status === 'accepted')
        );
        if (!activeTaskId && ownedTasks.length > 0) {
            window.location.replace(activeTaskUrl(ownedTasks[0]._id));
            return;
        }
        const visibleTasks = activeTaskId
            ? ownedTasks.filter((t) => String(t._id) === activeTaskId)
            : data.tasks;
        if (activeTaskId && visibleTasks.length === 0) {
            window.location.replace('/executor-portal/dashboard');
            return;
        }
        const newTasks = visibleTasks.filter((t) => !activeTasksIds.includes(t._id));
        if (!activeTaskId && newTasks.length > 0 && !currentEmergencyId)
            document
                .getElementById('alertSound')
                .play()
                .catch(() => {});
        activeTasksIds = visibleTasks.map((t) => t._id);

        // 🔒 فحص الـ Hash لمنع إعادة الرسم والوميض
        const currentTasksHash = Array.isArray(visibleTasks)
            ? visibleTasks
                  .map((task) =>
                      [
                          task._id,
                          task.status,
                          task.amount,
                          task.operatorId || '',
                          task.assignedExecutorId || '',
                          task.assignedExecutorName || '',
                          task.routingState || '',
                          task.recipientNumber || '',
                          task.emergencyAlert || '',
                          task.notes || '',
                      ].join(':')
                  )
                  .join('|')
            : '';
        if (currentTasksHash !== lastTasksHash) {
            lastTasksHash = currentTasksHash;

            // 🚀 الفرز الذكي (Smart Sorting FIFO) - نظام الطابور المطور
            let myTasks = [];
            let routedToMeTasks = [];
            let pendingTasks = [];
            let othersTasks = [];

            visibleTasks.forEach((t) => {
                const ownedByMe =
                    t.isOwnedByCurrentExecutor === true ||
                    (t.operatorId === myExecutorId && t.status === 'accepted');
                const routedToMe =
                    t.isAssignedToCurrentExecutor === true ||
                    (String(t.assignedExecutorId || '') === myExecutorId && t.status !== 'accepted');
                if (ownedByMe) myTasks.push(t);
                else if (routedToMe) routedToMeTasks.push(t);
                else if (t.status === 'processing' || t.status === 'pending') pendingTasks.push(t);
                else othersTasks.push(t);
            });

            const smartSortedTasks = [...myTasks, ...routedToMeTasks, ...pendingTasks, ...othersTasks];
            let html = '';

            smartSortedTasks.forEach((t) => {
                const isMine =
                    t.isOwnedByCurrentExecutor === true ||
                    (t.operatorId === myExecutorId && t.status === 'accepted');
                const routedToMe =
                    !isMine &&
                    (t.isAssignedToCurrentExecutor === true ||
                        (String(t.assignedExecutorId || '') === myExecutorId && t.status !== 'accepted'));
                const acceptedByOther = t.status === 'accepted' && !isMine;
                const quickExecuteEnabled =
                    executorManualPolicy.quickExecuteEnabled || executorQuickExecute.enabled;
                const showQuickExecute =
                    quickExecuteEnabled &&
                    (t.canQuickExecute === true ||
                        t.canClaimThenQuickExecute === true ||
                        ((t.transferType || '') === 'vodafone' && (isMine || routedToMe)));
                const canRoute =
                    isExecutorManager &&
                    manualTaskRoutingEnabled &&
                    (t.status === 'processing' || t.status === 'pending');
                const routingState =
                    t.routingState ||
                    (t.status === 'accepted'
                        ? 'in_progress'
                        : t.assignedExecutorId
                          ? 'pending_with_assignee'
                          : 'unassigned');
                const routingStateLabel =
                    t.routingStateLabel ||
                    (routingState === 'in_progress'
                        ? 'بدأ التنفيذ'
                        : routingState === 'pending_with_assignee'
                          ? 'معلّقة عنده'
                          : 'متاح');
                const assigneeName = t.assignedExecutorName || t.executorName || '';
                const recipientIsVisible = t.recipientRevealed === true && isMine;
                const recipientDisplay = t.recipientNumber || t.recipientPrefix || '---';
                const encodedRecipient = encodeURIComponent(recipientDisplay);
                const recipientLabel = recipientIsVisible ? 'الرقم / الحساب:' : 'بادئة الرقم / الحساب:';
                const formattedAmount = Number(t.amount || 0).toLocaleString('en-US', {
                    maximumFractionDigits: 0,
                });

                let cardClass = isMine
                    ? 'task-mine'
                    : routedToMe
                      ? 'task-routed'
                      : acceptedByOther
                        ? 'task-locked'
                        : routingState === 'pending_with_assignee'
                          ? 'task-waiting'
                          : 'task-pending';
                let badgeClass = isMine
                    ? 'badge-mine'
                    : routedToMe
                      ? 'badge-routed'
                      : acceptedByOther
                        ? 'badge-locked'
                        : routingState === 'pending_with_assignee'
                          ? 'badge-waiting'
                          : 'badge-pending';
                let badgeText = isMine
                    ? '<i class="fa-solid fa-bolt me-1"></i> بدأ التنفيذ'
                    : routedToMe
                      ? '<i class="fa-solid fa-inbox me-1"></i> موجهة إليك'
                      : acceptedByOther
                        ? '<i class="fa-solid fa-lock me-1"></i> بدأ التنفيذ'
                        : routingState === 'pending_with_assignee'
                          ? '<i class="fa-solid fa-hourglass-half me-1"></i> معلّقة عنده'
                          : '<i class="fa-solid fa-circle-dot me-1" aria-hidden="true"></i> متاح';

                const typeMeta = taskTypeMeta(t.transferType);
                const taskTypeName = typeMeta.name;
                const taskTypeIcon = typeMeta.icon;
                const normalizedTransferType = String(t.transferType || '')
                    .trim()
                    .toLowerCase();
                const transferVisualClass =
                    normalizedTransferType === 'post_card'
                        ? 'task-post-card'
                        : ['bank_account', 'bank_transfer'].includes(normalizedTransferType)
                          ? 'task-bank-transfer'
                          : normalizedTransferType === 'vodafone'
                            ? 'task-cash-transfer'
                            : '';

                let displayNote = t.notes || '';
                displayNote = displayNote.split('--- سجل الـ API')[0].trim();
                displayNote = displayNote
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter((line) => {
                        if (!line) return false;
                        if (/رقم المحول|رقم المرسل|الرقم المرجعي|مرجع|reference|ref/i.test(line)) return true;
                        return !/^سبب الرفض:|^\[تم |^\[فشل |^\[معلقة |^\[رقم الإلغاء:|^تحويل رصيد صادر إلى|^تحويل رصيد وارد من/.test(
                            line
                        );
                    })
                    .join('\n');
                const safeDisplayNote = escapeTaskHtml(displayNote).replace(/\n/g, '<br>');
                const safeAccountName = escapeTaskHtml(t.accountName || '').replace(/\n/g, '<br>');
                const safeBankName = escapeTaskHtml(t.bankName || '');
                const showBankName =
                    Boolean(safeBankName) &&
                    (t.transferType === 'bank_account' || t.transferType === 'bank_transfer');
                const bankMethodLabels = {
                    mobile: 'تحويل إلى رقم موبايل',
                    ipa: 'تحويل إلى عنوان دفع IPA',
                    account: 'تحويل إلى حساب بنكي',
                    iban: 'تحويل إلى IBAN',
                };
                const bankMethodLabel = bankMethodLabels[t.bankMethod] || '';
                const encodedBankName = encodeURIComponent(t.bankName || '');

                const taskArrivalAt = t.executorReceivedAt || t.createdAt;
                html += `
                        <div class="col-12 col-xxl-6">
                            <div class="task-card ${cardClass} ${transferVisualClass}" data-task-kind="${escapeTaskHtml(typeMeta.short)}" aria-label="${escapeTaskHtml(taskTypeName)}">
                                <div class="executor-task-card-body">
                                    <div class="task-header">
                                        <div class="executor-task-title">
                                            <div class="executor-task-icon" aria-hidden="true"><i class="fa-solid ${taskTypeIcon}"></i></div>
                                            <div>
                                                <h2>${taskTypeName}</h2>
                                                <span class="task-meta-line">
                                                    <span class="task-kind-label">${escapeTaskHtml(typeMeta.short)}</span>
                                                    <span class="task-custom-id">#${escapeTaskHtml(t.customId)}</span>
                                                </span>
                                            </div>
                                        </div>
                                        <span class="cyber-badge ${badgeClass}">${badgeText}</span>
                                    </div>

                                    <div class="executor-task-data">
                                      <div class="executor-task-data-cell">
                                        <span class="data-label">${recipientLabel}</span>
                                        <div class="copy-box" ${recipientIsVisible ? `onclick="copyText(decodeURIComponent('${encodedRecipient}'), this)"` : ''}>
                                            <span class="copy-val" dir="ltr">${escapeTaskHtml(recipientDisplay)}</span>
                                            <i class="fa-solid ${recipientIsVisible ? 'fa-copy' : 'fa-lock'} copy-icon"></i>
                                        </div>
                                      </div>
                                      <div class="executor-task-data-cell task-amount-cell">
                                        <span class="data-label">القيمة المطلوبة</span>
                                        <div class="copy-box" onclick="copyText('${t.amount}', this)">
                                            <span class="copy-val amount">${formattedAmount} <small>ج.م</small></span>
                                            <i class="fa-regular fa-copy copy-icon"></i>
                                        </div>
                                      </div>
                                      <div class="executor-task-data-cell">
                                        <span class="data-label">وقت الانتظار</span>
                                        <span class="live-timer" data-time="${taskArrivalAt}">0s</span>
                                      </div>
                                    </div>

                                    ${safeDisplayNote ? `<div class="tx-notes"><i class="fa-solid fa-comment-dots me-1 opacity-50"></i> ${safeDisplayNote}</div>` : ''}
                                    ${safeAccountName && t.transferType !== 'vodafone' ? `<div class="tx-beneficiary"><i class="fa-solid fa-user me-1 opacity-50"></i> ${safeAccountName}</div>` : ''}
                                    ${showBankName ? `<div class="tx-beneficiary"><i class="fa-solid fa-building-columns me-1 opacity-50"></i> ${safeBankName}</div>` : ''}
                                    ${bankMethodLabel ? `<div class="tx-beneficiary bank-transfer-method"><i class="fa-solid fa-route me-1 opacity-50"></i> ${escapeTaskHtml(bankMethodLabel)}</div>` : ''}
                                    ${recipientIsVisible ? '' : '<div class="executor-task-privacy"><i class="fa-solid fa-shield-halved"></i><span>يظهر الرقم كاملًا بعد قبول المهمة للمنفذ الذي سحبها فقط.</span></div>'}
                                    ${
                                        (isExecutorManager || routedToMe) && assigneeName
                                            ? `
                                    <div class="executor-assignee-strip ${routingState === 'in_progress' ? 'in-progress' : routingState === 'pending_with_assignee' ? 'waiting' : ''}">
                                        <i class="fa-solid ${routingState === 'in_progress' ? 'fa-play' : 'fa-user-check'}"></i>
                                        <div>
                                            <small>${escapeTaskHtml(routingStateLabel)}</small>
                                            <strong>${escapeTaskHtml(assigneeName)}</strong>
                                        </div>
                                    </div>`
                                            : ''
                                    }
                                    ${
                                        isExecutorManager && routingState === 'pending_with_assignee'
                                            ? `
                                    <div class="executor-sla-hint" hidden data-assigned-at="${escapeTaskHtml(t.assignedExecutorAt || '')}">
                                        <i class="fa-solid fa-hourglass-half"></i>
                                        <span>معلّقة عنده — إذا تجاوز الانتظار قد تحتاج إعادة توجيه</span>
                                    </div>`
                                            : ''
                                    }
                                </div>

                                <div class="action-zone border-0">
                                    ${
                                        canRoute
                                            ? `<button onclick="routeTask('${t._id}')" class="btn-accept-start"><i class="fa-solid fa-route me-1"></i> ${assigneeName ? 'إعادة التوجيه' : 'توجيه إلى منفذ'}</button>`
                                            : acceptedByOther
                                              ? `<div class="p-2 rounded-3 text-center fw-bold text-muted border w-100 small" style="background: rgba(0,0,0,0.05);"><i class="fa-solid fa-user-gear me-1"></i> بدأ التنفيذ: ${escapeTaskHtml(assigneeName || 'منفذ آخر')}</div>`
                                              : isMine
                                                ? `
                                         <div class="complete-actions-row">
                                            <button onclick="openUpload('${t._id}', '${t.transferType || ''}', ${Number(t.amount || 0)}, '${encodedBankName}')" class="btn-cyber-main mb-0"><i class="fa-solid fa-check-double"></i> إنهاء العملية</button>
                                            ${
                                                showQuickExecute
                                                    ? `
                                            <button type="button" onclick="quickExecuteDial('${t._id}')" class="btn-quick-execute" title="تنفيذ سريع" aria-label="تنفيذ سريع">
                                                <i class="fa-solid fa-phone-flip"></i>
                                                <span>تنفيذ سريع</span>
                                            </button>`
                                                    : ''
                                            }
                                         </div>
                                         <div class="horizontal-actions">
                                            <button type="button" onclick="editAmount('${t._id}')" class="btn-cyber-sub btn-warning-neon" title="تعديل المبلغ" aria-label="تعديل المبلغ"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> <span class="btn-text-hide ms-1">تعديل</span></button>
                                            ${activeTaskId ? '' : `<button onclick="returnTask('${t._id}')" type="button" class="btn-cyber-sub btn-info-neon" title="إرجاع الطلب للإدارة" aria-label="إرجاع الطلب للإدارة"><i class="fa-solid fa-reply" aria-hidden="true"></i> <span class="btn-text-hide ms-1">إرجاع</span></button>`}
                                            <button type="button" onclick="cancelTask('${t._id}')" class="btn-cyber-sub btn-danger-neon" title="إلغاء العملية" aria-label="إلغاء العملية"><i class="fa-solid fa-xmark" aria-hidden="true"></i> <span class="btn-text-hide ms-1">إلغاء</span></button>
                                         </div>
                                        `
                                                : `
                                         <div class="complete-actions-row">
                                            <button type="button" onclick="acceptTask('${t._id}', this)" class="btn-accept-start mb-0"><i class="fa-solid fa-bolt me-1" aria-hidden="true"></i> ${routedToMe ? 'اسحب المهمة الموجهة إليك' : 'اسحب ونفذ فوراً'}</button>
                                            ${
                                                showQuickExecute
                                                    ? `
                                            <button type="button" onclick="quickExecuteDial('${t._id}')" class="btn-quick-execute" title="تنفيذ سريع" aria-label="تنفيذ سريع">
                                                <i class="fa-solid fa-phone-flip"></i>
                                                <span>تنفيذ سريع</span>
                                            </button>`
                                                    : ''
                                            }
                                         </div>`
                                    }
                                </div>
                            </div>
                        </div>`;
            });
            container.innerHTML =
                html ||
                `<div class="col-12"><div class="executor-empty-state-live"><div><div class="executor-empty-mark" role="img" aria-label="في انتظار عمليات جديدة"><svg viewBox="0 0 72 72" aria-hidden="true" focusable="false"><circle cx="36" cy="36" r="26" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="M36 20v17l12 7" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="36" cy="36" r="3.2" fill="currentColor"/></svg></div><h2>غرفة العمليات هادئة</h2><p>سيظهر الطلب هنا فور وصول عملية جديدة.</p></div></div></div>`;
        }
    } catch {
        const offline = navigator.onLine === false;
        const message = offline
            ? 'انقطع الاتصال. تبقى آخر المهام ظاهرة حتى يعود الإنترنت.'
            : activeTaskId
              ? 'تعذر تحميل العملية النشطة. ستتم إعادة المحاولة تلقائيًا.'
              : 'تعذر تحديث قائمة المهام. ستتم إعادة المحاولة تلقائيًا.';
        showTaskBoardStatus(message, { offline });
        renderTaskLoadFallback(activeTaskId ? 'تعذر تحميل العملية النشطة.' : 'تعذر تحميل قائمة المهام.');
    }
}
