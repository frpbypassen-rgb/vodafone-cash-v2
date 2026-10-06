/* exported acceptTask, openUpload, editAmount, cancelTask, returnTask, showApiLogFromText */
async function acceptTask(id, trigger) {
    const button = trigger && trigger.tagName === 'BUTTON' ? trigger : null;
    if (navigator.onLine === false) {
        showTaskBoardStatus('انقطع الاتصال. لا يمكن سحب العملية حتى يعود الإنترنت.', { offline: true });
        Swal.fire('انقطع الاتصال', 'تحقق من الإنترنت ثم أعد المحاولة.', 'warning');
        return;
    }
    if (button) {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.dataset.prevLabel = button.innerHTML;
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> جار السحب...';
    }
    try {
        const response = await executorApiFetch('/executor-portal/api/accept-task/' + id, { method: 'POST' });
        await readExecutorApiResponse(response);
        window.location.assign(activeTaskUrl(id));
    } catch (error) {
        if (button) {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            if (button.dataset.prevLabel) button.innerHTML = button.dataset.prevLabel;
        }
        const offline = navigator.onLine === false;
        const message = offline ? 'انقطع الاتصال أثناء سحب العملية.' : error.message || 'تعذر سحب العملية.';
        if (offline) showTaskBoardStatus(message, { offline: true });
        Swal.fire(offline ? 'انقطع الاتصال' : 'تعذر سحب العملية', message, offline ? 'warning' : 'error');
        await refreshTasks();
    }
}
function openUpload(id, transferType, amount = 0, bankName = '') {
    currentCompletingId = id;
    currentCompletingTransferType = String(transferType || '').toLowerCase();
    currentCompletingAmount = Number(amount || 0);
    try {
        currentCompletingBankName = decodeURIComponent(String(bankName || ''));
    } catch (_error) {
        currentCompletingBankName = '';
    }
    resetUploadModal();
    new bootstrap.Modal(document.getElementById('uploadModal')).show();
}

