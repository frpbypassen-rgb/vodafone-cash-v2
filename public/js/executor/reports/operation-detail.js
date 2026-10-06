/* exported openOperationDetail */
function openOperationDetail(tx) {
    const modal = new bootstrap.Modal(document.getElementById('operationDetailModal'));
    document.getElementById('detailModalTitle').textContent =
        `تفاصيل العملية #${tx.customId || String(tx.id || '').slice(-6)}`;

    const dateObj = new Date(tx.createdAt);
    const dateStr = dateObj.toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' });
    const arrivalTime = dateObj.toLocaleTimeString('en-US', {
        timeZone: 'Africa/Tripoli',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    });
    const completionTime = tx.completedAt
        ? new Date(tx.completedAt).toLocaleTimeString('en-US', {
              timeZone: 'Africa/Tripoli',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: true,
          })
        : '---';
    let duration = '---';
    if (tx.executionDurationSeconds !== null && tx.executionDurationSeconds !== undefined) {
        const m = Math.floor(tx.executionDurationSeconds / 60);
        const s = tx.executionDurationSeconds % 60;
        duration = m > 0 ? `${m}د ${s}ث` : `${s}ث`;
    }

    let statusHtml = '';
    if (tx.status === 'completed') statusHtml = '<span class="badge-st st-done">مكتمل</span>';
    else if (tx.status === 'rejected' || tx.status === 'cancelled_by_admin')
        statusHtml = '<span class="badge-st st-fail">مرفوض</span>';
    else statusHtml = '<span class="badge-st st-pending">قيد التنفيذ</span>';

    let receiptImages = '';
    if (tx.receiptUrl) {
        receiptImages += `<a href="${tx.receiptUrl}" target="_blank"><img src="${tx.receiptUrl}" alt="إيصال النظام"></a>`;
    }

    let executorImages = '';
    if (tx.executorProofImageUrls && tx.executorProofImageUrls.length > 0) {
        executorImages = tx.executorProofImageUrls
            .map((url) => `<a href="${url}" target="_blank"><img src="${url}" alt="إثبات المنفذ"></a>`)
            .join('');
    }

    let senderInfo = '';
    const senderEntries = Array.isArray(tx.executorSenderEntries) ? tx.executorSenderEntries : [];
    if (senderEntries.length > 0) {
        senderInfo = `
                    <div class="x-detail-section-title"><i class="fa-solid fa-phone"></i> أرقام المرسلين والمبالغ</div>
                    <div class="d-grid gap-2">
                        ${senderEntries
                            .map(
                                (entry, index) => `
                            <div class="x-detail-item full" style="display:block;">
                                <div class="fw-bold mb-1">مرسل #${index + 1}</div>
                                <div><label>رقم الهاتف</label><span dir="ltr">${entry.phone || '---'}</span></div>
                                <div><label>المبلغ</label><span>${formatEgp(entry.amount || 0)}</span></div>
                                ${entry.partId ? `<div><label>مرجع الجزء</label><span dir="ltr">${entry.reference || entry.partId}</span></div>` : ''}
                                ${entry.status ? `<div><label>حالة الجزء</label><span>${entry.status}</span></div>` : ''}
                                ${entry.customerProofStatus ? `<div><label>حالة الإثبات</label><span>${entry.customerProofStatus}</span></div>` : ''}
                                ${entry.customerProofUrl ? `<div class="mt-2"><a href="${entry.customerProofUrl}" target="_blank"><img src="${entry.customerProofUrl}" alt="إثبات الجزء" style="max-height:120px;border-radius:10px;border:1px solid var(--x-border)"></a></div>` : ''}
                                ${entry.partId && entry.customerProofStatus && entry.customerProofStatus !== 'sent' ? `<button type="button" class="btn btn-sm btn-outline-warning mt-2 retry-part-proof" data-tx="${tx.id}" data-part="${entry.partId}">إعادة إرسال إثبات الجزء</button>` : ''}
                                ${entry.proofImageUrl ? `<div class="mt-2"><a href="${entry.proofImageUrl}" target="_blank"><img src="${entry.proofImageUrl}" alt="إثبات المرسل" style="max-height:120px;border-radius:10px;border:1px solid var(--x-border)"></a></div>` : ''}
                            </div>
                        `
                            )
                            .join('')}
                    </div>
                `;
    } else if (tx.executorExecutionNumber || tx.executorSenderPhone) {
        senderInfo = `
                    <div class="x-detail-section-title"><i class="fa-solid fa-phone"></i> بيانات المرسل</div>
                    <div class="x-detail-grid">
                        <div class="x-detail-item"><label>رقم هاتف المرسل</label><span dir="ltr">${tx.executorSenderPhone || tx.executorExecutionNumber || '---'}</span></div>
                    </div>
                `;
    }

    let ratingSection = '';
    if (tx.status === 'completed') {
        const isRated = tx.executorRating ? true : false;
        const stars = [1, 2, 3, 4, 5]
            .map(
                (n) =>
                    `<span class="star ${(tx.executorRating || 0) >= n ? 'active' : ''}" data-star="${n}"><i class="fa-solid fa-star"></i></span>`
            )
            .join('');
        ratingSection = `
                    <div class="x-detail-section-title"><i class="fa-solid fa-star"></i> تقييم أداء المنفذ</div>
                    <div class="x-detail-item full">
                        <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                            <div class="x-star-rating" id="ratingStars" data-tx="${tx.id}">${stars}</div>
                            <div id="ratingStatus" class="small fw-bold" style="color: var(--x-muted, #94a3b8);">${isRated ? 'تم التقييم' : 'اضغط على النجوم للتقييم'}</div>
                        </div>
                        ${!isRated ? `<div class="mt-2"><textarea id="ratingNote" class="form-control form-control-sm bg-transparent text-white border-secondary" rows="2" placeholder="ملاحظة اختيارية..."></textarea></div>` : tx.executorRatingNote ? `<div class="mt-2 text-white small" style="white-space:pre-line">${tx.executorRatingNote}</div>` : ''}
                    </div>
                `;
    }

    let voiceNoteSection = '';
    if (tx.voiceNote) {
        voiceNoteSection = `
                    <div class="x-detail-section-title"><i class="fa-solid fa-microphone"></i> ملاحظة صوتية</div>
                    <div class="x-voice-note"><audio controls src="${tx.voiceNote}"></audio></div>
                `;
    } else {
        voiceNoteSection = `
                    <div class="x-detail-section-title"><i class="fa-solid fa-microphone"></i> ملاحظة صوتية</div>
                    <div class="x-detail-item full">
                        <div class="d-flex align-items-center gap-2 flex-wrap">
                            <button class="btn btn-sm btn-outline-info" id="voiceRecordBtn" data-tx="${tx.id}"><i class="fa-solid fa-microphone"></i> تسجيل</button>
                            <input type="file" id="voiceFileInput" accept="audio/*" class="form-control form-control-sm bg-transparent text-white" style="max-width:220px">
                            <button class="btn btn-sm btn-primary" id="voiceUploadBtn" data-tx="${tx.id}"><i class="fa-solid fa-upload"></i> رفع</button>
                        </div>
                        <div id="voiceRecorderArea" class="mt-2 d-none">
                            <span class="badge bg-danger rounded-pill">تسجيل...</span>
                            <button class="btn btn-sm btn-outline-light ms-2" id="voiceStopBtn">إيقاف</button>
                        </div>
                    </div>
                `;
    }

    document.getElementById('detailModalBody').innerHTML = `
                <div class="x-detail-grid">
                    <div class="x-detail-item"><label>رقم العملية</label><span dir="ltr">#${tx.customId || String(tx.id || '').slice(-6)}</span></div>
                    <div class="x-detail-item"><label>النوع</label><span>${tx.transferTypeLabel || '---'}</span></div>
                    <div class="x-detail-item"><label>المبلغ</label><span class="text-success">${formatEgp(tx.amount)}</span></div>
                    <div class="x-detail-item"><label>الحالة</label><span>${statusHtml}</span></div>
                    <div class="x-detail-item"><label>وقت الوصول</label><span dir="ltr">${arrivalTime}</span></div>
                    <div class="x-detail-item"><label>وقت الإكمال</label><span dir="ltr">${completionTime}</span></div>
                    <div class="x-detail-item"><label>المدة</label><span>${duration}</span></div>
                    <div class="x-detail-item"><label>التاريخ</label><span dir="ltr">${dateStr}</span></div>
                    ${tx.executorName && !isPersonalExecutorReport ? `<div class="x-detail-item full"><label>المنفذ</label><span>${tx.executorName}</span></div>` : ''}
                    ${tx.recipientNumber ? `<div class="x-detail-item full"><label>رقم المستلم</label><span dir="ltr">${tx.recipientNumber}</span></div>` : ''}
                    ${tx.recipientName ? `<div class="x-detail-item full"><label>اسم المستلم</label><span>${tx.recipientName}</span></div>` : ''}
                    ${tx.notes ? `<div class="x-detail-item full"><label>ملاحظات</label><span style="font-family:inherit; white-space:pre-line; font-weight:400;">${tx.notes}</span></div>` : ''}
                </div>
                ${senderInfo}
                ${receiptImages || executorImages ? `<div class="x-detail-section-title"><i class="fa-solid fa-images"></i> صور الإيصال والإثبات</div><div class="x-detail-images">${receiptImages}${executorImages}</div>` : ''}
                ${
                    tx.receiptUrl
                        ? `
                    <div class="x-detail-section-title"><i class="fa-solid fa-qrcode"></i> QR للتحقق من الإيصال</div>
                    <div class="x-detail-item full" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(window.location.origin + tx.receiptUrl)}" alt="QR" style="width:120px;height:120px;border-radius:8px;border:1px solid var(--x-border)">
                        <span style="font-family:inherit;font-weight:400;font-size:0.82rem;color:var(--x-muted)">امسح الكود للتحقق من صحة الإيصال.</span>
                    </div>
                `
                        : ''
                }
                ${voiceNoteSection}
                ${ratingSection}
            `;

    const ratingContainer = document.getElementById('ratingStars');
    if (ratingContainer && !tx.executorRating) {
        ratingContainer.querySelectorAll('.star').forEach((star) => {
            star.onclick = async () => {
                const value = Number(star.dataset.star);
                const txId = ratingContainer.dataset.tx;
                const note = document.getElementById('ratingNote')?.value || '';
                try {
                    const res = await executorApiFetch(`/executor-portal/api/rate-task/${txId}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ rating: value, note }),
                    });
                    const data = await res.json();
                    if (data.success) {
                        ratingContainer.querySelectorAll('.star').forEach((s, i) => {
                            if (i < value) s.classList.add('active');
                            else s.classList.remove('active');
                        });
                        document.getElementById('ratingStatus').textContent = 'تم حفظ التقييم';
                        document.getElementById('ratingNote')?.parentElement?.classList.add('d-none');
                        Swal.fire({
                            icon: 'success',
                            title: 'تم التقييم',
                            timer: 1200,
                            showConfirmButton: false,
                        });
                    } else throw new Error(data.error);
                } catch (e) {
                    Swal.fire('خطأ', e.message || 'تعذر حفظ التقييم', 'error');
                }
            };
        });
    }

    setupVoiceRecorder(tx.id);

    const downloadBtn = document.getElementById('detailDownloadBtn');
    if (tx.receiptUrl) {
        downloadBtn.style.display = 'inline-flex';
        downloadBtn.onclick = () => window.downloadImages(tx.receiptUrl);
    } else {
        downloadBtn.style.display = 'none';
    }

    modal.show();
}
