import { formatNumber, escapeHtml, config, parseJsonResponse, portalFetch, portalUrl } from './core.js';

const serviceButtons = [...document.querySelectorAll('[data-service-key]')];

const transferForm = document.getElementById('businessTransferForm');

const transferType = document.getElementById('transferType');

const transferDestination = document.getElementById('transferDestination');

const transferAccountNumber = document.getElementById('transferAccountNumber');

const transferAmount = document.getElementById('transferAmount');

const transferAmountLyd = document.getElementById('transferAmountLyd');

const transferAmountLabel = document.getElementById('transferAmountLabel');

const transferAmountCurrency = document.getElementById('transferAmountCurrency');

const transferAmountFlag = document.getElementById('transferAmountFlag');

const transferBeneficiary = document.getElementById('transferBeneficiary');

const transferBank = document.getElementById('transferBank');

const transferBankMethod = document.getElementById('transferBankMethod');

const beneficiaryFieldLabel = document.getElementById('beneficiaryFieldLabel');

const transferSubtype = document.getElementById('transferSubtype');

const transferCity = document.getElementById('transferCity');

const transferSefaAcknowledgement = document.getElementById('transferSefaAcknowledgement');

const bankAcknowledgementField = document.querySelector('[data-sefa-acknowledgement-field]');

const transferNationalId = document.getElementById('transferNationalId');

const transferGovernorate = document.getElementById('transferGovernorate');

const transferClientPhone = document.getElementById('transferClientPhone');

const transferIdentityImage = document.getElementById('transferIdentityImage');

const transferNotes = document.getElementById('transferNotes');

const selectedServiceTitle = document.getElementById('selectedServiceTitle');

const destinationFieldLabel = document.getElementById('destinationFieldLabel');

const destinationFieldHint = document.getElementById('destinationFieldHint');

const costServiceLabel = document.getElementById('costServiceLabel');

const costRate = document.getElementById('costRate');

const costEstimate = document.getElementById('costEstimate');

const transferRateBridge = document.getElementById('transferRateBridge');

const transferRateFormula = document.getElementById('transferRateFormula');

const transferResult = document.getElementById('transferFormResult');

const smartTransferMessage = document.getElementById('smartTransferMessage');

const smartTransferAnalyzeButton = document.getElementById('smartTransferAnalyzeButton');

const smartTransferStatus = document.getElementById('smartTransferStatus');

const smartTransferPreview = document.getElementById('smartTransferPreview');

const smartTransferSendButton = document.getElementById('smartTransferSendButton');

const smartTransferDuplicate = document.getElementById('smartTransferDuplicate');

const smartAnalyzeLabel = smartTransferAnalyzeButton?.innerHTML;

const smartPreviewPhone = document.getElementById('smartPreviewPhone');

const smartPreviewAmount = document.getElementById('smartPreviewAmount');

const smartPreviewRate = document.getElementById('smartPreviewRate');

const smartPreviewLyd = document.getElementById('smartPreviewLyd');

const smartPreviewNote = document.getElementById('smartPreviewNote');

const smartPreviewBeneficiary = document.getElementById('smartPreviewBeneficiary');

const smartPreviewService = document.getElementById('smartPreviewService');

const smartPreviewConfidence = document.getElementById('smartPreviewConfidence');

const assistantDialog = document.getElementById('businessAssistantDialog');

const assistantOpenButton = document.getElementById('businessAssistantOpen');

const assistantForm = document.getElementById('businessAssistantForm');

const assistantQuestion = document.getElementById('businessAssistantQuestion');

const assistantMessages = document.getElementById('businessAssistantMessages');

const assistantSuggestions = document.getElementById('businessAssistantSuggestions');

const assistantSubmitButton = document.getElementById('businessAssistantSubmit');

let activeService = null;

let smartParsedData = null;

const isSourceToLydRate = (service) => service?.rateDirection === 'source_to_lyd';

const sourceCurrencyLabel = (service) => service?.amountCurrencyLabel || 'EGP';

const calculateCostLyd = (amount, rate, service) => {
    if (!(amount > 0 && rate > 0)) return 0;
    return isSourceToLydRate(service) ? amount * rate : amount / rate;
};