document.getElementById('btnFinish').onclick = async function () {
    const bankTransfer = isBankTransferCompletion();
    const splitEnabled = !bankTransfer && document.getElementById('splitOperationToggle').checked;
    const btn = this;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ضغط وإرسال...';

    try {
        let payload = {};
        if (splitEnabled) {
            const rows = senderEntryRows.map((row) => {
                const phone =
                    document.querySelector(`.sender-entry-phone[data-row-id="${row.id}"]`)?.value.trim() ||
                    '';
                const amountValue = Number(
                    document.querySelector(`.sender-entry-amount[data-row-id="${row.id}"]`)?.value || 0
                );
                return { row, phone, amount: amountValue };
            });
            if (rows.length < 2) throw new Error('أضف رقمين مرسلين على الأقل عند تقسيم العملية.');
            const total = rows.reduce((sum, item) => sum + item.amount, 0);
            if (Math.abs(total - currentCompletingAmount) > 0.01) {
                throw new Error(
                    `مجموع المبالغ (${total.toLocaleString('en-US')}) يجب أن يساوي قيمة العملية (${currentCompletingAmount.toLocaleString('en-US')}).`
                );
            }
            const senderEntries = [];
            for (const item of rows) {
                const phoneError = validateSenderPhoneInput(item.phone, true);
                if (phoneError) throw new Error(phoneError);
                const entry = { phone: item.phone.replace(/\D/g, ''), amount: item.amount };
                if (item.row.file) {
                    entry.proofImageBase64 = await compressSingleImagePromise(item.row.file);
                } else if (executorManualPolicy.proofRequired) {
                    throw new Error('يجب إرفاق صورة إثبات لكل رقم مرسل.');
                }
                senderEntries.push(entry);
            }
            payload = {
                executionNumber: senderEntries[0].phone,
                senderEntries,
            };
        } else {
            const executionNumber = bankTransfer
                ? ''
                : document.getElementById('senderPhoneInput').value.trim();
            const executionDigits = executionNumber.replace(/\D/g, '');
            if (!bankTransfer && executionDigits) {
                const phoneError = validateSenderPhoneInput(executionDigits, false);
                if (phoneError) throw new Error(phoneError);
            }
            const compressedImagesBase64 = [];
            for (let i = 0; i < selectedFilesArray.length; i++) {
                compressedImagesBase64.push(await compressSingleImagePromise(selectedFilesArray[i]));
            }
            if ((bankTransfer || executorManualPolicy.proofRequired) && compressedImagesBase64.length === 0) {
                throw new Error(
                    bankTransfer
                        ? 'إرفاق صورة إثبات التحويل البنكي إجباري.'
                        : 'إرفاق صورة الإثبات إجباري لهذا المنفذ.'
                );
            }
            payload = {
                imageBase64: compressedImagesBase64[0],
                imagesBase64: compressedImagesBase64,
            };
            if (!bankTransfer) payload.executionNumber = executionNumber;
        }

        const res = await executorApiFetch('/executor-portal/api/complete-task/' + currentCompletingId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        await readExecutorApiResponse(res);
        window.location.assign('/executor-portal/dashboard');
    } catch (e) {
        const offline = navigator.onLine === false;
        Swal.fire(
            offline ? 'انقطع الاتصال' : 'تعذر إنهاء العملية',
            offline
                ? 'انقطع الاتصال قبل حفظ العملية. أعد المحاولة بعد عودة الإنترنت.'
                : e.message || 'فشل حفظ الإيصال.',
            offline ? 'warning' : 'error'
        );
        btn.disabled = false;
        btn.innerHTML =
            '<i class="fa-solid fa-check-double me-2"></i> تأكيد التنفيذ والإرسال <kbd class="ms-2 bg-dark bg-opacity-25 border-0 text-white px-2 py-1 rounded" style="font-size: 0.75rem; font-family: sans-serif;">Enter ↵</kbd>';
    }
};

async function editAmount(id) {
    const { value: formValues } = await Swal.fire({
        title: 'تعديل المبلغ',
        html: '<input id="swal-amount" type="number" class="form-control mb-3 text-center fw-bold" placeholder="المبلغ الجديد"><textarea id="swal-reason" class="form-control" placeholder="السبب..." rows="2"></textarea>',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'تأكيد وحفظ',
        confirmButtonColor: '#f59e0b',
        preConfirm: () => {
            const a = document.getElementById('swal-amount').value;
            const rn = document.getElementById('swal-reason').value;
            if (!a || !rn) {
                Swal.showValidationMessage('مطلوب إدخال البيانات!');
                return false;
            }
            return [a, rn];
        },
    });
    if (formValues) {
        try {
            const res = await executorApiFetch('/executor-portal/api/edit-amount/' + id, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newAmount: formValues[0], reason: formValues[1] }),
            });
            await readExecutorApiResponse(res);
            Swal.fire('تم', 'تم التعديل بنجاح', 'success').then(refreshTasks);
        } catch (error) {
            const offline = navigator.onLine === false;
            Swal.fire(
                offline ? 'انقطع الاتصال' : 'تعذر تعديل المبلغ',
                offline ? 'انقطع الاتصال. أعد المحاولة بعد عودة الإنترنت.' : error.message,
                offline ? 'warning' : 'error'
            );
        }
    }
}

