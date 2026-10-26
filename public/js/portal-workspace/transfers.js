import {
    storageKey,
    config,
    showFormResult,
    openDialog,
    parseJsonResponse,
    body,
    idempotencyKeyFor,
    finishIdempotency,
    escapeHtml,
    formatNumber,
    portalFetch,
    portalUrl,
} from './core.js';
import {
    transferForm,
    transferDestination,
    transferAccountNumber,
    transferAmount,
    transferBeneficiary,
    transferNotes,
    transferResult,
    updateCostEstimate,
    selectService,
    transferBank,
    transferBankMethod,
    transferSubtype,
    transferCity,
    transferSefaAcknowledgement,
    transferNationalId,
    transferGovernorate,
    transferIdentityImage,
    activeService,
    transferClientPhone,
    updateBankMethodFields,
    resetSmartTransfer,
    clearTransferValues,
    smartTransferSendButton,
    smartParsedData,
    setSmartStatus,
    resolveSmartTransferService,
    smartTransferDirectIssue,
    sourceCurrencyLabel,
    calculateCostLyd,
    formatExchangeRate,
    smartDuplicateMessage,
} from './services.js';

const applyAssistantTransferDraft = () => {
    if (!transferForm) return;
    let draft;
    try {
        draft = JSON.parse(sessionStorage.getItem(storageKey('businessAssistantTransferDraft')) || 'null');
        sessionStorage.removeItem(storageKey('businessAssistantTransferDraft'));
    } catch (_) {
        return;
    }
    if (!draft || !draft.phone || !draft.amountEGP) return;
    if (draft.serviceKey && (config.services || []).some((service) => service.key === draft.serviceKey)) {
        selectService(draft.serviceKey, { resetSmart: true });
    }
    if (transferDestination) transferDestination.value = String(draft.phone);
    if (transferAccountNumber) transferAccountNumber.value = String(draft.phone);
    if (transferAmount) transferAmount.value = String(draft.amountEGP);
    if (transferNotes) transferNotes.value = String(draft.note || '');
    if (transferBeneficiary && draft.beneficiaryName)
        transferBeneficiary.value = String(draft.beneficiaryName);
    updateCostEstimate();
    showFormResult(
        transferResult,
        'تم فتح مسودة من المساعد. راجع البيانات والتكلفة قبل إرسال العملية.',
        true
    );
};

applyAssistantTransferDraft();