const calculateSourceAmount = (costLyd, rate, service) => {
    if (!(costLyd > 0 && rate > 0)) return 0;
    return isSourceToLydRate(service) ? costLyd / rate : costLyd * rate;
};

const formatExchangeRate = (rate, service = activeService) =>
    isSourceToLydRate(service)
        ? `1 ${sourceCurrencyLabel(service)} = ${formatNumber(rate, 2)} LYD`
        : `1 LYD = ${formatNumber(rate, 2)} ${sourceCurrencyLabel(service)}`;

const formatRateFormula = (service = activeService) =>
    isSourceToLydRate(service)
        ? `${sourceCurrencyLabel(service)} × السعر = LYD`
        : `${sourceCurrencyLabel(service)} ÷ السعر = LYD`;

const setSmartStatus = (message, tone = 'info') => {
    if (!smartTransferStatus) return;
    smartTransferStatus.hidden = !message;
    smartTransferStatus.className = `bw-smart-transfer-status ${tone}`;
    smartTransferStatus.innerHTML = message
        ? `<i class="fa-solid ${tone === 'danger' ? 'fa-circle-exclamation' : tone === 'loading' ? 'fa-circle-notch fa-spin' : 'fa-circle-check'}"></i><span>${escapeHtml(message)}</span>`
        : '';
};

const resolveSmartTransferService = () => {
    const requestedKey = smartParsedData?.serviceKey || 'vodafone';
    return (
        (config.services || []).find((service) => service.key === requestedKey) ||
        (config.services || []).find((service) => service.key === 'vodafone') ||
        null
    );
};

const smartTransferDirectIssue = (service = resolveSmartTransferService()) => {
    if (!service) return 'تعذر تحديد خدمة التحويل.';
    if (service.key !== 'vodafone')
        return `تتطلب خدمة ${service.label} بيانات إضافية ولا يمكن إرسالها من التحويل الذكي.`;
    if (!(Number(service.rate) > 0)) return 'سعر الصرف غير متاح الآن. انتظر تحديث الأسعار قبل المتابعة.';
    const phone = String(smartParsedData?.phone || '').trim();
    const amount = Number(smartParsedData?.amountEGP || 0);
    if (!phone || (service.destinationPattern && !new RegExp(service.destinationPattern).test(phone))) {
        return service.destinationError || 'رقم المستلم غير صحيح.';
    }
    if (!Number.isFinite(amount) || amount <= 0) return 'أدخل مبلغ تحويل صحيحًا.';
    if (service.minAmount && amount < service.minAmount)
        return `الحد الأدنى للتحويل هو ${service.minAmount} جنيه.`;
    if (service.maxAmount && amount > service.maxAmount)
        return `الحد الأقصى للتحويل هو ${formatNumber(service.maxAmount, 0)} جنيه للعملية الواحدة.`;
    return '';
};

const smartDuplicateMessage = () => {
    const check = smartParsedData?.duplicateCheck;
    if (!check?.detected) return '';
    const states = [check.pending ? 'قيد الانتظار أو التنفيذ' : '', check.completed ? 'ناجحة' : '']
        .filter(Boolean)
        .join(' و');
    return `تنبيه تكرار: توجد عملية للشركة بنفس المحفظة والمبلغ خلال آخر 24 ساعة (${states}). راجع سجل العمليات قبل إرسال تحويل آخر.`;
};

