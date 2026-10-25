// Share the authenticated image file. A private receipt URL cannot be opened by a WhatsApp recipient.
const files = new Map();
const MAX_BYTES = 8 * 1024 * 1024;

const receiptUrl = (value) => {
    const url = new URL(value, location.origin);
    if (
        url.origin !== location.origin ||
        !/^\/agent-portal\/proxy\/image\/[^/]+(?:\/\d+)?$/.test(url.pathname)
    ) {
        throw new Error('رابط صورة العملية غير صالح.');
    }
    return url.href;
};

const pngFromSvg = async (blob) => {
    const url = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('تعذر قراءة صورة العملية.');
        const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!png) throw new Error('تعذر تجهيز صورة العملية.');
        return png;
    } finally {
        URL.revokeObjectURL(url);
    }
};

const loadFile = async (button) => {
    const url = receiptUrl(button.dataset.receiptUrl);
    if (files.has(url)) return files.get(url);
    const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error('تعذر تحميل الصورة. تأكد من اتصالك وصلاحية جلسة الدخول.');
    let blob = await response.blob();
    const mime = blob.type.split(';')[0].toLowerCase();
    if (!/^image\/(png|jpeg|webp|gif|svg\+xml)$/i.test(mime) || !blob.size || blob.size > MAX_BYTES) {
        throw new Error('الملف المستلم ليس صورة صالحة للمشاركة أو حجمه كبير.');
    }
    if (blob.type !== mime) blob = new Blob([blob], { type: mime });
    if (blob.type === 'image/svg+xml') blob = await pngFromSvg(blob);
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[
        blob.type
    ];
    const name =
        String(button.dataset.receiptName || 'operation')
            .replace(/[^a-zA-Z0-9_-]/g, '')
            .slice(0, 80) || 'operation';
    const file = new File([blob], `receipt-${name}.${extension}`, { type: blob.type });
    if (files.size >= 3) files.delete(files.keys().next().value);
    files.set(url, file);
    return file;
};

const statusFor = (button, text) => {
    const container = button.closest('.agent-daily-actions, .bw-receipt-actions, .agent-lightbox-actions');
    let status = container?.querySelector('.agent-share-status');
    if (!status && container) {
        status = document.createElement('span');
        status.className = 'agent-share-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        container.append(status);
    }
    if (status) {
        status.textContent = text;
        status.hidden = !text;
    }
};

const downloadFile = (file) => {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
};

document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-agent-share-receipt]');
    if (!button || button.disabled || document.documentElement.dataset.portal !== 'agent') return;
    event.preventDefault();
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    statusFor(button, 'جارٍ تجهيز الصورة…');
    try {
        const file = await loadFile(button);
        if (navigator.share && navigator.canShare?.({ files: [file] })) {
            // Slow image downloads can consume the browser's user activation.
            // Keep the file ready so the next tap can open native sharing immediately.
            if (navigator.userActivation && !navigator.userActivation.isActive) {
                statusFor(button, 'الصورة جاهزة. اضغط مشاركة الصورة مرة أخرى ثم اختر واتساب.');
                return;
            }
            await navigator.share({ files: [file], title: 'صورة العملية' });
            statusFor(button, 'تم تسليم الصورة إلى تطبيق المشاركة.');
        } else {
            downloadFile(file);
            statusFor(button, 'تم طلب تنزيل الصورة. افتح واتساب وأرفقها من التنزيلات.');
        }
    } catch (error) {
        statusFor(
            button,
            error.name === 'AbortError'
                ? ''
                : error.name === 'NotAllowedError'
                  ? 'الصورة جاهزة. اضغط مشاركة الصورة مرة أخرى للسماح بالمشاركة.'
                  : error.message || 'تعذرت مشاركة الصورة. أعد المحاولة.'
        );
    } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
    }
});