const validateTransfer = () => {
    const amount = Number(transferAmount?.value || 0);
    if (!Number.isFinite(amount) || amount <= 0)
        return { message: 'أدخل مبلغ تحويل صحيحًا.', input: transferAmount };
    if (activeService?.integerAmount && !Number.isInteger(amount)) {
        return { message: 'خدمة سيفا لا تقبل كسورًا في قيمة السيفا.', input: transferAmount };
    }

    const destination = transferDestination?.value.trim() || '';
    if (activeService?.destinationRequired !== false && !destination) {
        return {
            message: activeService?.destinationError || 'أدخل بيانات المستلم.',
            input: transferDestination,
        };
    }
    if (
        activeService?.destinationPattern &&
        !new RegExp(activeService.destinationPattern).test(destination)
    ) {
        return {
            message: activeService.destinationError || 'بيانات المستلم غير صحيحة.',
            input: transferDestination,
        };
    }

    const beneficiaryName = transferBeneficiary?.value.trim() || '';
    if (activeService?.beneficiaryRequired && !beneficiaryName) {
        return { message: 'اسم المستفيد مطلوب.', input: transferBeneficiary };
    }
    if (
        activeService?.beneficiaryMinWords &&
        beneficiaryName.split(/\s+/).filter(Boolean).length < activeService.beneficiaryMinWords
    ) {
        return {
            message:
                activeService.key === 'bank_account'
                    ? 'أدخل الاسم الأول والثاني على الأقل.'
                    : 'اسم المستفيد الرباعي مطلوب لهذه الخدمة.',
            input: transferBeneficiary,
        };
    }
    if (activeService?.key === 'bank_account') {
        const method = transferBankMethod?.value;
        const destination = (transferDestination?.value || '').replace(/\s+/g, '');
        if (!method) return { message: 'اختر طريقة التحويل البنكي.', input: transferBankMethod };
        if (method === 'card')
            return { message: 'التحويل بالبطاقة البنكية غير متاح حالياً.', input: transferBankMethod };
        if (method === 'mobile' && !/^\d{11}$/.test(destination))
            return { message: 'رقم الهاتف يجب أن يتكون من 11 رقماً.', input: transferDestination };
        if (method === 'ipa' && !/^[A-Za-z0-9._-]{3,64}(?:@[A-Za-z0-9.-]{2,253})?$/.test(destination))
            return { message: 'عنوان الدفع IPA غير صحيح.', input: transferDestination };
        if (method === 'account' && !/^\d{5,34}$/.test(destination))
            return {
                message: 'رقم الحساب البنكي يجب أن يتكون من 5 إلى 34 رقماً.',
                input: transferDestination,
            };
        if (method === 'iban' && !/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{5,34}$/.test(destination))
            return {
                message: 'الحساب الدولي يجب أن يتكون من 5 إلى 34 حرفاً إنجليزياً ورقماً.',
                input: transferDestination,
            };
        if (!transferSefaAcknowledgement?.checked)
            return {
                message: 'أقر بصحة البيانات وتحمل مسؤوليتي قبل الإرسال.',
                input: transferSefaAcknowledgement,
            };
    }
    if (['account', 'iban'].includes(transferBankMethod?.value) && !transferBank?.value) {
        return { message: 'اختر البنك قبل إرسال التحويل البنكي.', input: transferBank };
    }

    const subtype = transferSubtype?.value || '';
    if (activeService?.requiresSubtype && !subtype)
        return { message: 'اختر نوع خدمة سيفا.', input: transferSubtype };
    if (activeService?.cityRequiredForSubtypes?.includes(subtype) && !transferCity?.value.trim()) {
        return { message: 'اسم المدينة مطلوب لخدمة NITA.', input: transferCity };
    }
    if (activeService?.requiresDataEntryAcknowledgement && !transferSefaAcknowledgement?.checked) {
        return {
            message: 'أكد مسؤوليتك عن صحة بيانات سيفا قبل الإرسال.',
            input: transferSefaAcknowledgement,
        };
    }
    if (activeService?.requiresNationalId && !/^\d{14}$/.test(transferNationalId?.value.trim() || '')) {
        return { message: 'الرقم القومي يجب أن يكون 14 رقمًا.', input: transferNationalId };
    }
    if (activeService?.requiresGovernorate && !transferGovernorate?.value) {
        return { message: 'اختر المحافظة.', input: transferGovernorate };
    }
    if (activeService?.requiresIdentityImage) {
        const file = transferIdentityImage?.files?.[0];
        if (!file) return { message: 'أرفق صورة البطاقة من الأمام.', input: transferIdentityImage };
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
            return {
                message: 'صورة البطاقة يجب أن تكون JPG أو PNG أو WEBP وبحجم لا يتجاوز 5MB.',
                input: transferIdentityImage,
            };
        }
    }

    return null;
};

