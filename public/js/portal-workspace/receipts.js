import {
    portalUrl,
    escapeHtml,
    formatNumber,
    config,
    formatDateTime,
    parseJsonResponse,
    openDialog,
    portalFetch,
} from './core.js';
import { formatExchangeRate } from './services.js';
import { whatsappNumberFrom } from './transfers.js';

const transactionDialog = document.getElementById('transactionDetailsDialog');

const transactionDetailsBody = document.getElementById('transactionDetailsBody');

const detailItem = (label, value, mono = false) => {
    if (value === undefined || value === null || value === '') return '';
    return `<div class="bw-detail-item"><span>${escapeHtml(label)}</span><strong class="${mono ? 'bw-mono' : ''}">${escapeHtml(value)}</strong></div>`;
};

const renderReceiptGallery = (transaction) => {
    const receiptImages = Array.isArray(transaction.receiptImages) ? transaction.receiptImages : [];
    if (!receiptImages.length) {
        return `
                <section class="bw-receipt-section">
                    <header class="bw-receipt-section-head">
                        <div><span>مستندات التنفيذ</span><strong><i class="fa-regular fa-image"></i> صورة الإثبات</strong></div>
                    </header>
                    <div class="bw-receipt-empty">
                        <i class="fa-regular fa-image"></i>
                        <strong>لا توجد صورة إثبات</strong>
                        <span>لم يُرفق إثبات مرئي لهذه العملية بعد.</span>
                    </div>
                </section>
            `;
    }

    return `
            <section class="bw-receipt-section">
                <header class="bw-receipt-section-head">
                    <div><span>مستندات التنفيذ</span><strong><i class="fa-solid fa-receipt"></i> صور الإثبات</strong></div>
                    <span class="bw-meta-chip">${formatNumber(receiptImages.length)} ${receiptImages.length === 1 ? 'صورة' : 'صور'}</span>
                </header>
                <div class="bw-receipt-gallery">
                    ${receiptImages
                        .map((image, index) => {
                            const url = escapeHtml(portalUrl(image.url));
                            const label = escapeHtml(image.label || `صورة الإثبات ${index + 1}`);
                            return `
                            <figure class="bw-receipt-figure">
                                <a href="${url}" class="bw-receipt-preview" data-receipt-lightbox data-receipt-url="${url}" data-receipt-label="${label}" title="تكبير ${label}">
                                    <img src="${url}" alt="${label}" loading="eager" data-receipt-image>
                                </a>
                                <figcaption>
                                    <strong>${label}</strong>
                                    <span class="bw-receipt-actions">
                                        <button type="button" class="bw-icon-button compact" data-receipt-lightbox data-receipt-url="${url}" data-receipt-label="${label}" title="تكبير الصورة" aria-label="تكبير ${label}"><i class="fa-solid fa-expand"></i></button>
                                        <a href="${url}" download="proof-${escapeHtml(transaction.customId || index + 1)}-${index + 1}" class="bw-icon-button compact receipt" title="تحميل الصورة" aria-label="تحميل ${label}"><i class="fa-solid fa-download"></i></a>
                                    </span>
                                </figcaption>
                            </figure>
                        `;
                        })
                        .join('')}
                </div>
            </section>
        `;
};

const renderPartProofDetails = (transaction) => {
    const parts = Array.isArray(transaction.partProofs) ? transaction.partProofs : [];
    if (parts.length < 2) return '';
    return `
            <section class="bw-receipt-section">
                <header class="bw-receipt-section-head">
                    <div><span>أجزاء التحويل</span><strong>إثبات كل جزء</strong></div>
                </header>
                <div class="bw-detail-grid">
                    ${parts
                        .map(
                            (part) => `
                        ${detailItem(`الجزء ${part.partId}`, part.proofAvailable ? 'ناجح' : part.proofStatus || part.status || '')}
                        ${detailItem('مبلغ الجزء', formatNumber(part.amount, 0), true)}
                        ${detailItem('المحفظة المرسلة', part.senderWallet, true)}
                        ${detailItem('رقم المستلم', part.recipient, true)}
                        ${detailItem('المرجع', part.partReference || part.reference, true)}
                    `
                        )
                        .join('')}
                </div>
            </section>
        `;
};

