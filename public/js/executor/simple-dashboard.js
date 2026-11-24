(function () {
    'use strict';

    const byId = (id) => document.getElementById(id);
    const tasksElement = byId('simpleTasks');
    const messageElement = byId('simpleMessage');
    const completeDialog = byId('simpleCompleteDialog');
    const cancelDialog = byId('simpleCancelDialog');
    let tasks = [];
    let selectedTask = null;
    let busy = false;
    let pollTimer = null;
    let pollSeconds = 12;
    let messageTimer = null;

    const numberText = (value) => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const amountText = (value) => String(Number(value || 0));
    const isBank = (task) =>
        ['bank_account', 'bank_transfer'].includes(String(task.transferType || '').toLowerCase());
    const taskLabel = (task) =>
        ({
            vodafone: 'فودافون كاش',
            bank_account: 'تحويل بنكي',
            bank_transfer: 'تحويل بنكي',
            post_account: 'حساب بريدي',
            post_card: 'بطاقة بريدية',
            sefa_niger: 'سيفا النيجر',
        })[task.transferType] || 'عملية تنفيذ';

    function notify(message, error = false) {
        window.clearTimeout(messageTimer);
        messageElement.textContent = message;
        messageElement.classList.toggle('is-error', error);
        messageElement.hidden = false;
        messageTimer = window.setTimeout(() => {
            messageElement.hidden = true;
        }, 7000);
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = String(text);
        return node;
    }

    function button(className, label, action, disabled = false) {
        const node = element('button', className, label);
        node.type = 'button';
        node.disabled = disabled;
        if (action) node.addEventListener('click', action);
        return node;
    }

    async function copyText(value, label) {
        if (!value) return;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                const temp = element('textarea');
                temp.value = value;
                temp.setAttribute('readonly', '');
                temp.style.position = 'fixed';
                temp.style.opacity = '0';
                document.body.appendChild(temp);
                temp.select();
                const copied = document.execCommand('copy');
                temp.remove();
                if (!copied) throw new Error('COPY_FAILED');
            }
            notify(`تم نسخ ${label}.`);
        } catch (_) {
            notify('تعذر النسخ. اسمح بالوصول للحافظة ثم أعد المحاولة.', true);
        }
    }

    function fullOperationText(task) {
        return [
            `رقم العملية: ${task.customId || task._id}`,
            `الخدمة: ${taskLabel(task)}`,
            `رقم المستفيد: ${task.recipientNumber}`,
            `القيمة: ${amountText(task.amount)} ج.م`,
            task.accountName ? `اسم المستفيد: ${task.accountName}` : null,
            task.bankName ? `البنك: ${task.bankName}` : null,
            task.notes ? `ملاحظات: ${task.notes}` : null,
        ]
            .filter(Boolean)
            .join('\n');
    }

    function taskCard(task) {
        const owned = task.status === 'accepted' && task.isOwnedByCurrentExecutor === true;
        const revealed = owned && task.recipientRevealed === true;
        const card = element('article', `simple-task${owned ? ' is-active' : ''}`);
        const top = element('div', 'simple-task-top');
        top.append(
            element('span', 'simple-task-id', task.customId || task._id),
            element('span', 'simple-task-state', owned ? 'قيد التنفيذ' : task.routingStateLabel || 'واردة')
        );
        const data = element('div', 'simple-task-data');
        const recipient = element('div');
        recipient.append(
            element('span', '', 'رقم المستفيد'),
            element('strong', '', revealed ? task.recipientNumber : `${task.recipientPrefix || '•••'}•••••••`)
        );
        const amount = element('div');
        amount.append(
            element('span', '', 'القيمة بالجنيه المصري'),
            element('strong', 'amount', numberText(task.amount))
        );
        data.append(recipient, amount);
        card.append(top, element('p', 'simple-task-type', taskLabel(task)), data);
        if (task.accountName && revealed) card.append(element('p', 'simple-task-note', task.accountName));
        if (task.notes && revealed) card.append(element('p', 'simple-task-note', task.notes));

        const copies = element('div', 'simple-copy-actions');
        copies.append(
            button('', 'نسخ الرقم', () => copyText(task.recipientNumber, 'الرقم'), !revealed),
            button('', 'نسخ القيمة', () => copyText(amountText(task.amount), 'القيمة')),
            button('', 'نسخ العملية', () => copyText(fullOperationText(task), 'العملية'), !revealed)
        );
        card.append(copies);
        const actions = element('div', 'simple-main-actions');
        if (owned) {
            actions.append(
                button('simple-success', 'نجاح العملية', () => openComplete(task)),
                button('simple-danger', 'إلغاء العملية', () => openCancel(task))
            );
        } else if (task.status === 'processing') {
            const assignedElsewhere = Boolean(task.assignedExecutorId && !task.isAssignedToCurrentExecutor);
            actions.append(
                button(
                    'simple-accept',
                    assignedElsewhere ? 'موجّهة لمنفذ آخر' : 'استلام العملية',
                    () => acceptTask(task),
                    assignedElsewhere || busy
                )
            );
        }
        card.append(actions);
        return card;
    }

    function render() {
        const ordered = [...tasks].sort(
            (a, b) => Number(b.isOwnedByCurrentExecutor) - Number(a.isOwnedByCurrentExecutor)
        );
        tasksElement.replaceChildren(
            ...(ordered.length
                ? ordered.map(taskCard)
                : [element('p', 'simple-empty', 'لا توجد عمليات واردة الآن. ستظهر هنا عند وصولها.')])
        );
        tasksElement.setAttribute('aria-busy', 'false');
        byId('simpleTaskCount').textContent = String(ordered.length);
    }

    async function refresh() {
        if (document.hidden) return;
        try {
            const response = await executorApiFetch('/executor-portal/api/live-tasks?lite=1');
            const data = await readExecutorApiResponse(response);
            if (data.simpleTaskViewEnabled !== true) {
                window.location.replace('/executor-portal/dashboard');
                return;
            }
            tasks = Array.isArray(data.tasks) ? data.tasks : [];
            byId('simpleCompletedCount').textContent = numberText(data.completedTodaySummary?.count);
            byId('simpleCompletedAmount').textContent =
                `${numberText(data.completedTodaySummary?.amount)} ج.م`;
            const interval = Number(data.pollIntervalSeconds);
            if (interval >= 5 && interval <= 30) pollSeconds = interval;
            byId('simpleConnection').textContent = 'متصل · تحديث تلقائي';
            byId('simpleConnection').className = 'simple-connection is-online';
            if (!completeDialog.open && !cancelDialog.open) render();
        } catch (error) {
            byId('simpleConnection').textContent = 'تعذر التحديث';
            byId('simpleConnection').className = 'simple-connection is-offline';
            tasksElement.setAttribute('aria-busy', 'false');
            notify(error.message || 'تعذر تحديث العمليات.', true);
        } finally {
            window.clearTimeout(pollTimer);
            pollTimer = window.setTimeout(refresh, pollSeconds * 1000);
        }
    }

    async function postAction(url, body) {
        const response = await executorApiFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return readExecutorApiResponse(response);
    }

    async function acceptTask(task) {
        if (busy) return;
        busy = true;
        render();
        try {
            await postAction(`/executor-portal/api/accept-task/${encodeURIComponent(task._id)}`, {});
            notify('تم استلام العملية. راجع بياناتها قبل التنفيذ.');
        } catch (error) {
            notify(`${error.message} تحقّق من حالة العملية قبل إعادة المحاولة.`, true);
        } finally {
            busy = false;
            await refresh();
        }
    }

    function openComplete(task) {
        if (busy) return;
        selectedTask = task;
        byId('simpleCompleteTask').textContent =
            `العملية ${task.customId || task._id} · ${numberText(task.amount)} ج.م`;
        byId('simpleExecutionNumber').value = '';
        byId('simpleProofInput').value = '';
        byId('simpleProofName').textContent = 'لم تُختر صورة';
        completeDialog.showModal();
    }

    function openCancel(task) {
        if (busy) return;
        selectedTask = task;
        byId('simpleCancelTask').textContent = `العملية ${task.customId || task._id}`;
        byId('simpleCancelReason').value = '';
        byId('simpleOtherReason').value = '';
        byId('simpleOtherReason').hidden = true;
        cancelDialog.showModal();
    }

    function readImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('تعذر قراءة الصورة.'));
            reader.readAsDataURL(file);
        });
    }

    async function completeTask() {
        if (busy || !selectedTask) return;
        const task = selectedTask;
        const executionNumber = byId('simpleExecutionNumber').value.trim();
        const file = byId('simpleProofInput').files[0];
        if (executionNumber && !/^[0-9]{3,11}$/.test(executionNumber)) {
            notify('رقم المنفذ يجب أن يتكون من 3 إلى 11 رقمًا.', true);
            return;
        }
        if (!file && !executionNumber) {
            notify('أرفق صورة التنفيذ أو أدخل رقم المنفذ.', true);
            return;
        }
        if (isBank(task) && !file) {
            notify('صورة إثبات التحويل البنكي مطلوبة.', true);
            return;
        }
        if (
            file &&
            (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024)
        ) {
            notify('اختر صورة JPG أو PNG أو WebP لا تتجاوز 8 ميغابايت.', true);
            return;
        }
        busy = true;
        byId('simpleConfirmComplete').disabled = true;
        try {
            const imageBase64 = file ? await readImage(file) : undefined;
            await postAction(`/executor-portal/api/complete-task/${encodeURIComponent(task._id)}`, {
                executionNumber,
                imageBase64,
            });
            completeDialog.close();
            selectedTask = null;
            notify('تم تسجيل نجاح العملية.');
        } catch (error) {
            notify(`${error.message} تحقّق من حالة العملية قبل إعادة المحاولة.`, true);
        } finally {
            busy = false;
            byId('simpleConfirmComplete').disabled = false;
            await refresh();
        }
    }

    async function cancelTask() {
        if (busy || !selectedTask) return;
        const task = selectedTask;
        const chosen = byId('simpleCancelReason').value;
        const reason = chosen === 'other' ? byId('simpleOtherReason').value.trim() : chosen;
        if (!reason) {
            notify('اكتب سبب الإلغاء أولًا.', true);
            return;
        }
        busy = true;
        byId('simpleConfirmCancel').disabled = true;
        try {
            await postAction(`/executor-portal/api/cancel-task/${encodeURIComponent(task._id)}`, { reason });
            cancelDialog.close();
            selectedTask = null;
            notify('تم إلغاء العملية وفق المسار المعتمد.');
        } catch (error) {
            notify(`${error.message} تحقّق من حالة العملية قبل إعادة المحاولة.`, true);
        } finally {
            busy = false;
            byId('simpleConfirmCancel').disabled = false;
            await refresh();
        }
    }

    document
        .querySelectorAll('[data-close-dialog]')
        .forEach((node) => node.addEventListener('click', () => node.closest('dialog').close()));
    byId('simpleProofInput').addEventListener('change', (event) => {
        byId('simpleProofName').textContent = event.target.files[0]?.name || 'لم تُختر صورة';
    });
    byId('simpleCancelReason').addEventListener('change', (event) => {
        byId('simpleOtherReason').hidden = event.target.value !== 'other';
    });
    byId('simpleConfirmComplete').addEventListener('click', completeTask);
    byId('simpleConfirmCancel').addEventListener('click', cancelTask);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refresh();
    });
    window.addEventListener('online', refresh);
    window.addEventListener('offline', () => {
        byId('simpleConnection').textContent = 'غير متصل';
        byId('simpleConnection').className = 'simple-connection is-offline';
    });
    refresh();
})();
