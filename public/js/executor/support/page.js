(() => {
    const currentEmployeeName = window.executorSupportConfig.currentEmployeeName;
    const escapeHtml = (value) =>
        String(value ?? '').replace(
            /[&<>"']/g,
            (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
        );
    const formatDate = (value) =>
        value
            ? new Date(value).toLocaleString('ar-LY', {
                  timeZone: 'Africa/Tripoli',
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
              })
            : '';
    const roleLabel = (role) =>
        ({
            admin: 'الإدارة',
            manager: 'المدير',
            accountant: 'المحاسب',
            operator: 'موظف تنفيذ',
            external: 'منفذ خارجي',
        })[role] || 'الفريق';
    let loading = false;
    let fingerprint = null;
    let images = [];

    const filesToBase64 = async (files) =>
        Promise.all(
            Array.from(files)
                .slice(0, 3)
                .map(
                    (file) =>
                        new Promise((resolve, reject) => {
                            if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 2 * 1024 * 1024)
                                return reject(
                                    new Error('الصور يجب أن تكون JPG أو PNG أو WEBP وأقل من 2 ميجابايت.')
                                );
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result);
                            reader.onerror = reject;
                            reader.readAsDataURL(file);
                        })
                )
        );

    async function loadChat() {
        if (loading) return;
        loading = true;
        try {
            const data = await readExecutorApiResponse(
                await executorApiFetch('/executor-portal/api/support/group-chat')
            );
            const members = data.members || [];
            document.getElementById('groupMemberCount').textContent = `${members.length} مشاركين`;
            document.getElementById('groupMemberList').innerHTML = members
                .map(
                    (member) =>
                        `<span class="group-member"><b>${escapeHtml(member.name)}</b><small>${escapeHtml(roleLabel(member.role))}</small></span>`
                )
                .join('');
            const messages = data.ticket?.messages || [];
            const nextFingerprint = messages
                .map((message) => message.id || `${message.createdAt}:${message.text}`)
                .join('|');
            if (nextFingerprint !== fingerprint) {
                const list = document.getElementById('groupMessageList');
                const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
                list.innerHTML =
                    messages
                        .map((message) => {
                            const own =
                                message.sender === 'user' && message.senderName === currentEmployeeName;
                            const kind =
                                message.sender === 'system'
                                    ? 'is-system'
                                    : own
                                      ? 'is-own'
                                      : message.sender === 'admin'
                                        ? 'is-admin'
                                        : 'is-team';
                            return `<article class="group-message ${kind}"><b>${escapeHtml(message.senderName || (message.sender === 'admin' ? 'الإدارة' : 'موظف التنفيذ'))}</b>${message.imageUrl ? `<img src="${escapeHtml(message.imageUrl)}" alt="مرفق من ${escapeHtml(message.senderName || 'المشارك')}">` : ''}${message.text ? `<p>${escapeHtml(message.text)}</p>` : ''}<time>${formatDate(message.createdAt)}</time></article>`;
                        })
                        .join('') || '<div class="group-chat-loading">لا توجد رسائل بعد.</div>';
                fingerprint = nextFingerprint;
                if (nearBottom || messages.length < 2) list.scrollTop = list.scrollHeight;
            }
        } catch (error) {
            if (!fingerprint)
                document.getElementById('groupMessageList').innerHTML =
                    `<div class="group-chat-loading text-danger">${escapeHtml(error.message || 'تعذر تحميل المحادثة')}</div>`;
        } finally {
            loading = false;
        }
    }

    document.getElementById('groupRefresh').addEventListener('click', loadChat);
    document
        .getElementById('groupAttach')
        .addEventListener('click', () => document.getElementById('groupReplyFiles').click());
    document.getElementById('groupReplyFiles').addEventListener('change', async (event) => {
        try {
            images = await filesToBase64(event.target.files);
            document.getElementById('groupAttachmentPreview').innerHTML = images
                .map((src) => `<img src="${src}" alt="صورة مرفقة">`)
                .join('');
        } catch (error) {
            images = [];
            event.target.value = '';
            Swal.fire('مرفق غير صالح', error.message, 'error');
        }
    });
    document.getElementById('groupReplyForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = document.getElementById('groupReplyText');
        const message = input.value.trim();
        if (!message && !images.length) return;
        const button = event.currentTarget.querySelector('[type="submit"]');
        button.disabled = true;
        try {
            await readExecutorApiResponse(
                await executorApiFetch('/executor-portal/api/support/group-chat/replies', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message, imagesBase64: images }),
                })
            );
            input.value = '';
            document.getElementById('groupReplyFiles').value = '';
            document.getElementById('groupAttachmentPreview').innerHTML = '';
            images = [];
            await loadChat();
            document.getElementById('groupMessageList').scrollTop =
                document.getElementById('groupMessageList').scrollHeight;
        } catch (error) {
            Swal.fire('تعذر إرسال الرسالة', error.message, 'error');
        } finally {
            button.disabled = false;
        }
    });

    loadChat();
    setInterval(() => {
        if (!document.hidden) loadChat();
    }, 10000);
})();
