(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.mount(root);
})(typeof window === 'undefined' ? this : window, function () {
    'use strict';
    const canShareFile = (file, navigator) => {
        try {
            return Boolean(file && navigator.share && navigator.canShare?.({ files: [file] }));
        } catch (_) {
            return false;
        }
    };
    const shareFile = async (file, navigator) => {
        if (!canShareFile(file, navigator)) throw new Error('SHARE_UNSUPPORTED');
        // The file is prepared before the click: preserve native user activation.
        await navigator.share({ files: [file], title: 'إثبات العملية' });
    };
    const mount = (window) => {
        const document = window.document,
            dialog = document.querySelector('[data-retail-operation-dialog]');
        if (!dialog || typeof dialog.showModal !== 'function') return;
        const find = (selector) => dialog.querySelector(selector),
            image = find('[data-ro-image]');
        let detailsController,
            proofController,
            generation = 0,
            imageUrl = '',
            currentFile,
            transactionId = '',
            transaction,
            trigger;
        const notify = (text) => {
            find('[data-ro-message]').textContent = text;
        };
        const clearProof = () => {
            proofController?.abort();
            currentFile = null;
            if (imageUrl) window.URL.revokeObjectURL(imageUrl);
            imageUrl = '';
            image.removeAttribute('src');
            image.hidden = true;
            find('[data-ro-download]').hidden = true;
            find('[data-ro-download]').removeAttribute('href');
            find('[data-ro-share]').disabled = true;
            find('[data-ro-share-help]').textContent = '';
        };
        const textValue = (value) =>
            value === null || value === undefined || value === '' ? 'غير مسجل' : String(value);
        const money = (value, currency, digits = 2) =>
            value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
                ? 'غير مسجل'
                : Number(value).toLocaleString('en-US', {
                      minimumFractionDigits: digits,
                      maximumFractionDigits: digits,
                  }) +
                  ' ' +
                  currency;
        const date = (value) =>
            value && Number.isFinite(Date.parse(value))
                ? new Date(value).toLocaleString('ar-LY', { timeZone: 'Africa/Tripoli' })
                : 'غير مسجل';
        const renderDetails = (tx) => {
            find('[data-ro-reference]').textContent = tx.reference;
            const list = find('[data-ro-details]');
            list.replaceChildren();
            const fields = [
                ['الخدمة', tx.service],
                ['الحالة', tx.status],
                ['رقم المستلم / الحساب', tx.recipient],
                ['اسم المستلم', tx.recipientName],
                ['المبلغ', money(tx.amount, tx.currency)],
                ['التكلفة', money(tx.costLYD, 'LYD', 3)],
                ['سعر الصرف', tx.exchangeRate],
                ['تاريخ الطلب', date(tx.createdAt)],
            ];
            if (tx.completedAt) fields.push(['تاريخ الإتمام', date(tx.completedAt)]);
            if (tx.notes) fields.push(['ملاحظتك', tx.notes]);
            if (tx.cancellationReason) fields.push(['سبب الإلغاء', tx.cancellationReason]);
            fields.forEach(([label, value]) => {
                const row = document.createElement('div'),
                    term = document.createElement('dt'),
                    description = document.createElement('dd');
                term.textContent = label;
                description.textContent = textValue(value);
                row.append(term, description);
                list.append(row);
            });
        };
        const decode = (url) =>
            new Promise((resolve, reject) => {
                const picture = new window.Image(),
                    timer = setTimeout(() => reject(new Error('تعذر قراءة صورة الإثبات.')), 20000);
                picture.onload = () => {
                    clearTimeout(timer);
                    resolve(picture);
                };
                picture.onerror = () => {
                    clearTimeout(timer);
                    reject(new Error('تعذر قراءة صورة الإثبات.'));
                };
                picture.src = url;
            });
        const loadProof = async (receipt, index) => {
            clearProof();
            proofController = new window.AbortController();
            const controller = proofController,
                token = generation;
            let pendingImageUrl = '';
            const proofMessage = find('[data-ro-proof-message]');
            proofMessage.textContent = 'جارٍ تحميل صورة الإثبات…';
            dialog
                .querySelectorAll('[data-ro-proof-index]')
                .forEach((button) =>
                    button.setAttribute('aria-pressed', String(Number(button.dataset.roProofIndex) === index))
                );
            try {
                const url = new window.URL(receipt.url, window.location.origin);
                if (
                    url.origin !== window.location.origin ||
                    !new RegExp(
                        '^/client/api/retail-transactions/' + transactionId + '/proof/[0-9]{1,3}$'
                    ).test(url.pathname) ||
                    url.search ||
                    url.hash
                )
                    throw new Error('رابط الإثبات غير صالح.');
                const response = await window.fetch(url.href, {
                    signal: controller.signal,
                    cache: 'no-store',
                    credentials: 'same-origin',
                });
                if (!response.ok) throw new Error('تعذر تحميل صورة الإثبات. أعد فتح العملية للمحاولة.');
                let blob = await response.blob();
                const mime = blob.type.split(';')[0].trim();
                if (mime !== blob.type) blob = new window.Blob([blob], { type: mime });
                if (
                    !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(
                        blob.type
                    ) ||
                    !blob.size ||
                    blob.size > 15 * 1024 * 1024
                )
                    throw new Error('صيغة الإثبات أو حجمه غير مناسب للعرض.');
                if (controller.signal.aborted || token !== generation) return;
                const sourceUrl = window.URL.createObjectURL(blob);
                pendingImageUrl = sourceUrl;
                let picture;
                try {
                    picture = await decode(sourceUrl);
                } catch (error) {
                    window.URL.revokeObjectURL(sourceUrl);
                    throw error;
                }
                if (controller.signal.aborted || token !== generation) {
                    window.URL.revokeObjectURL(sourceUrl);
                    return;
                }
                let fileBlob = blob;
                if (blob.type === 'image/svg+xml') {
                    if (
                        picture.naturalWidth * picture.naturalHeight > 16000000 ||
                        !picture.naturalWidth ||
                        !picture.naturalHeight
                    )
                        throw new Error('أبعاد الإثبات أكبر من الحد المناسب للعرض.');
                    const canvas = document.createElement('canvas');
                    canvas.width = picture.naturalWidth;
                    canvas.height = picture.naturalHeight;
                    canvas.getContext('2d').drawImage(picture, 0, 0);
                    fileBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
                    if (!fileBlob) {
                        window.URL.revokeObjectURL(sourceUrl);
                        throw new Error('تعذر تجهيز الصورة للمشاركة.');
                    }
                }
                if (controller.signal.aborted || token !== generation) {
                    window.URL.revokeObjectURL(sourceUrl);
                    return;
                }
                imageUrl = sourceUrl;
                pendingImageUrl = '';
                image.src = imageUrl;
                image.alt = receipt.label || 'صورة إثبات العملية';
                image.hidden = false;
                const extension =
                    { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[
                        fileBlob.type
                    ] || 'png';
                const name =
                    'receipt-' +
                    String(transaction.reference || transactionId)
                        .replace(/[^a-z0-9_-]/gi, '_')
                        .slice(0, 80) +
                    '-' +
                    (index + 1) +
                    '.' +
                    extension;
                currentFile = new window.File([fileBlob], name, { type: fileBlob.type });
                const download = find('[data-ro-download]');
                // The original SVG is displayed, while download/share use a raster image.
                if (fileBlob !== blob) {
                    window.URL.revokeObjectURL(imageUrl);
                    imageUrl = window.URL.createObjectURL(fileBlob);
                    image.src = imageUrl;
                }
                download.href = imageUrl;
                download.download = name;
                download.hidden = false;
                find('[data-ro-share]').disabled = !canShareFile(currentFile, window.navigator);
                find('[data-ro-share-help]').textContent = canShareFile(currentFile, window.navigator)
                    ? 'تُشارك الصورة نفسها عبر التطبيقات المتاحة على جهازك.'
                    : 'المشاركة المباشرة غير مدعومة في هذا المتصفح. حمّل الصورة ثم شاركها من جهازك.';
                proofMessage.textContent = receipt.label || 'صورة إثبات العملية';
            } catch (error) {
                if (!controller.signal.aborted && token === generation)
                    proofMessage.textContent = error.message || 'تعذر تحميل الإثبات.';
            } finally {
                if (pendingImageUrl) window.URL.revokeObjectURL(pendingImageUrl);
            }
        };
        const load = async () => {
            detailsController?.abort();
            clearProof();
            detailsController = new window.AbortController();
            const token = ++generation,
                controller = detailsController;
            find('[data-ro-content]').hidden = true;
            find('[data-ro-retry]').hidden = true;
            find('[data-ro-reference]').textContent = '';
            notify('جارٍ تحميل تفاصيل العملية…');
            try {
                const response = await window.fetch('/client/api/retail-transactions/' + transactionId, {
                    signal: controller.signal,
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'تعذر تحميل العملية.');
                if (controller.signal.aborted || token !== generation) return;
                transaction = data.transaction;
                renderDetails(transaction);
                find('[data-ro-content]').hidden = false;
                notify('');
                const receipts = Array.isArray(transaction.receipts) ? transaction.receipts : [],
                    tabs = find('[data-ro-tabs]');
                tabs.replaceChildren();
                tabs.hidden = receipts.length < 2;
                receipts.forEach((receipt, index) => {
                    const button = document.createElement('button');
                    button.className = 'button';
                    button.type = 'button';
                    button.textContent = 'إثبات ' + (index + 1);
                    button.dataset.roProofIndex = index;
                    button.addEventListener('click', () => void loadProof(receipt, index));
                    tabs.append(button);
                });
                if (receipts.length) void loadProof(receipts[0], 0);
                else {
                    find('[data-ro-proof-message]').textContent = 'لم تتم إضافة صورة إثبات لهذه العملية بعد.';
                    find('[data-ro-share-help]').textContent = 'يتاح التحميل والمشاركة بعد إضافة الإثبات.';
                }
            } catch (error) {
                if (!controller.signal.aborted && token === generation) {
                    notify(error.message || 'تعذر تحميل العملية.');
                    find('[data-ro-retry]').hidden = false;
                }
            }
        };
        document.addEventListener('click', (event) => {
            const link = event.target.closest('[data-home-transaction]');
            if (
                !link ||
                event.defaultPrevented ||
                event.button !== 0 ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.altKey ||
                !/^[a-f0-9]{24}$/i.test(link.dataset.homeTransaction)
            )
                return;
            event.preventDefault();
            trigger = link;
            transactionId = link.dataset.homeTransaction;
            if (!dialog.open) dialog.showModal();
            document.body.classList.add('ro-dialog-open');
            dialog.scrollTop = 0;
            void load();
        });
        find('[data-ro-close]').addEventListener('click', () => dialog.close());
        find('[data-ro-retry]').addEventListener('click', () => void load());
        find('[data-ro-share]').addEventListener('click', () => {
            if (!currentFile) return;
            void shareFile(currentFile, window.navigator)
                .then(() => notify('تمت مشاركة الصورة.'))
                .catch((error) => {
                    notify(
                        error.name === 'AbortError'
                            ? 'تم إلغاء المشاركة.'
                            : error.message === 'SHARE_UNSUPPORTED'
                              ? 'حمّل الصورة لمشاركتها من جهازك.'
                              : 'تعذرت مشاركة الصورة. يمكنك تحميلها والمحاولة من جهازك.'
                    );
                });
        });
        dialog.addEventListener('close', () => {
            generation++;
            detailsController?.abort();
            clearProof();
            document.body.classList.remove('ro-dialog-open');
            if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        });
        dialog.addEventListener('click', (event) => {
            if (event.target !== dialog) return;
            const r = dialog.getBoundingClientRect();
            if (
                event.clientX < r.left ||
                event.clientX > r.right ||
                event.clientY < r.top ||
                event.clientY > r.bottom
            )
                dialog.close();
        });
    };
    return { mount, canShareFile, shareFile };
});