const renderSmartPreview = () => {
    if (!smartTransferPreview || !smartParsedData) return;
    const rate = Number(activeService?.rate || 0);
    const amount = Number(smartParsedData.amountEGP || 0);
    const amountLyd = calculateCostLyd(amount, rate, activeService);
    smartTransferPreview.hidden = false;
    if (smartTransferDuplicate) {
        const warning = smartDuplicateMessage();
        smartTransferDuplicate.hidden = !warning;
        smartTransferDuplicate.textContent = warning;
    }
    if (smartPreviewPhone) smartPreviewPhone.textContent = smartParsedData.phone || 'غير متوفر';
    if (smartPreviewAmount)
        smartPreviewAmount.textContent =
            amount > 0
                ? `${formatNumber(amount, Number.isInteger(amount) ? 0 : 2)} ${sourceCurrencyLabel(activeService)}`
                : 'غير متوفر';
    if (smartPreviewRate) smartPreviewRate.textContent = rate > 0 ? formatExchangeRate(rate) : 'غير متوفر';
    if (smartPreviewLyd)
        smartPreviewLyd.textContent = amountLyd > 0 ? `${formatNumber(amountLyd, 3)} LYD` : '---';
    if (smartPreviewNote) smartPreviewNote.textContent = smartParsedData.note || 'لا توجد ملاحظة';
    if (smartPreviewBeneficiary) {
        smartPreviewBeneficiary.closest('div').hidden = !smartParsedData.beneficiaryName;
        smartPreviewBeneficiary.textContent = smartParsedData.beneficiaryName || '';
    }
    if (smartPreviewService) {
        smartPreviewService.innerHTML = `<i class="fa-solid ${escapeHtml(activeService?.icon || 'fa-mobile-screen-button')}"></i>${escapeHtml(activeService?.label || 'محافظ كاش')}`;
    }
    if (smartPreviewConfidence) {
        const confidence = smartParsedData.confidence || (smartParsedData.ready ? 'high' : 'low');
        const labels = { high: 'جاهز للمراجعة', review: 'يحتاج مراجعة', low: 'بيانات ناقصة' };
        smartPreviewConfidence.className = `bw-smart-confidence ${confidence}`;
        smartPreviewConfidence.textContent = labels[confidence] || labels.low;
    }
    if (smartTransferSendButton) {
        const directIssue = smartTransferDirectIssue(activeService);
        smartTransferSendButton.disabled = !smartParsedData.ready || Boolean(directIssue);
    }
};

const resetSmartTransfer = (clearMessage = false) => {
    smartParsedData = null;
    if (smartTransferPreview) smartTransferPreview.hidden = true;
    if (smartTransferSendButton) smartTransferSendButton.disabled = true;
    if (smartTransferDuplicate) smartTransferDuplicate.hidden = true;
    if (clearMessage && smartTransferMessage) smartTransferMessage.value = '';
    setSmartStatus('');
};

const toggleConditionalField = (selector, enabled, input, clearWhenHidden = true) => {
    const field = document.querySelector(selector);
    if (field) field.hidden = !enabled;
    if (input) input.required = Boolean(enabled);
    if (!enabled && clearWhenHidden && input) input.value = '';
};

const setOptionalAttribute = (element, attribute, value) => {
    if (!element) return;
    if (value === undefined || value === null || value === '') element.removeAttribute(attribute);
    else element.setAttribute(attribute, String(value));
};

const updateCostEstimate = (syncLyd = true) => {
    if (!activeService || !costEstimate) return;
    const amount = Number(transferAmount?.value || 0);
    const rate = Number(activeService.rate || 0);
    const estimate = calculateCostLyd(amount, rate, activeService);
    costEstimate.textContent = `${formatNumber(estimate, 3)} LYD`;
    if (syncLyd && transferAmountLyd) transferAmountLyd.value = estimate > 0 ? estimate.toFixed(2) : '';
    if (smartParsedData) renderSmartPreview();
};

const updateCityRequirement = () => {
    const requiredSubtypes = activeService?.cityRequiredForSubtypes || [];
    const cityRequired = Boolean(
        activeService?.requiresSubtype && requiredSubtypes.includes(transferSubtype?.value)
    );
    toggleConditionalField('[data-city-field]', cityRequired, transferCity);
};

const updateSefaAcknowledgement = () => {
    const bankTransfer = activeService?.key === 'bank_account';
    const required = bankTransfer || Boolean(activeService?.requiresDataEntryAcknowledgement);
    if (bankAcknowledgementField) bankAcknowledgementField.hidden = !required;
    const title = bankAcknowledgementField?.querySelector('[data-ack-title]');
    const copy = bankAcknowledgementField?.querySelector('[data-ack-copy]');
    if (title) title.textContent = bankTransfer ? 'إقرار بصحة بيانات التحويل' : 'تأكيد صحة بيانات سيفا';
    if (copy && bankTransfer)
        copy.textContent = 'أقر أن اسم المستفيد وبيانات التحويل المدخلة صحيحة، وأتحمل مسؤولية أي خطأ فيها.';
    if (copy && !bankTransfer)
        copy.textContent =
            'العميل مسؤول عن صحة الاسم ورقم الحساب والمدينة المدخلة. لا تتحمل الشركة مسؤولية أي خطأ ناتج من بيانات أدخلها العميل.';
    if (transferSefaAcknowledgement) {
        transferSefaAcknowledgement.required = required;
        if (!required) transferSefaAcknowledgement.checked = false;
    }
};