const requestCompanyPin = () =>
    new Promise((resolve, reject) => {
        const dialog = document.getElementById('companyPinDialog');
        const form = document.getElementById('companyPinForm');
        const input = document.getElementById('companyPinInput');
        const error = document.getElementById('companyPinError');
        if (!dialog || !form || !input) {
            const pin = window.prompt('أدخل رمز العمليات (من 4 إلى 6 أرقام) لتأكيد التحويل:');
            if (pin === null) return resolve(null);
            if (!/^\d{4,6}$/.test(pin.trim())) {
                return reject(new Error('رمز العمليات يجب أن يكون من 4 إلى 6 أرقام.'));
            }
            return resolve(pin.trim());
        }
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            form.removeEventListener('submit', onSubmit);
            dialog.removeEventListener('close', onClose);
            resolve(value);
        };
        const onSubmit = (event) => {
            event.preventDefault();
            const pin = input.value.trim();
            if (!/^\d{4,6}$/.test(pin)) {
                if (error) {
                    error.hidden = false;
                    error.textContent = 'رمز العمليات يجب أن يكون من 4 إلى 6 أرقام.';
                }
                input.focus();
                return;
            }
            if (error) error.hidden = true;
            finish(pin);
            dialog.close();
        };
        const onClose = () => finish(null);
        input.value = '';
        if (error) {
            error.hidden = true;
            error.textContent = '';
        }
        form.addEventListener('submit', onSubmit);
        dialog.addEventListener('close', onClose);
        openDialog(dialog);
        window.setTimeout(() => input.focus(), 50);
    });

const requestOperationPin = async () => {
    const response = await portalFetch('/security/operation-pin/status', {
        headers: { Accept: 'application/json', 'x-csrf-token': config.csrfToken || '' },
    });
    const status = await parseJsonResponse(response);
    if (!response.ok || !status.success) throw new Error(status.error || 'تعذر التحقق من حماية التحويل.');
    if (!status.enabled) return '';
    if (config.workspaceType === 'company') return requestCompanyPin();
    const pin = window.prompt('أدخل رمز العمليات (من 4 إلى 6 أرقام) لتأكيد التحويل:');
    if (pin === null) return null;
    if (!/^\d{4,6}$/.test(pin.trim())) throw new Error('رمز العمليات يجب أن يكون من 4 إلى 6 أرقام.');
    return pin.trim();
};

const transferConfirmDialog = document.getElementById('transferConfirmDialog');

const transferConfirmBody = document.getElementById('transferConfirmBody');

const transferConfirmTitle = document.getElementById('transferConfirmTitle');

const updateReviewViewport = () => {
    if (!transferConfirmDialog || !body.hasAttribute('data-business-shell')) return;
    const viewport = window.visualViewport;
    // Older engines use innerHeight; mobile keyboards resize the visual viewport.
    transferConfirmDialog.style.setProperty(
        '--cp-review-height',
        `${viewport?.height || window.innerHeight}px`
    );
    transferConfirmDialog.style.setProperty('--cp-review-top', `${viewport?.offsetTop || 0}px`);
};

const trackReviewViewport = () => {
    updateReviewViewport();
    window.addEventListener('resize', updateReviewViewport);
    window.visualViewport?.addEventListener('resize', updateReviewViewport);
    window.visualViewport?.addEventListener('scroll', updateReviewViewport);
};

transferConfirmDialog?.addEventListener('close', () => {
    window.removeEventListener('resize', updateReviewViewport);
    window.visualViewport?.removeEventListener('resize', updateReviewViewport);
    window.visualViewport?.removeEventListener('scroll', updateReviewViewport);
});

const transferSuccessDialog = document.getElementById('transferSuccessDialog');

const transferSuccessCopy = document.getElementById('transferSuccessCopy');

const transferSuccessRef = document.getElementById('transferSuccessRef');

const transferSuccessWhatsapp = document.getElementById('transferSuccessWhatsapp');

const draftStorageKey = config.selectedService ? `cos-draft-${config.selectedService}` : '';

let pendingTransferConfirm = null;

const whatsappNumberFrom = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return '';
    if (digits.startsWith('218') || digits.startsWith('20')) return digits;
    if (/^01[0125]\d{8}$/.test(digits)) return `20${digits.slice(1)}`;
    if (digits.startsWith('0')) return `218${digits.slice(1)}`;
    return digits;
};

