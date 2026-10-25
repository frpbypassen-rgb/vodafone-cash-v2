import {
    escapeHtml,
    formatDateTime,
    parseJsonResponse,
    config,
    showFormResult,
    fileToDataUrl,
    portalFetch,
    portalUrl,
} from './core.js';

const supportMessages = document.getElementById('supportMessages');

const supportForm = document.getElementById('supportMessageForm');

const supportResult = document.getElementById('supportMessageResult');

let supportMessagesSignature = '';

const buildSupportMessagesSignature = (messages) =>
    JSON.stringify(
        (messages || []).map((message) => [
            message._id || '',
            message.sender || '',
            message.text || '',
            message.imageUrl || '',
            message.channel || '',
            message.createdAt || '',
        ])
    );

const renderSupportMessages = (messages) => {
    if (!supportMessages) return;
    const signature = buildSupportMessagesSignature(messages);
    if (signature === supportMessagesSignature) return;
    const isNearBottom =
        supportMessages.scrollHeight - supportMessages.clientHeight <= supportMessages.scrollTop + 56;
    supportMessagesSignature = signature;
    if (!messages?.length) {
        supportMessages.innerHTML =
            '<div class="bw-empty"><i class="fa-regular fa-comments"></i><strong>ابدأ المحادثة</strong><span>أرسل تفاصيل استفسارك وسيظهر رد الدعم هنا.</span></div>';
        return;
    }
    supportMessages.innerHTML = messages
        .map(
            (message) => `
            <article class="bw-chat-message ${['admin', 'ai'].includes(message.sender) ? 'admin' : 'user'}">
                <header><strong>${escapeHtml(['admin', 'ai'].includes(message.sender) ? 'فريق الدعم' : message.senderName || 'أنت')}${message.channel === 'whatsapp' ? ' <i class="fa-brands fa-whatsapp" title="رسالة واتساب" aria-hidden="true"></i>' : ''}</strong><time>${escapeHtml(formatDateTime(message.createdAt))}</time></header>
                ${message.text ? `<p>${escapeHtml(message.text)}</p>` : ''}
                ${message.imageUrl ? `<img src="${escapeHtml(message.imageUrl)}" alt="صورة مرفقة بالمحادثة">` : ''}
            </article>
        `
        )
        .join('');
    if (isNearBottom) supportMessages.scrollTop = supportMessages.scrollHeight;
};

const loadSupportMessages = async () => {
    if (!supportMessages) return;
    try {
        const response = await portalFetch(portalUrl('/client/api/support/messages'), {
            headers: { Accept: 'application/json' },
        });
        const payload = await parseJsonResponse(response);
        if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تحميل المحادثة.');
        renderSupportMessages(payload.messages || []);
    } catch (error) {
        supportMessages.innerHTML = `<div class="bw-empty"><i class="fa-solid fa-circle-exclamation"></i><strong>${escapeHtml(error.message)}</strong></div>`;
    }
};

supportForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!supportForm.reportValidity()) return;
    const submit = supportForm.querySelector('button[type="submit"]');
    const textInput = supportForm.elements.text;
    const imageInput = supportForm.elements.image;
    try {
        if (submit) submit.disabled = true;
        const imageBase64 = await fileToDataUrl(imageInput?.files?.[0]);
        const response = await portalFetch(portalUrl('/client/api/support/messages'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'x-csrf-token': config.csrfToken || '',
            },
            body: JSON.stringify({ text: textInput.value.trim(), imageBase64 }),
        });
        const payload = await parseJsonResponse(response);
        if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر إرسال الرسالة.');
        supportForm.reset();
        showFormResult(supportResult, 'تم إرسال الرسالة إلى فريق الدعم.', true);
        await loadSupportMessages();
    } catch (error) {
        showFormResult(supportResult, error.message || 'تعذر إرسال الرسالة.', false);
    } finally {
        if (submit) submit.disabled = false;
    }
});

if (supportMessages) {
    loadSupportMessages();
    window.setInterval(loadSupportMessages, 5000);
}
