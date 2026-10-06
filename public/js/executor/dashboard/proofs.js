/* exported dropZone, proofInput, previewsGrid, handleIncomingFiles, renderImagesGrid, removeImageFromList, currentCompletingAmount, senderEntryRows, toggleSplitOperationMode, addSenderEntryRow, removeSenderEntryRow, renderSenderEntryRows, updateSplitAmountSummary, phoneLengthAllowed, validateSenderPhoneInput, isBankTransferCompletion, updateProofRequirement, resetUploadModal, compressSingleImagePromise */
// 📤 Upload Logic
const dropZone = document.getElementById('dropZone');
const proofInput = document.getElementById('proofInput');
const previewsGrid = document.getElementById('previewsGrid');
dropZone.onclick = () => proofInput.click();
dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--accent-green)';
    dropZone.style.background = 'rgba(16, 185, 129, 0.1)';
};
dropZone.ondragleave = (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    dropZone.style.background = 'rgba(16, 185, 129, 0.05)';
};
dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    dropZone.style.background = 'rgba(16, 185, 129, 0.05)';
    if (e.dataTransfer.files.length) handleIncomingFiles(e.dataTransfer.files);
};
proofInput.onchange = (e) => {
    if (e.target.files.length) handleIncomingFiles(e.target.files);
};
window.addEventListener('paste', (e) => {
    if (document.getElementById('uploadModal').classList.contains('show')) {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        let pastedFiles = [];
        for (let index in items) {
            const item = items[index];
            if (item.kind === 'file' && item.type.startsWith('image/')) pastedFiles.push(item.getAsFile());
        }
        if (pastedFiles.length > 0) handleIncomingFiles(pastedFiles);
    }
});

// ⌨️ دعم الضغط على زر Enter لتأكيد الإرسال
document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        if (document.body.classList.contains('swal2-shown')) return;
        const uploadModal = document.getElementById('uploadModal');
        if (uploadModal && uploadModal.classList.contains('show')) {
            e.preventDefault();
            const btnFinish = document.getElementById('btnFinish');
            if (btnFinish && !btnFinish.disabled) {
                btnFinish.click();
            }
        }
    }
});

function handleIncomingFiles(files) {
    const remainingSlots = Math.max(0, 5 - selectedFilesArray.length);
    if (remainingSlots === 0) {
        Swal.fire('تنبيه', 'يمكن إرفاق خمس صور إثبات كحد أقصى.', 'info');
        return;
    }
    const acceptedFiles = Array.from(files).slice(0, remainingSlots);
    for (let i = 0; i < acceptedFiles.length; i++) {
        if (!acceptedFiles[i].type.startsWith('image/')) {
            Swal.fire('خطأ', 'يرجى اختيار صور فقط.', 'error');
            continue;
        }
        selectedFilesArray.push(acceptedFiles[i]);
    }
    if (files.length > remainingSlots)
        Swal.fire('تنبيه', 'تمت إضافة الصور المتاحة فقط. الحد الأقصى خمس صور.', 'info');
    renderImagesGrid();
}

function renderImagesGrid() {
    previewsGrid.innerHTML = '';
    if (selectedFilesArray.length === 0) return;
    selectedFilesArray.forEach((file, index) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const gridCol = document.createElement('div');
            gridCol.className = 'col-4 position-relative mb-2';
            gridCol.innerHTML = `
                    <div class="position-relative rounded-3 overflow-hidden shadow-sm" style="height: 80px; border: 1px solid var(--glass-border);">
                        <img src="${e.target.result}" style="width: 100%; height: 100%; object-fit: cover;">
                        <button type="button" onclick="removeImageFromList(${index})" class="preview-badge-remove"><i class="fa-solid fa-xmark"></i></button>
                    </div>`;
            previewsGrid.appendChild(gridCol);
        };
        reader.readAsDataURL(file);
    });
}

function removeImageFromList(index) {
    selectedFilesArray.splice(index, 1);
    renderImagesGrid();
}
let currentCompletingAmount = 0;
let senderEntryRows = [];