const fillTransferSuccess = (payload, phoneHint) => {
    const customId = payload.customId || '';
    if (transferSuccessCopy) {
        transferSuccessCopy.textContent =
            payload.successCopy ||
            (customId
                ? 'سيظهر الإيصال في غرفة العمليات عند اكتمال التنفيذ.'
                : payload.message || 'تم استلام العملية.');
    }
    if (transferSuccessRef) {
        transferSuccessRef.hidden = !customId;
        transferSuccessRef.textContent = customId;
    }
    const intl = whatsappNumberFrom(phoneHint);
    if (transferSuccessWhatsapp) {
        if (intl) {
            const text = encodeURIComponent(
                `تم تسجيل عملية التحويل${customId ? ` رقم ${customId}` : ''} لدى الأهرام.`
            );
            transferSuccessWhatsapp.href = `https://wa.me/${intl}?text=${text}`;
            transferSuccessWhatsapp.hidden = false;
        } else {
            transferSuccessWhatsapp.hidden = true;
            transferSuccessWhatsapp.removeAttribute('href');
        }
    }
};

const persistTransferDraft = () => {
    if (!draftStorageKey || !transferForm) return;
    try {
        sessionStorage.setItem(
            draftStorageKey,
            JSON.stringify({
                phone: transferDestination?.value || '',
                amount: transferAmount?.value || '',
                notes: transferNotes?.value || '',
                name: transferBeneficiary?.value || '',
                bankCode: transferBank?.value || '',
                bankMethod: transferBankMethod?.value || '',
                clientPhone: transferClientPhone?.value || '',
            })
        );
    } catch (_) {
        /* optional */
    }
};

const restoreTransferDraft = () => {
    if (!draftStorageKey || !transferForm) return;
    let draft;
    try {
        draft = JSON.parse(sessionStorage.getItem(draftStorageKey) || 'null');
    } catch (_) {
        return;
    }
    if (!draft) return;
    if (transferDestination?.value.trim()) return;
    if (transferDestination && draft.phone) transferDestination.value = draft.phone;
    if (transferAccountNumber && draft.phone) transferAccountNumber.value = draft.phone;
    if (transferAmount && draft.amount) transferAmount.value = draft.amount;
    if (transferNotes && draft.notes) transferNotes.value = draft.notes;
    if (transferBeneficiary && draft.name) transferBeneficiary.value = draft.name;
    if (transferBank && draft.bankCode) transferBank.value = draft.bankCode;
    if (transferBankMethod && draft.bankMethod) transferBankMethod.value = draft.bankMethod;
    if (activeService?.key === 'bank_account') updateBankMethodFields();
    if (transferClientPhone && draft.clientPhone) transferClientPhone.value = draft.clientPhone;
    updateCostEstimate();
};

const sendTransferRequest = async ({
    formData,
    service,
    destination,
    phoneHint = '',
    submitButton,
    loadingHtml,
    onSuccess,
    onError,
}) => {
    let operationPin;
    try {
        operationPin = await requestOperationPin();
    } catch (error) {
        onError?.(error.message || 'تعذر تأكيد التحويل.');
        return null;
    }
    if (operationPin === null) return null;
    if (operationPin) formData.set('operationPin', operationPin);

    const originalHtml = submitButton?.innerHTML;
    if (submitButton) {
        submitButton.disabled = true;
        submitButton.innerHTML =
            loadingHtml ||
            '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جارٍ تسجيل العملية...</span>';
    }
    try {
        const idempotencyFingerprint = JSON.stringify({
            type: formData.get('type') || '',
            phone: formData.get('phone') || '',
            number: formData.get('number') || '',
            amount: formData.get('amount') || '',
            name: formData.get('name') || '',
            notes: formData.get('notes') || '',
        });
        const idempotencyKey = idempotencyKeyFor('web-transfer', idempotencyFingerprint);
        const response = await portalFetch(portalUrl('/client/transfer'), {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'x-csrf-token': config.csrfToken || '',
                'Idempotency-Key': idempotencyKey,
            },
            body: formData,
        });
        const payload = await parseJsonResponse(response);
        if (!response.ok || payload.success !== true)
            throw new Error(payload.error || 'تعذر تأكيد إرسال العملية. تحقق من حالتها قبل المحاولة مجدداً.');
        finishIdempotency('web-transfer');
        const serviceBalances = document.querySelectorAll('[data-agent-service-balance]');
        if (serviceBalances.length && config.canViewBalance && payload.newBalance !== null && payload.newBalance !== undefined && payload.newBalance !== '' && Number.isFinite(Number(payload.newBalance))) {
            config.availableBalance = Number(payload.newBalance);
            serviceBalances.forEach(node => {
                node.textContent = config.availableBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
                node.classList.toggle('is-positive', config.availableBalance > 0);
                node.classList.toggle('is-negative', config.availableBalance < 0);
            });
        }
        onSuccess?.(payload, { service, destination, phoneHint });
        return payload;
    } catch (error) {
        onError?.(error.message || 'تعذر إرسال العملية.');
        return null;
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.innerHTML = originalHtml;
        }
    }
};