const clearTransferValues = () => {
    [
        transferDestination,
        transferAccountNumber,
        transferAmount,
        transferAmountLyd,
        transferBeneficiary,
        transferCity,
        transferNationalId,
        transferGovernorate,
        transferClientPhone,
        transferBank,
    ].forEach((input) => {
        if (input) input.value = '';
    });
    if (transferIdentityImage) transferIdentityImage.value = '';
    if (transferNotes) transferNotes.value = '';
    if (transferSefaAcknowledgement) transferSefaAcknowledgement.checked = false;
    if (transferBankMethod) transferBankMethod.value = '';
};

const selectService = (serviceKey, options = {}) => {
    const service = (config.services || []).find((item) => item.key === serviceKey) || config.services?.[0];
    if (!service) return;
    const serviceChanged = activeService && activeService.key !== service.key;
    if (serviceChanged) clearTransferValues();
    if (serviceChanged && options.resetSmart) resetSmartTransfer(false);
    activeService = service;
    serviceButtons.forEach((button) => {
        const selected = button.dataset.serviceKey === service.key;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    if (transferType) transferType.value = service.webType;
    if (selectedServiceTitle) {
        selectedServiceTitle.textContent =
            config.workspaceType === 'company' ? service.label : `تحويل ${service.label}`;
    }
    if (destinationFieldLabel) destinationFieldLabel.textContent = service.numberLabel;
    if (destinationFieldHint)
        destinationFieldHint.textContent = service.numberPlaceholder || 'أدخل بيانات المستلم بدقة.';
    toggleConditionalField(
        '[data-destination-field]',
        service.destinationRequired !== false,
        transferDestination
    );
    if (transferDestination) {
        transferDestination.placeholder = service.numberPlaceholder || '';
        transferDestination.inputMode = service.destinationInputMode || 'text';
        setOptionalAttribute(transferDestination, 'pattern', service.destinationPattern);
        setOptionalAttribute(transferDestination, 'minlength', service.destinationMinLength);
        setOptionalAttribute(transferDestination, 'maxlength', service.destinationMaxLength);
    }
    toggleConditionalField(
        '[data-beneficiary-field]',
        Boolean(service.beneficiaryRequired),
        transferBeneficiary
    );
    if (beneficiaryFieldLabel) beneficiaryFieldLabel.textContent = service.beneficiaryLabel || 'اسم المستفيد';
    if (transferBeneficiary)
        transferBeneficiary.placeholder = service.beneficiaryPlaceholder || 'أدخل اسم المستفيد';
    const bankRequired = Boolean(service.requiresBank || service.key === 'bank_account');
    const bankMethodField = document.querySelector('[data-bank-method-field]');
    if (bankMethodField) bankMethodField.hidden = !bankRequired;
    if (transferBankMethod) {
        transferBankMethod.disabled = !bankRequired;
        transferBankMethod.required = bankRequired;
    }
    const needsBank = bankRequired && ['account', 'iban'].includes(transferBankMethod?.value);
    toggleConditionalField('[data-bank-field]', needsBank, transferBank);
    if (transferBank) {
        transferBank.disabled = !needsBank;
        transferBank.required = needsBank;
    }
    updateBankMethodFields();
    toggleConditionalField('[data-subtype-field]', Boolean(service.requiresSubtype), transferSubtype);
    if (service.requiresSubtype && transferSubtype && !transferSubtype.value) {
        transferSubtype.value = service.allowedSubtypes?.[0] || 'nita';
    }
    toggleConditionalField(
        '[data-national-id-field]',
        Boolean(service.requiresNationalId),
        transferNationalId
    );
    toggleConditionalField(
        '[data-governorate-field]',
        Boolean(service.requiresGovernorate),
        transferGovernorate
    );
    toggleConditionalField(
        '[data-identity-field]',
        Boolean(service.requiresIdentityImage),
        transferIdentityImage
    );
    if (transferAmount) transferAmount.step = service.amountStep || '0.01';
    updateCityRequirement();
    updateSefaAcknowledgement();
    if (transferAmountLabel)
        transferAmountLabel.textContent = isSourceToLydRate(service)
            ? 'المبلغ بالسيفا'
            : 'المبلغ بالجنيه المصري';
    if (transferAmountCurrency) transferAmountCurrency.textContent = sourceCurrencyLabel(service);
    if (transferAmountFlag)
        transferAmountFlag.textContent = sourceCurrencyLabel(service) === 'EGP' ? '🇪🇬' : '🇳🇪';
    if (costServiceLabel) costServiceLabel.textContent = service.label;
    if (costRate) costRate.textContent = formatExchangeRate(service.rate, service);
    if (transferRateBridge) transferRateBridge.textContent = formatExchangeRate(service.rate, service);
    if (transferRateFormula) transferRateFormula.textContent = formatRateFormula(service);
    updateCostEstimate();
};

const updateBankMethodFields = () => {
    if (!transferDestination || activeService?.key !== 'bank_account') return;
    const method = transferBankMethod?.value || '';
    const labels = {
        mobile: ['رقم هاتف المستفيد (11 رقم)', 'أدخل رقم الهاتف المصري المكوّن من 11 رقماً', 'numeric'],
        ipa: ['عنوان الدفع (IPA)', 'مثال: Ahrampay', 'text'],
        account: ['رقم الحساب البنكي', 'أرقام فقط', 'numeric'],
        iban: ['الحساب المصرفي الدولي', 'أرقام وحروف إنجليزية فقط', 'text'],
        card: ['رقم البطاقة', 'غير متاح حالياً', 'numeric'],
    };
    const selected = labels[method] || ['بيانات المستلم', 'اختر طريقة التحويل أولاً', 'text'];
    if (destinationFieldLabel) destinationFieldLabel.textContent = selected[0];
    if (destinationFieldHint) destinationFieldHint.textContent = selected[1];
    transferDestination.placeholder = selected[1];
    transferDestination.inputMode = selected[2];
    transferDestination.required = Boolean(method);
    if (method === 'iban') transferDestination.value = transferDestination.value.toUpperCase();
    if (method === 'mobile') {
        transferDestination.maxLength = 11;
        transferDestination.pattern = '\\d{11}';
    } else {
        transferDestination.removeAttribute('maxlength');
        transferDestination.removeAttribute('pattern');
    }
    const needsBank = ['account', 'iban'].includes(method);
    toggleConditionalField('[data-bank-field]', needsBank, transferBank);
    if (transferBank) {
        transferBank.required = needsBank;
        transferBank.disabled = !needsBank;
        if (!needsBank) transferBank.value = '';
    }
};

transferBankMethod?.addEventListener('change', () => {
    if (activeService?.key !== 'bank_account') return;
    if (transferDestination) transferDestination.value = '';
    if (transferAccountNumber) transferAccountNumber.value = '';
    updateBankMethodFields();
});

serviceButtons.forEach((button) => {
    button.addEventListener('click', () => {
        selectService(button.dataset.serviceKey, { resetSmart: true });
        if (transferForm && window.matchMedia('(max-width: 760px)').matches) {
            transferForm
                .closest('.bw-transfer-workbench')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });
});

document.querySelector('[data-service-gallery-jump]')?.addEventListener('click', () => {
    document.getElementById('serviceGallery')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

transferAmount?.addEventListener('input', () => updateCostEstimate());

transferAmountLyd?.addEventListener('input', () => {
    if (!activeService || !transferAmount) return;
    const rate = Number(activeService.rate || 0);
    const amountLyd = Number(transferAmountLyd.value || 0);
    const sourceAmount = calculateSourceAmount(amountLyd, rate, activeService);
    transferAmount.value =
        sourceAmount > 0
            ? activeService.integerAmount && Number.isInteger(sourceAmount)
                ? String(sourceAmount)
                : sourceAmount.toFixed(2)
            : '';
    updateCostEstimate(false);
});

transferDestination?.addEventListener('input', () => {
    if (transferAccountNumber) transferAccountNumber.value = transferDestination.value.trim();
});

transferNationalId?.addEventListener('input', () => {
    transferNationalId.value = transferNationalId.value.replace(/\D/g, '').slice(0, 14);
    if (activeService?.key === 'post_card' && transferAccountNumber)
        transferAccountNumber.value = transferNationalId.value;
});

transferSubtype?.addEventListener('change', updateCityRequirement);

if (serviceButtons.length) {
    selectService(config.selectedService || serviceButtons[0].dataset.serviceKey);
} else if (transferForm) {
    selectService(config.selectedService || 'vodafone');
}

let rateRefreshController = null;

const applyServiceRates = (serviceRates) => {
    let changed = false;
    (config.services || []).forEach((service) => {
        const nextRate = Number(serviceRates?.[service.key]);
        if (!Number.isFinite(nextRate) || nextRate <= 0) return;
        if (Number(service.rate) !== nextRate) changed = true;
        service.rate = nextRate;

        const button = serviceButtons.find((item) => item.dataset.serviceKey === service.key);
        const rateValue = button?.querySelector('[data-service-rate-value]');
        if (rateValue) rateValue.textContent = formatExchangeRate(nextRate, service);
    });

    if (activeService) selectService(activeService.key, { resetSmart: false });
    return changed;
};

const refreshServiceRates = async () => {
    if (!transferForm && !serviceButtons.length && !smartTransferMessage) return;
    if (rateRefreshController) rateRefreshController.abort();
    const controller = new AbortController();
    rateRefreshController = controller;
    try {
        const response = await portalFetch(portalUrl('/client/api/rates'), {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal,
        });
        const payload = await parseJsonResponse(response);
        if (response.ok && payload.success) applyServiceRates(payload.serviceRates);
    } catch (error) {
        if (error.name !== 'AbortError') console.warn('[Business Portal] rate refresh failed');
    } finally {
        if (rateRefreshController === controller) rateRefreshController = null;
    }
};

if (transferForm || serviceButtons.length) {
    if (typeof window.io === 'function') {
        const rateSocket = window.getPortalRealtimeSocket ? window.getPortalRealtimeSocket() : window.io();
        rateSocket.on('exchange_rates_updated', refreshServiceRates);
    }
    window.setInterval(refreshServiceRates, 30000);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshServiceRates();
    });
}

const applySmartTransferData = (parsed) => {
    smartParsedData = parsed;
    const parsedServiceKey = (config.services || []).some((service) => service.key === parsed.serviceKey)
        ? parsed.serviceKey
        : 'vodafone';
    selectService(parsedServiceKey);
    if (transferDestination) transferDestination.value = parsed.phone || '';
    if (transferAccountNumber) transferAccountNumber.value = parsed.phone || '';
    if (transferAmount) transferAmount.value = parsed.amountEGP || '';
    if (transferBeneficiary && parsed.beneficiaryName) transferBeneficiary.value = parsed.beneficiaryName;
    if (transferNotes) transferNotes.value = parsed.note || '';
    updateCostEstimate();
    renderSmartPreview();

    const directIssue = smartTransferDirectIssue(activeService);
    if (parsed.ready && !directIssue) {
        setSmartStatus(
            (parsed.warnings || []).length
                ? `تم تجهيز البيانات للمراجعة. ${(parsed.warnings || []).join(' ')}`
                : 'تم تجهيز بيانات العملية للمراجعة.',
            'success'
        );
    } else if (parsed.ready) {
        setSmartStatus(directIssue, 'danger');
    } else {
        const issue = (parsed.missing || []).length
            ? `بيانات ناقصة: ${(parsed.missing || []).join('، ')}.`
            : 'راجع بيانات الرسالة قبل الإرسال.';
        setSmartStatus(`${issue} ${(parsed.warnings || []).join(' ')}`, 'danger');
    }
};

export {
    smartTransferMessage,
    smartTransferAnalyzeButton,
    smartAnalyzeLabel,
    setSmartStatus,
    resetSmartTransfer,
    applySmartTransferData,
    smartTransferSendButton,
    smartParsedData,
    smartTransferDirectIssue,
    assistantMessages,
    assistantQuestion,
    assistantSuggestions,
    assistantSubmitButton,
    assistantDialog,
    assistantOpenButton,
    assistantForm,
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
    clearTransferValues,
    resolveSmartTransferService,
    sourceCurrencyLabel,
    calculateCostLyd,
    formatExchangeRate,
    smartDuplicateMessage,
};
