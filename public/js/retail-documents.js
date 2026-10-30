'use strict';
(() => {
    const page = document.querySelector('[data-retail-documents]');
    if (!page) return;
    const find = (selector) => page.querySelector(selector),
        form = find('[data-rd-form]'),
        fileInput = form.elements.document;
    const states = {
        not_submitted: 'غير مكتمل',
        incomplete: 'غير مكتمل',
        pending: 'قيد المراجعة',
        rejected: 'يحتاج تعديلًا',
        verified: 'تم التحقق من الوثائق',
    };
    const advice = {
        not_submitted: 'لم تُرفع وثائق بعد. أضف الهوية أو جواز السفر للبدء.',
        incomplete: 'أضف وثيقة الهوية لاستكمال التحقق.',
        pending: 'استُلمت وثائقك. انتظر نتيجة مراجعة الإدارة.',
        rejected: 'راجع سبب طلب التعديل أسفل الوثيقة ثم ارفع البديل.',
        verified: 'اعتمدت الإدارة الوثائق المعروضة. لا يلزم إجراء حاليًا.',
    };
    let revision = null,
        rows = [],
        selected = null,
        previewUrl = '',
        busy = false,
        leaving = false;
    const message = (text) => {
        find('[data-rd-message]').textContent = text;
    };
    const formatDate = (value) =>
        value ? new Date(value).toLocaleString('ar-LY', { timeZone: 'Africa/Tripoli' }) : 'غير مسجل';
    const controls = () => {
        fileInput.disabled = busy;
        form.elements.kind.disabled = busy;
        find('[data-rd-submit]').disabled = busy || !selected || revision === null;
        find('[data-rd-clear]').disabled = busy;
        find('[data-rd-refresh]').disabled = busy;
    };
    const clear = (resetInput = true) => {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = '';
        selected = null;
        if (resetInput) fileInput.value = '';
        find('[data-rd-image]').removeAttribute('src');
        find('[data-rd-preview]').hidden = true;
        controls();
    };
    const appendText = (parent, tag, text, className) => {
        const element = document.createElement(tag);
        element.textContent = text;
        if (className) element.className = className;
        parent.append(element);
        return element;
    };
    const render = (data) => {
        revision = data.revision;
        rows = data.documents;
        const verification = find('[data-rd-verification]');
        verification.textContent = states[data.verification] || 'تعذر تحديد الحالة';
        verification.dataset.state = data.verification;
        find('[data-rd-next]').textContent = advice[data.verification] || 'تواصل مع الدعم.';
        const last = rows.reduce(
            (latest, row) => Math.max(latest, Date.parse(row.reviewedAt || row.uploadedAt) || 0),
            0
        );
        find('[data-rd-last]').textContent = last ? 'آخر تحديث للوثائق: ' + formatDate(last) : '';
        find('[data-rd-complete]').hidden = ['verified', 'pending'].includes(data.verification);
        const list = find('[data-rd-list]');
        list.replaceChildren();
        if (!rows.length) appendText(list, 'p', 'لم تُرفع وثائق بعد.', 'rd-empty');
        rows.forEach((row) => {
            const article = appendText(list, 'article', '', 'rd-document');
            const details = appendText(article, 'div', '');
            appendText(details, 'h3', row.title);
            appendText(details, 'p', row.name, 'rd-file-name');
            appendText(details, 'small', 'تاريخ الرفع: ' + formatDate(row.uploadedAt), 'rd-muted');
            const status = appendText(
                details,
                'p',
                { pending: 'قيد المراجعة', approved: 'معتمدة', rejected: 'تحتاج تعديلًا' }[
                    row.reviewStatus
                ] || 'قيد المراجعة',
                'rd-status'
            );
            status.dataset.state = row.reviewStatus;
            if (row.reason) appendText(details, 'p', 'سبب طلب التعديل: ' + row.reason, 'rd-reason');
            const actions = appendText(article, 'div', '', 'rd-document-actions');
            const link = appendText(actions, 'a', 'عرض / تحميل', 'button');
            link.href = '/client/api/account-documents/' + encodeURIComponent(row.id);
            link.target = '_blank';
            link.rel = 'noopener';
            if (row.reviewStatus === 'rejected') {
                const button = appendText(actions, 'button', 'رفع بديل', 'button');
                button.type = 'button';
                button.addEventListener('click', () => {
                    form.elements.kind.value = row.kind;
                    find('#rdUpload').scrollIntoView({ behavior: 'smooth' });
                    fileInput.focus();
                });
            }
        });
        controls();
    };
    const load = async () => {
        const response = await fetch('/client/api/account-documents', {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'تعذر تحميل حالة الوثائق.');
        render(data);
    };
    const refresh = async () => {
        busy = true;
        controls();
        try {
            await load();
            message(selected ? 'تم تحديث الحالة. ملفك المحدد لم يُرفع بعد.' : 'تم تحديث الحالة.');
        } catch (error) {
            revision = null;
            find('[data-rd-verification]').textContent = 'تعذر التحقق';
            find('[data-rd-next]').textContent = 'أعد تحديث الحالة قبل رفع وثيقة.';
            message(error.message);
        } finally {
            busy = false;
            controls();
        }
    };
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        clear(false);
        if (!file) return;
        if (
            !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
            !file.size ||
            file.size > 5 * 1024 * 1024
        ) {
            message('اختر PDF أو صورة لا تتجاوز 5 ميجابايت.');
            return;
        }
        selected = file;
        find('[data-rd-filename]').textContent = file.name;
        find('[data-rd-size]').textContent =
            file.size < 1024 * 1024
                ? (file.size / 1024).toFixed(1) + ' كيلوبايت'
                : (file.size / 1024 / 1024).toFixed(2) + ' ميجابايت';
        const image = find('[data-rd-image]');
        image.hidden = !file.type.startsWith('image/');
        if (!image.hidden) {
            previewUrl = URL.createObjectURL(file);
            image.src = previewUrl;
        }
        find('[data-rd-preview]').hidden = false;
        message('ملف محدد لم يُرفع بعد.');
        controls();
    });
    find('[data-rd-clear]').addEventListener('click', () => {
        clear();
        message('تمت إزالة الاختيار.');
    });
    find('[data-rd-refresh]').addEventListener('click', refresh);
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!selected || busy || revision === null) return;
        const old = rows.find((row) => row.kind === form.elements.kind.value);
        if (old && old.reviewStatus !== 'rejected') {
            message('هذه الوثيقة محفوظة بالفعل. انتظر المراجعة أو تواصل مع الدعم.');
            return;
        }
        busy = true;
        controls();
        message('جارٍ رفع الوثيقة…');
        try {
            const body = new FormData();
            body.append('document', selected);
            body.append('kind', form.elements.kind.value);
            body.append('revision', String(revision));
            const response = await fetch('/client/api/account-documents', {
                method: 'POST',
                headers: { Accept: 'application/json', 'x-csrf-token': window.csrfToken || '' },
                body,
            });
            const data = await response.json();
            if (!response.ok) {
                if (response.status === 409) revision = null;
                throw new Error(data.error || 'تعذر رفع الوثيقة.');
            }
            clear();
            try {
                await load();
                message('تم رفع الوثيقة بنجاح. الحالة: قيد المراجعة.');
            } catch (_) {
                revision = null;
                message('تم الرفع، لكن تعذر تحديث الحالة. حدّثها قبل إضافة ملف آخر.');
            }
        } catch (error) {
            message(error.message || 'تعذر تأكيد الرفع. حدّث الحالة قبل إعادة المحاولة.');
        } finally {
            busy = false;
            controls();
        }
    });
    find('[data-rd-copy]').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(find('[data-rd-account]').textContent.trim());
            message('تم نسخ رقم الحساب.');
        } catch (_) {
            message('تعذر النسخ. يمكنك تحديد رقم الحساب ونسخه.');
        }
    });
    window.addEventListener('beforeunload', (event) => {
        if (!selected || leaving) return;
        event.preventDefault();
        event.returnValue = '';
    });
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (
            !selected ||
            !link ||
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey ||
            link.target === '_blank' ||
            link.getAttribute('href').startsWith('#')
        )
            return;
        if (!window.confirm('لديك ملف لم يُرفع بعد. هل تريد المغادرة دون رفعه؟')) event.preventDefault();
        else leaving = true;
    });
    window.addEventListener('pageshow', () => {
        leaving = false;
    });
    void refresh();
})();