const executeTransfer = async () => {
    const destination =
        activeService?.key === 'post_card' ? transferGovernorate.value : transferDestination.value.trim();
    const accountNumber = activeService?.key === 'post_card' ? transferNationalId.value.trim() : destination;
    if (transferAccountNumber) transferAccountNumber.value = accountNumber;
    const formData = new FormData(transferForm);
    formData.set('phone', destination);
    formData.set('number', accountNumber);
    return sendTransferRequest({
        formData,
        service: activeService,
        destination,
        phoneHint:
            transferClientPhone?.value.trim() || (activeService?.key === 'vodafone' ? destination : ''),
        submitButton: document.getElementById('transferSubmitButton'),
        onSuccess: (payload, context) => {
            const reference = payload.customId ? ` الرقم المرجعي ${payload.customId}.` : '';
            showFormResult(
                transferResult,
                `${payload.message || 'تم تسجيل العملية.'}${reference} يمكنك متابعتها من سجل المعاملات.`,
                true
            );
            fillTransferSuccess(payload, context.phoneHint);
            if (body.hasAttribute('data-business-shell')) openDialog(transferSuccessDialog);
            clearTransferValues();
            resetSmartTransfer(true);
            updateCostEstimate();
            if (draftStorageKey) {
                try {
                    sessionStorage.removeItem(draftStorageKey);
                } catch (_) {
                    /* optional */
                }
            }
        },
        onError: (message) => showFormResult(transferResult, message, false),
    });
};

const transferConfirmSubmit = document.getElementById('transferConfirmSubmit');

const defaultTransferConfirmSubmitHtml =
    transferConfirmSubmit?.innerHTML || '<i class="fa-solid fa-check"></i>تأكيد وختم';

const openSealConfirm = ({ html, title, onConfirm, confirmHtml, forceDialog = false }) => {
    if (
        !transferConfirmDialog ||
        !transferConfirmBody ||
        (!forceDialog && !body.hasAttribute('data-business-shell'))
    ) {
        onConfirm();
        return;
    }
    pendingTransferConfirm = onConfirm;
    if (transferConfirmTitle) transferConfirmTitle.textContent = title || 'تأكيد العملية';
    transferConfirmBody.innerHTML = html;
    if (transferConfirmSubmit) {
        transferConfirmSubmit.innerHTML = confirmHtml || defaultTransferConfirmSubmitHtml;
        transferConfirmSubmit.disabled = false;
    }
    trackReviewViewport();
    openDialog(transferConfirmDialog);
    transferConfirmBody.scrollTop = 0;
    transferConfirmDialog.querySelector('.cp-transfer-review-head')?.focus({ preventScroll: true });
};