function toggleSplitOperationMode() {
    const enabled = document.getElementById('splitOperationToggle').checked;
    document.getElementById('singleSenderBlock').classList.toggle('d-none', enabled);
    document.getElementById('splitSenderBlock').classList.toggle('d-none', !enabled);
    if (enabled && senderEntryRows.length === 0) {
        addSenderEntryRow();
        addSenderEntryRow();
    }
    updateSplitAmountSummary();
}

function addSenderEntryRow() {
    if (senderEntryRows.length >= 5) {
        Swal.fire('تنبيه', 'الحد الأقصى خمسة أرقام مرسل.', 'warning');
        return;
    }
    const rowId = `sender-row-${Date.now()}-${senderEntryRows.length}`;
    senderEntryRows.push({ id: rowId, file: null });
    renderSenderEntryRows();
}

function removeSenderEntryRow(rowId) {
    senderEntryRows = senderEntryRows.filter((row) => row.id !== rowId);
    renderSenderEntryRows();
}

function renderSenderEntryRows() {
    const container = document.getElementById('senderEntriesContainer');
    if (!container) return;
    container.innerHTML = senderEntryRows
        .map(
            (row, index) => `
            <div class="p-3 rounded-3 border" style="border-color: var(--glass-border) !important; background: rgba(255,255,255,0.02);">
                <div class="d-flex justify-content-between align-items-center mb-2">
                    <strong class="small">مرسل #${index + 1}</strong>
                    ${senderEntryRows.length > 1 ? `<button type="button" class="btn btn-sm btn-outline-danger" onclick="removeSenderEntryRow('${row.id}')"><i class="fa-solid fa-trash"></i></button>` : ''}
                </div>
                <div class="row g-2">
                    <div class="col-md-6">
                        <label class="form-label small fw-bold">رقم الهاتف</label>
                        <input type="text" class="form-control fw-bold text-center sender-entry-phone" data-row-id="${row.id}" placeholder="01108172258" inputmode="numeric" maxlength="11" dir="ltr">
                    </div>
                    <div class="col-md-6">
                        <label class="form-label small fw-bold">المبلغ</label>
                        <input type="number" class="form-control fw-bold text-center sender-entry-amount" data-row-id="${row.id}" min="1" step="1" placeholder="20000">
                    </div>
                    <div class="col-12">
                        <label class="form-label small fw-bold">صورة الإثبات</label>
                        <input type="file" class="form-control sender-entry-proof" data-row-id="${row.id}" accept="image/*">
                        ${row.preview ? `<img src="${row.preview}" class="mt-2 rounded-3 border" style="max-height:90px; object-fit:cover;">` : ''}
                    </div>
                </div>
            </div>
        `
        )
        .join('');

    container.querySelectorAll('.sender-entry-amount').forEach((input) => {
        input.addEventListener('input', updateSplitAmountSummary);
    });
    container.querySelectorAll('.sender-entry-proof').forEach((input) => {
        input.addEventListener('change', async (event) => {
            const rowId = event.target.dataset.rowId;
            const file = event.target.files?.[0];
            const row = senderEntryRows.find((item) => item.id === rowId);
            if (!row || !file) return;
            row.file = file;
            row.preview = await compressSingleImagePromise(file);
            renderSenderEntryRows();
        });
    });
    updateSplitAmountSummary();
}

function updateSplitAmountSummary() {
    const summary = document.getElementById('splitAmountSummary');
    if (!summary) return;
    const total = Array.from(document.querySelectorAll('.sender-entry-amount')).reduce(
        (sum, input) => sum + Number(input.value || 0),
        0
    );
    summary.textContent = `المجموع: ${total.toLocaleString('en-US')} / ${Number(currentCompletingAmount || 0).toLocaleString('en-US')} ج.م`;
    summary.className = `mt-2 small fw-bold ${Math.abs(total - Number(currentCompletingAmount || 0)) <= 0.01 ? 'text-success' : 'text-danger'}`;
}

function phoneLengthAllowed(digits) {
    const lengths = executorManualPolicy.allowedPhoneLengths || [3, 4, 11];
    return lengths.includes(digits.length);
}

