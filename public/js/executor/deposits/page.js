(() => {
    const input = document.getElementById('depositReceipts');
    const dropZone = document.getElementById('depositDropZone');
    const preview = document.getElementById('receiptPreview');
    const submitBtn = document.getElementById('submitDepositBtn');
    const amountInput = document.getElementById('depositAmount');
    const receiptCountLabel = document.getElementById('receiptCountLabel');
    const clearReceiptsBtn = document.getElementById('clearReceipts');
    const depositLiveBadge = document.getElementById('depositLiveBadge');
    let selectedFiles = [];
    let refreshTimer = null;
    let requestsCache = [];
    const canReviewAdminDeposits = Boolean(window.executorDepositConfig.canReviewAdminDeposits);
    const isExternalDepositView = Boolean(window.executorDepositConfig.isExternalDepositView);

    if (window.matchMedia('(pointer: coarse)').matches) {
        input.setAttribute('capture', 'environment');
    }

    const esc = (value) =>
        String(value || '').replace(
            /[&<>"']/g,
            (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
        );
    const date = (value) =>
        value ? new Date(value).toLocaleString('ar-LY', { dateStyle: 'medium', timeStyle: 'short' }) : '---';

    function updateSubmitState() {
        const amount = Number(amountInput.value);
        submitBtn.disabled = !(selectedFiles.length > 0 && Number.isFinite(amount) && amount > 0);
    }

    function syncInputFiles() {
        try {
            const dataTransfer = new DataTransfer();
            selectedFiles.forEach((file) => dataTransfer.items.add(file));
            input.files = dataTransfer.files;
        } catch (_) {
            // بعض المتصفحات القديمة لا تدعم DataTransfer — selectedFiles تكفي للإرسال.
        }
        receiptCountLabel.textContent = selectedFiles.length
            ? `${selectedFiles.length} / 5 إيصالات جاهزة للإرسال`
            : 'لم تُرفق صور بعد';
        clearReceiptsBtn.classList.toggle('d-none', !selectedFiles.length);
        updateSubmitState();
    }

    function drawPreview() {
        preview.innerHTML = '';
        selectedFiles.forEach((file, index) => {
            const wrap = document.createElement('div');
            wrap.className = 'receipt-item';
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            img.onload = () => URL.revokeObjectURL(img.src);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'receipt-remove';
            remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            remove.addEventListener('click', () => {
                selectedFiles.splice(index, 1);
                drawPreview();
                syncInputFiles();
            });
            wrap.appendChild(img);
            wrap.appendChild(remove);
            preview.appendChild(wrap);
        });
        syncInputFiles();
    }

    function addFiles(files) {
        const incoming = [...files];
        for (const file of incoming) {
            if (selectedFiles.length >= 5) {
                Swal.fire('تنبيه', 'الحد الأقصى خمسة إيصالات.', 'warning');
                break;
            }
            if (file.size > 5 * 1024 * 1024) {
                Swal.fire('تنبيه', `الملف ${file.name} أكبر من 5MB.`, 'warning');
                continue;
            }
            selectedFiles.push(file);
        }
        drawPreview();
    }

    input.addEventListener('change', () => {
        const picked = [...input.files];
        input.value = '';
        addFiles(picked);
    });

    amountInput.addEventListener('input', updateSubmitState);

    ['dragenter', 'dragover'].forEach((eventName) => {
        dropZone.addEventListener(eventName, (event) => {
            event.preventDefault();
            dropZone.classList.add('is-dragover');
        });
    });
    ['dragleave', 'drop'].forEach((eventName) => {
        dropZone.addEventListener(eventName, (event) => {
            event.preventDefault();
            dropZone.classList.remove('is-dragover');
        });
    });
    dropZone.addEventListener('drop', (event) => {
        addFiles(event.dataTransfer?.files || []);
    });

    clearReceiptsBtn.addEventListener('click', () => {
        selectedFiles = [];
        drawPreview();
    });

    async function toDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function statusMeta(request) {
        if (request.status === 'deposit')
            return ['deposit', isExternalDepositView ? 'إيداع من المدير' : 'مقبول', 'fa-circle-check'];
        if (request.status === 'deduction') return ['rejected', 'خصم من المدير', 'fa-arrow-up-from-bracket'];
        if (request.status === 'rejected') return ['rejected', 'مرفوض', 'fa-circle-xmark'];
        return ['pending', 'قيد المراجعة', 'fa-clock'];
    }

    function renderRequests(requests) {
        const list = document.getElementById('depositList');
        if (!requests.length) {
            list.innerHTML = isExternalDepositView
                ? '<div class="empty"><i class="fa-regular fa-folder-open"></i>لا توجد حركات على رصيدك حتى الآن.<br><small class="mt-2 d-block">ستظهر هنا الإيداعات والخصومات التي ينفذها مدير الشركة لك.</small></div>'
                : '<div class="empty"><i class="fa-regular fa-folder-open"></i>لا توجد طلبات إيداع حتى الآن.</div>';
            return;
        }

        list.innerHTML = requests
            .map((request) => {
                const [tone, label, icon] = statusMeta(request);
                const thumbs = (request.receiptUrls || [])
                    .slice(0, 4)
                    .map(
                        (url, index) =>
                            `<img src="${esc(url)}" alt="إيصال ${index + 1}" data-image-url="${esc(url)}">`
                    )
                    .join('');
                const reviewedLine =
                    !isExternalDepositView && request.reviewedByName
                        ? `<div class="deposit-meta">آخر مراجعة: ${esc(request.reviewedByName)} · ${date(request.reviewedAt || request.updatedAt)}</div>`
                        : !isExternalDepositView
                          ? `<div class="deposit-meta">آخر تحديث: ${date(request.updatedAt || request.createdAt)}</div>`
                          : '';
                const rejectBlock = request.rejectionReason
                    ? `<div class="deposit-meta text-danger">سبب الرفض: ${esc(request.rejectionReason)}</div><button type="button" class="deposit-new-btn" data-scroll-form="1"><i class="fa-solid fa-rotate-right ms-1"></i>إنشاء طلب جديد</button>`
                    : '';
                const fromAdmin =
                    request.submittedByRole === 'admin' || request.submittedByRole === 'manager';
                const receiptSummary = isExternalDepositView ? '' : ` · ${request.receiptCount || 0} إيصال`;
                const reviewActions =
                    request.status === 'pending' && canReviewAdminDeposits
                        ? `<div class="deposit-review-box">
                        <div class="deposit-review-box-label"><i class="fa-solid fa-scale-balanced"></i> قرار المراجعة</div>
                        <p class="deposit-review-box-note">راجع الإيصالات ثم اختر قبول الإيداع لإضافة الرصيد، أو إلغاء الطلب مع توضيح السبب.</p>
                        <div class="deposit-review-actions">
                            <button type="button" class="deposit-review-action is-approve" data-admin-deposit-review="approve" data-request-id="${esc(request.id)}"><i class="fa-solid fa-circle-check"></i> قبول الإيداع</button>
                            <button type="button" class="deposit-review-action is-cancel" data-admin-deposit-review="reject" data-request-id="${esc(request.id)}"><i class="fa-solid fa-ban"></i> إلغاء الطلب</button>
                        </div>
                    </div>`
                        : request.status === 'pending'
                          ? `<div class="deposit-review-result is-warn"><i class="fa-solid fa-clock ms-1"></i> طلب قيد المراجعة بانتظار موافقة مدير الشركة.</div>`
                          : '';
                return `
                    <article class="deposit-review-card ${tone === 'pending' ? 'is-pending' : ''}">
                        <header class="deposit-review-card-head">
                            <div>
                                <div class="deposit-ref">${esc(request.customId)}</div>
                                <div class="deposit-meta">${isExternalDepositView ? 'حركة صادرة من مدير شركة التنفيذ' : fromAdmin ? 'طلب وارد من الإدارة' : 'طلب مقدم من الشركة'} · ${esc(request.note || 'لا توجد ملاحظة')} · ${date(request.createdAt)}${receiptSummary}</div>
                                ${reviewedLine}
                                ${rejectBlock}
                            </div>
                            <div class="deposit-review-card-side">
                                <div class="deposit-value">${Number(request.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} EGP</div>
                                <span class="status ${tone}"><i class="fa-solid ${icon}"></i>${label}</span>
                            </div>
                        </header>
                        ${thumbs ? `<div class="deposit-thumbs">${thumbs}</div>` : ''}
                        ${reviewActions}
                    </article>
                `;
            })
            .join('');
    }

    async function loadRequests(options = {}) {
        try {
            const data = await readExecutorApiResponse(
                await executorApiFetch('/executor-portal/api/deposits')
            );
            requestsCache = Array.isArray(data.requests) ? data.requests : [];
            renderRequests(requestsCache);
            const hasPending = requestsCache.some((request) => request.status === 'pending');
            depositLiveBadge.classList.toggle('is-active', hasPending);
            depositLiveBadge.innerHTML = hasPending
                ? '<i class="fa-solid fa-arrows-rotate fa-spin"></i> متابعة الطلبات قيد المراجعة'
                : '<i class="fa-solid fa-signal"></i> تحديث تلقائي';
            if (refreshTimer) window.clearInterval(refreshTimer);
            refreshTimer = hasPending
                ? window.setInterval(() => loadRequests({ silent: true }), 20000)
                : null;
            if (!options.silent && hasPending) {
                // no toast — silent background refresh only
            }
        } catch (error) {
            document.getElementById('depositList').innerHTML =
                `<div class="empty text-danger">${esc(error.message)}</div>`;
        }
    }

    document.getElementById('depositForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const amount = Number(amountInput.value);
        if (!selectedFiles.length) {
            await Swal.fire('إيصال مطلوب', 'أرفق صورة إيصال واحدة على الأقل قبل إرسال الطلب.', 'warning');
            return;
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            await Swal.fire('قيمة غير صالحة', 'أدخل قيمة إيداع أكبر من صفر.', 'warning');
            return;
        }
        submitBtn.disabled = true;
        const form = event.currentTarget;
        try {
            const receiptsBase64 = await Promise.all(selectedFiles.map(toDataUrl));
            const response = await executorApiFetch('/executor-portal/api/deposits', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amount: document.getElementById('depositAmount').value,
                    note: document.getElementById('depositNote').value,
                    receiptsBase64,
                }),
            });
            if (response.status === 413) {
                throw new Error('إجمالي الإيصالات كبير جداً. أرسل حتى 5 صور، وبحجم لا يتجاوز 5MB للصورة.');
            }
            const data = await readExecutorApiResponse(response);
            await Swal.fire({
                icon: 'success',
                title: 'تم إرسال الطلب',
                html: `<p>رقم الطلب: <b dir="ltr">${esc(data.request.customId)}</b></p><p class="small text-muted mb-0">الحالة الآن: <b>قيد المراجعة</b>. سيتم تحديث القائمة تلقائياً عند قبول أو رفض الطلب.</p>`,
                confirmButtonColor: '#0e9b86',
            });
            form.reset();
            amountInput.value = '';
            selectedFiles = [];
            drawPreview();
            await loadRequests();
        } catch (error) {
            Swal.fire('تعذر الإرسال', error.message, 'error');
        } finally {
            updateSubmitState();
        }
    });

    document.getElementById('depositList').addEventListener('click', async (event) => {
        const thumb = event.target.closest('[data-image-url]');
        if (thumb) {
            await Swal.fire({
                imageUrl: thumb.dataset.imageUrl,
                imageAlt: 'إيصال الإيداع',
                showConfirmButton: false,
                showCloseButton: true,
                width: 'min(920px, 96vw)',
            });
            return;
        }
        if (event.target.closest('[data-scroll-form="1"]')) {
            document.getElementById('depositAmount').focus();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
        const reviewButton = event.target.closest('[data-admin-deposit-review]');
        if (reviewButton) {
            const decision = reviewButton.dataset.adminDepositReview;
            let reason = '';
            if (decision === 'reject') {
                const result = await Swal.fire({
                    title: 'سبب إلغاء الإيداع',
                    input: 'textarea',
                    inputPlaceholder: 'اكتب سبباً واضحاً للإدارة...',
                    showCancelButton: true,
                    confirmButtonText: 'تأكيد الإلغاء',
                    cancelButtonText: 'تراجع',
                    inputValidator: (value) => (value?.trim().length >= 3 ? undefined : 'سبب الإلغاء مطلوب.'),
                });
                if (!result.isConfirmed) return;
                reason = result.value.trim();
            } else {
                const result = await Swal.fire({
                    icon: 'warning',
                    title: 'قبول الإيداع؟',
                    text: 'سيُضاف المبلغ إلى الرصيد الخاص للشركة، وبالتالي يرتفع إجمالي الرصيد.',
                    showCancelButton: true,
                    confirmButtonText: 'قبول وإضافة للرصيد الخاص',
                    cancelButtonText: 'تراجع',
                    confirmButtonColor: '#0e9b86',
                });
                if (!result.isConfirmed) return;
            }
            reviewButton.disabled = true;
            try {
                const response = await executorApiFetch(
                    `/executor-portal/api/deposits/${reviewButton.dataset.requestId}/review`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ decision, reason }),
                    }
                );
                await readExecutorApiResponse(response);
                await Swal.fire(
                    decision === 'approve' ? 'تم القبول' : 'تم الإلغاء',
                    decision === 'approve'
                        ? 'تمت إضافة المبلغ إلى الرصيد الخاص للشركة.'
                        : 'تم إرسال قرار الإلغاء إلى الإدارة.',
                    'success'
                );
                await loadRequests();
            } catch (error) {
                Swal.fire('تعذر حفظ القرار', error.message, 'error');
            }
        }
    });

    drawPreview();
    loadRequests();
    window.addEventListener('beforeunload', () => {
        if (refreshTimer) window.clearInterval(refreshTimer);
    });
})();