const executeSmartTransfer = async () => {
    const service = resolveSmartTransferService();
    const directIssue = smartTransferDirectIssue(service);
    if (directIssue) {
        setSmartStatus(directIssue, 'danger');
        return null;
    }

    const destination = String(smartParsedData?.phone || '').trim();
    const clientPhone = document.getElementById('smartPreviewClientPhone')?.value.trim() || '';
    const formData = new FormData();
    formData.set('type', service.webType);
    formData.set('phone', destination);
    formData.set('number', destination);
    formData.set('amount', String(smartParsedData.amountEGP));
    formData.set('name', String(smartParsedData.beneficiaryName || ''));
    formData.set('notes', String(smartParsedData.note || ''));
    if (clientPhone) formData.set('clientPhone', clientPhone);
    setSmartStatus('جارٍ تسجيل العملية...', 'loading');

    return sendTransferRequest({
        formData,
        service,
        destination,
        phoneHint: clientPhone || destination,
        submitButton: smartTransferSendButton,
        loadingHtml: '<i class="fa-solid fa-circle-notch fa-spin"></i>جارٍ الإرسال',
        onSuccess: (payload, context) => {
            const reference = payload.customId ? ` الرقم المرجعي ${payload.customId}.` : '';
            fillTransferSuccess(payload, context.phoneHint);
            if (body.hasAttribute('data-business-shell')) openDialog(transferSuccessDialog);
            resetSmartTransfer(true);
            setSmartStatus(
                `${payload.message || 'تم تسجيل العملية.'}${reference} يمكنك متابعتها من سجل المعاملات.`,
                'success'
            );
        },
        onError: (message) => setSmartStatus(message, 'danger'),
    });
};

const openSmartTransferConfirm = () => {
    const service = resolveSmartTransferService();
    const directIssue = smartTransferDirectIssue(service);
    if (directIssue) {
        setSmartStatus(directIssue, 'danger');
        return;
    }
    const amount = Number(smartParsedData?.amountEGP || 0);
    const rate = Number(service?.rate || 0);
    const cost = calculateCostLyd(amount, rate, service);
    const destination = String(smartParsedData?.phone || '').trim();
    openSealConfirm({
        title: 'مراجعة التحويل الذكي',
        confirmHtml: '<i class="fa-solid fa-paper-plane"></i>إرسال التحويل',
        forceDialog: true,
        html: `
                <div class="bw-cost-preview">
                    <div><span>الخدمة</span><strong>${escapeHtml(service.label)}</strong></div>
                    <div><span>رقم المستلم</span><strong class="bw-mono">${escapeHtml(destination)}</strong></div>
                    <div><span>المبلغ</span><strong class="bw-mono">${escapeHtml(formatNumber(amount, Number.isInteger(amount) ? 0 : 2))} ${escapeHtml(sourceCurrencyLabel(service))}</strong></div>
                    <div><span>سعر الصرف</span><strong class="bw-mono">${escapeHtml(formatExchangeRate(rate, service))}</strong></div>
                    <div><span>التكلفة التقديرية</span><strong class="bw-mono">${escapeHtml(formatNumber(cost, 3))} LYD</strong></div>
                    ${smartParsedData?.note ? `<div><span>الملاحظة</span><strong>${escapeHtml(smartParsedData.note)}</strong></div>` : ''}
                </div>
                ${smartDuplicateMessage() ? `<div class="cm-smart-duplicate" role="alert">${escapeHtml(smartDuplicateMessage())}</div><label class="cm-smart-ack"><input type="checkbox" id="smartDuplicateAcknowledged"><span>راجعت احتمال التكرار وأريد إنشاء تحويل جديد.</span></label>` : ''}
                <label class="bw-field">
                    <span>رقم واتساب العميل <em>اختياري</em></span>
                    <input type="text" id="smartPreviewClientPhone" class="bw-mono" dir="ltr" inputmode="tel" autocomplete="tel" maxlength="30" placeholder="رقم لاستلام الإيصال عبر واتساب">
                    <small>يُرسل الإيصال إلى هذا الرقم عند اكتمال العملية.</small>
                </label>`,
        onConfirm: executeSmartTransfer,
    });
    const acknowledgement = document.getElementById('smartDuplicateAcknowledged');
    if (acknowledgement && transferConfirmSubmit) {
        transferConfirmSubmit.disabled = true;
        acknowledgement.addEventListener('change', () => {
            transferConfirmSubmit.disabled = !acknowledgement.checked;
        });
    }
};