function validateSenderPhoneInput(phone, isSplit) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return 'رقم المرسل مطلوب.';
    if (isSplit && executorManualPolicy.splitRequiresFullPhone) {
        return /^01\d{9}$/.test(digits) ? '' : 'عند تقسيم العملية يجب إدخال 11 رقمًا كاملة.';
    }
    if (!phoneLengthAllowed(digits)) {
        return `طول الرقم غير مسموح. المسموح: ${(executorManualPolicy.allowedPhoneLengths || []).join(' أو ')} أرقام.`;
    }
    if (digits.length === 11 && !/^01\d{9}$/.test(digits)) {
        return 'رقم الهاتف الكامل يجب أن يبدأ بـ 01.';
    }
    return '';
}

function isBankTransferCompletion() {
    const type = String(currentCompletingTransferType || '')
        .trim()
        .toLowerCase();
    return type === 'bank_account' || type === 'bank_transfer';
}

function updateProofRequirement() {
    const title = document.getElementById('proofRequirementTitle');
    const hint = document.getElementById('proofRequirementHint');
    const bankTransfer = isBankTransferCompletion();
    const splitBlock = document.getElementById('splitOperationBlock');
    const phoneBlock = document.getElementById('singleSenderBlock');
    const bankNote = document.getElementById('bankTransferCompletionNote');
    if (splitBlock) splitBlock.classList.toggle('d-none', bankTransfer);
    if (phoneBlock) phoneBlock.classList.toggle('d-none', bankTransfer);
    if (bankNote) {
        bankNote.classList.toggle('d-none', !bankTransfer);
        const bank = String(currentCompletingBankName || '').trim();
        bankNote.textContent = bank
            ? `تحويل بنكي — ${bank}: أرفق صورة الإثبات فقط. تُرسل الصورة نفسها للعميل، دون رقم هاتف ودون تقسيم.`
            : 'تحويل بنكي: أرفق صورة الإثبات فقط. تُرسل الصورة نفسها للعميل، دون رقم هاتف ودون تقسيم.';
    }
    if (bankTransfer) {
        const splitToggle = document.getElementById('splitOperationToggle');
        if (splitToggle) splitToggle.checked = false;
        document.getElementById('splitSenderBlock')?.classList.add('d-none');
        if (title) title.textContent = 'إرفاق صورة الإثبات إجباري';
        if (hint) hint.textContent = 'تُرسل صورة الإثبات نفسها للعميل. لا يُنشأ إيصال تلقائي للتحويل البنكي.';
        dropZone.classList.add('border-danger');
        return;
    }
    if (executorManualPolicy.proofRequired) {
        if (title) title.textContent = 'إرفاق الصورة إجباري';
        if (hint)
            hint.textContent =
                'يجب إرفاق صورة إثبات لكل رقم مرسل عند تقسيم العملية، أو صورة واحدة على الأقل عند رقم واحد.';
        dropZone.classList.add('border-danger');
    } else {
        if (title) title.textContent = 'إرفاق الصور اختياري';
        if (hint) hint.textContent = 'يمكنك إرفاق حتى خمس صور، أو المتابعة لإنشاء إيصال نظام تلقائي';
        dropZone.classList.remove('border-danger');
    }
}

function resetUploadModal() {
    selectedFilesArray = [];
    proofInput.value = '';
    previewsGrid.innerHTML = '';
    document.getElementById('senderPhoneInput').value = '';
    document.getElementById('splitOperationToggle').checked = false;
    senderEntryRows = [];
    document.getElementById('singleSenderBlock').classList.remove('d-none');
    document.getElementById('splitSenderBlock').classList.add('d-none');
    document.getElementById('senderEntriesContainer').innerHTML = '';
    updateProofRequirement();
}

function compressSingleImagePromise(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function (event) {
            const img = new Image();
            img.onload = function () {
                const canvas = document.createElement('canvas');
                const MAX_WIDTH = 1200;
                const MAX_HEIGHT = 1600;
                let width = img.width;
                let height = img.height;
                if (width > height) {
                    if (width > MAX_WIDTH) {
                        height *= MAX_WIDTH / width;
                        width = MAX_WIDTH;
                    }
                } else {
                    if (height > MAX_HEIGHT) {
                        width *= MAX_HEIGHT / height;
                        height = MAX_HEIGHT;
                    }
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.6));
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });
}