const renderTransactionDetails = (transaction) => {
    const serviceDetails = transaction.serviceDetails || {};
    const statusTone = ['completed', 'deposit'].includes(transaction.status)
        ? 'success'
        : ['pending', 'processing', 'accepted', 'deposit_pending'].includes(transaction.status)
          ? 'warning'
          : 'danger';
    const whatsappHint = serviceDetails.clientPhone || transaction.destination;
    const whatsappIntl = whatsappNumberFrom(whatsappHint);
    const whatsappHref = whatsappIntl
        ? `https://wa.me/${whatsappIntl}?text=${encodeURIComponent(`بخصوص عملية التحويل${transaction.customId ? ` رقم ${transaction.customId}` : ''} لدى الأهرام.`)}`
        : '';
    const isCompanyWorkspace = config.workspaceType === 'company';
    const whatsappButtonClass = isCompanyWorkspace ? 'primary' : 'ghost';
    return `
            <div class="bw-detail-hero">
                <div><small>رقم العملية</small><strong class="bw-mono">${escapeHtml(transaction.customId)}</strong></div>
                <div class="bw-detail-hero-state">
                    <span class="bw-status ${statusTone}">${escapeHtml(transaction.statusLabel)}</span>
                    ${transaction.hasProof ? '<span class="bw-receipt-chip"><i class="fa-solid fa-receipt"></i> إثبات متاح</span>' : '<span class="bw-receipt-chip empty"><i class="fa-regular fa-image"></i> بدون إثبات</span>'}
                </div>
            </div>
            ${renderReceiptGallery(transaction)}
            ${renderPartProofDetails(transaction)}
            <div class="bw-detail-grid">
                ${detailItem('الخدمة', transaction.serviceLabel)}
                ${detailItem('المبلغ', `${formatNumber(transaction.amount, 0)} ${transaction.amountCurrencyLabel || 'EGP'}`, true)}
                ${config.canViewBalance ? detailItem('التكلفة', `${formatNumber(transaction.costLYD, 3)} LYD`, true) : ''}
                ${config.canViewBalance ? detailItem('سعر الصرف', formatExchangeRate(transaction.exchangeRate, transaction), true) : ''}
                ${detailItem('رقم المستلم / الحساب', transaction.destination, true)}
                ${detailItem('اسم المستفيد', transaction.accountName)}
                ${isCompanyWorkspace ? '' : detailItem('العميل', transaction.customerName || 'الحساب الرئيسي')}
                ${detailItem('أرسلها الموظف', transaction.employeeName)}
                ${detailItem('نوع سيفا', serviceDetails.subtype)}
                ${detailItem('المدينة', serviceDetails.city)}
                ${detailItem('تأكيد صحة بيانات سيفا', serviceDetails.dataEntryAcknowledged ? 'تم التأكيد قبل الإرسال' : '')}
                ${detailItem('الرقم القومي', serviceDetails.nationalId, true)}
                ${detailItem('المحافظة', serviceDetails.governorate)}
                ${detailItem(isCompanyWorkspace ? 'واتساب المستلم' : 'رقم هاتف العميل', serviceDetails.clientPhone, true)}
                ${detailItem('البنك', serviceDetails.bankName)}
                ${detailItem('تاريخ الإنشاء', formatDateTime(transaction.createdAt), true)}
                ${detailItem('رقم الإلغاء', transaction.cancellationNumber, true)}
                ${detailItem('سبب الإلغاء', transaction.cancellationReason)}
            </div>
            <div class="bw-detail-notes"><span>ملاحظة العميل</span><p>${escapeHtml(transaction.notes || 'لا توجد ملاحظة')}</p></div>
            ${whatsappHref ? `<div class="cos-detail-actions"><a class="bw-button ${whatsappButtonClass}" href="${whatsappHref}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i>واتساب المستلم</a></div>` : ''}
        `;
};

const openTransactionDetails = async (transactionId, focusReceipt = false) => {
    if (!transactionDialog || !transactionDetailsBody) return;
    transactionDetailsBody.scrollTop = 0;
    transactionDetailsBody.innerHTML =
        '<div class="bw-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><span>جارٍ تحميل التفاصيل...</span></div>';
    openDialog(transactionDialog);
    try {
        const response = await portalFetch(
            `/client/transactions/${encodeURIComponent(transactionId)}/details`,
            { headers: { Accept: 'application/json' } }
        );
        const payload = await parseJsonResponse(response);
        if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تحميل التفاصيل.');
        transactionDetailsBody.innerHTML = renderTransactionDetails(payload.transaction);
        if (focusReceipt) {
            const receiptSection = transactionDetailsBody.querySelector('.bw-receipt-section');
            if (receiptSection) {
                transactionDetailsBody.scrollTo({
                    top: Math.max(0, receiptSection.offsetTop - transactionDetailsBody.offsetTop - 10),
                    behavior: 'auto',
                });
            }
        }
    } catch (error) {
        transactionDetailsBody.innerHTML = `<div class="bw-empty"><i class="fa-solid fa-circle-exclamation"></i><strong>${escapeHtml(error.message)}</strong></div>`;
    }
};

document.querySelectorAll('[data-transaction-id]').forEach((button) => {
    button.addEventListener('click', () =>
        openTransactionDetails(button.dataset.transactionId, button.hasAttribute('data-receipt-focus'))
    );
});

const receiptLightbox = document.getElementById('receiptLightbox');

const receiptLightboxImage = document.getElementById('receiptLightboxImage');

const receiptLightboxCaption = document.getElementById('receiptLightboxCaption');

const closeReceiptLightbox = () => {
    if (receiptLightbox && receiptLightbox.open) receiptLightbox.close();
    if (receiptLightboxImage) receiptLightboxImage.removeAttribute('src');
};

const openReceiptLightbox = (url, label) => {
    if (!receiptLightbox || !receiptLightboxImage || !url) return;
    receiptLightboxImage.src = url;
    receiptLightboxImage.alt = label || 'صورة الإثبات';
    if (receiptLightboxCaption) receiptLightboxCaption.textContent = label || 'صورة الإثبات';
    if (typeof receiptLightbox.showModal === 'function') receiptLightbox.showModal();
    else receiptLightbox.setAttribute('open', '');
};

document.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-lightbox-close]');
    if (closer) {
        event.preventDefault();
        closeReceiptLightbox();
        return;
    }
    const trigger = event.target.closest('[data-receipt-lightbox]');
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    openReceiptLightbox(
        trigger.getAttribute('data-receipt-url') || trigger.getAttribute('href'),
        trigger.getAttribute('data-receipt-label') || trigger.getAttribute('title') || 'صورة الإثبات'
    );
});

receiptLightbox?.addEventListener('cancel', closeReceiptLightbox);

receiptLightbox?.addEventListener('click', (event) => {
    if (event.target === receiptLightbox) closeReceiptLightbox();
});

export { openTransactionDetails };