const openTransferConfirm = () => {
    const amount = Number(transferAmount?.value || 0);
    const rate = Number(activeService?.rate || 0);
    const cost = calculateCostLyd(amount, rate, activeService);
    const destination =
        activeService?.key === 'post_card'
            ? transferNationalId?.value.trim()
            : transferDestination?.value.trim();
    openSealConfirm({
        title: `تحويل ${activeService?.label || 'الخدمة'} ${formatNumber(amount, 0)} ${sourceCurrencyLabel(activeService)}`,
        html: `
            <div class="bw-cost-preview">
                <div><span>الخدمة</span><strong>${escapeHtml(activeService?.label || '')}</strong></div>
                <div><span>المستلم</span><strong class="bw-mono">${escapeHtml(destination || '---')}</strong></div>
                ${transferBeneficiary?.value.trim() ? `<div><span>الاسم</span><strong>${escapeHtml(transferBeneficiary.value.trim())}</strong></div>` : ''}
                ${activeService?.key === 'bank_account' ? `<div><span>طريقة التحويل</span><strong>${escapeHtml(transferBankMethod?.selectedOptions?.[0]?.text || '')}</strong></div>` : ''}
                ${['account', 'iban'].includes(transferBankMethod?.value) && transferBank?.selectedOptions?.[0] ? `<div><span>البنك</span><strong>${escapeHtml(transferBank.selectedOptions[0].text)}</strong></div>` : ''}
                ${activeService?.key === 'bank_account' ? `<div><span>إقرار المسؤولية</span><strong>${transferSefaAcknowledgement?.checked ? 'تم الإقرار' : 'غير مؤكد'}</strong></div>` : ''}
                <div><span>المبلغ</span><strong class="bw-mono">${escapeHtml(formatNumber(amount, 2))} ${escapeHtml(sourceCurrencyLabel(activeService))}</strong></div>
                <div><span>التكلفة</span><strong class="bw-mono">${escapeHtml(formatNumber(cost, 3))} LYD</strong></div>
            </div>`,
        onConfirm: executeTransfer,
    });
};

transferForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const validationError = validateTransfer();
    if (validationError) {
        showFormResult(transferResult, validationError.message, false);
        validationError.input?.focus();
        return;
    }
    if (!transferForm.reportValidity()) return;
    openTransferConfirm();
});

transferConfirmSubmit?.addEventListener('click', () => {
    const acknowledgement = document.getElementById('smartDuplicateAcknowledged');
    if (acknowledgement && !acknowledgement.checked) return;
    const next = pendingTransferConfirm;
    pendingTransferConfirm = null;
    transferConfirmDialog?.close();
    if (typeof next === 'function') next();
});

transferConfirmDialog?.addEventListener('close', () => {
    pendingTransferConfirm = null;
    if (transferConfirmTitle) transferConfirmTitle.textContent = 'تأكيد العملية';
    if (transferConfirmSubmit) transferConfirmSubmit.innerHTML = defaultTransferConfirmSubmitHtml;
});

[
    transferDestination,
    transferAmount,
    transferNotes,
    transferBeneficiary,
    transferBank,
    transferBankMethod,
    transferClientPhone,
].forEach((input) => {
    input?.addEventListener('input', persistTransferDraft);
});

restoreTransferDraft();

export {
    openSmartTransferConfirm,
    requestOperationPin,
    transferSuccessDialog,
    fillTransferSuccess,
    openSealConfirm,
    whatsappNumberFrom,
};