async function cancelTask(id) {
    const { value: reason } = await Swal.fire({
        title: 'إلغاء العملية',
        html: `
                <div class="text-end" dir="rtl">
                    <label for="swal-cancel-reason" class="form-label fw-bold w-100">سبب الإلغاء</label>
                    <select id="swal-cancel-reason" class="swal2-select" style="width: 100%; margin: 0;">
                        <option value="" selected disabled>اختر سبب الإلغاء</option>
                        <option value="لا يوجد محفظة">لا يوجد محفظة</option>
                        <option value="محفظة ليميت">محفظة ليميت</option>
                        <option value="الخدمة متوقفة حاليا">الخدمة متوقفة حاليا</option>
                        <option value="الرقم غير صحيح">الرقم غير صحيح</option>
                        <option value="other">سبب آخر</option>
                    </select>
                    <div id="swal-cancel-other-reason-wrap" class="mt-3" style="display: none;">
                        <label for="swal-cancel-other-reason" class="form-label fw-bold w-100">اكتب السبب</label>
                        <textarea id="swal-cancel-other-reason" class="swal2-textarea" rows="3" placeholder="اكتب سبب الإلغاء..."></textarea>
                    </div>
                </div>`,
        showCancelButton: true,
        confirmButtonText: 'تأكيد الإلغاء',
        confirmButtonColor: '#ef4444',
        cancelButtonText: 'تراجع',
        focusConfirm: false,
        returnFocus: true,
        allowEscapeKey: true,
        didOpen: (popup) => {
            popup.setAttribute('dir', 'rtl');
            popup.setAttribute('lang', 'ar');
            popup.setAttribute('aria-modal', 'true');
            const select = document.getElementById('swal-cancel-reason');
            const otherReasonWrap = document.getElementById('swal-cancel-other-reason-wrap');
            const otherReason = document.getElementById('swal-cancel-other-reason');
            select.focus();
            select.addEventListener('change', () => {
                const isOther = select.value === 'other';
                otherReasonWrap.style.display = isOther ? 'block' : 'none';
                if (isOther) otherReason.focus();
            });
        },
        preConfirm: () => {
            const selectedReason = document.getElementById('swal-cancel-reason').value;
            const customReason = document.getElementById('swal-cancel-other-reason').value.trim();
            if (!selectedReason) {
                Swal.showValidationMessage('يرجى اختيار سبب الإلغاء.');
                return false;
            }
            if (selectedReason === 'other' && !customReason) {
                Swal.showValidationMessage('يرجى كتابة سبب الإلغاء.');
                return false;
            }
            return selectedReason === 'other' ? customReason : selectedReason;
        },
    });
    if (reason) {
        try {
            const res = await executorApiFetch('/executor-portal/api/cancel-task/' + id, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
            });
            await readExecutorApiResponse(res);
            if (activeTaskId) {
                window.location.assign('/executor-portal/dashboard');
            } else {
                await refreshTasks();
            }
        } catch (error) {
            const offline = navigator.onLine === false;
            Swal.fire(
                offline ? 'انقطع الاتصال' : 'تعذر إلغاء العملية',
                offline ? 'انقطع الاتصال. أعد المحاولة بعد عودة الإنترنت.' : error.message,
                offline ? 'warning' : 'error'
            );
        }
    }
}

async function returnTask(id) {
    const { value: reason } = await Swal.fire({
        title: 'إرجاع للإدارة',
        input: 'text',
        inputPlaceholder: 'السبب...',
        showCancelButton: true,
        confirmButtonText: 'إرجاع',
        confirmButtonColor: '#0ea5e9',
        cancelButtonText: 'تراجع',
        inputValidator: (val) => {
            if (!val) return 'مطلوب السبب!';
        },
    });
    if (reason) {
        try {
            const res = await executorApiFetch('/executor-portal/api/return-task/' + id, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
            });
            await readExecutorApiResponse(res);
            await refreshTasks();
        } catch (error) {
            const offline = navigator.onLine === false;
            Swal.fire(
                offline ? 'انقطع الاتصال' : 'تعذر إرجاع العملية',
                offline ? 'انقطع الاتصال. أعد المحاولة بعد عودة الإنترنت.' : error.message,
                offline ? 'warning' : 'error'
            );
        }
    }
}

// 🟢 دالة عرض نافذة السجل المنبثقة للـ API
function showApiLogFromText(rawNotesEnc) {
    const rawNotes = decodeURIComponent(rawNotesEnc);
    let logContent = rawNotes;

    if (rawNotes.includes('--- سجل الـ API (Terminal Log) ---')) {
        logContent = rawNotes.split('--- سجل الـ API (Terminal Log) ---')[1].trim();
    } else if (rawNotes.includes('--- سجل الـ API ---')) {
        logContent = rawNotes.split('--- سجل الـ API ---')[1].trim();
    } else if (rawNotes.includes('--- سجل الـ API')) {
        logContent = rawNotes.split('--- سجل الـ API')[1].trim();
    }

    Swal.fire({
        title: '<div style="color:#10b981; font-family:monospace; font-size:1.2rem; display:flex; align-items:center; gap:10px; justify-content:center;"><i class="fa-solid fa-terminal"></i> سجل التخاطب مع السيرفر</div>',
        html: `<div style="background:#0f172a; color:#a5b4fc; padding:15px; border-radius:8px; text-align:left; direction:ltr; font-family:'JetBrains Mono', monospace; font-size:0.85rem; white-space:pre-wrap; max-height:400px; overflow-y:auto; border:1px solid #334155; box-shadow:inset 0 2px 4px rgba(0,0,0,0.5);">${escapeTaskHtml(logContent)}</div>`,
        background: '#1e293b',
        color: '#fff',
        confirmButtonColor: '#3b82f6',
        confirmButtonText: 'إغلاق الشاشة',
        width: '600px',
        customClass: { popup: 'border border-secondary rounded-4' },
    });
}
