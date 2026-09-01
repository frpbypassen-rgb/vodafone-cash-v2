'use strict';

(() => {
    const config = window.businessPortal || {};
    const root = document.documentElement;
    const body = document.body;

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const formatNumber = (value, digits = 0) => {
        const number = Number(value);
        if (!Number.isFinite(number)) return '0';
        return number.toLocaleString('en-US', {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits
        });
    };

    const formatDateTime = (value) => {
        if (!value) return '---';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '---';
        return `${date.toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' })} - ${date.toLocaleTimeString('ar-LY', { timeZone: 'Africa/Tripoli', hour: '2-digit', minute: '2-digit' })}`;
    };

    const parseJsonResponse = async (response) => {
        const text = await response.text();
        try {
            return text ? JSON.parse(text) : {};
        } catch (_error) {
            return { success: false, error: response.ok ? 'استجابة غير متوقعة من الخادم.' : 'تعذر تنفيذ الطلب.' };
        }
    };

    const setSidebar = (open) => {
        const isDrawer = window.matchMedia('(max-width: 1050px)').matches;
        const next = Boolean(isDrawer && open);
        body.classList.toggle('bw-sidebar-open', next);
        document.querySelectorAll('[data-sidebar-toggle]').forEach((button) => {
            button.setAttribute('aria-expanded', next ? 'true' : 'false');
        });
    };

    const drawerQuery = window.matchMedia('(max-width: 1050px)');
    const onDrawerChange = (event) => {
        if (!event.matches) setSidebar(false);
    };
    if (typeof drawerQuery.addEventListener === 'function') {
        drawerQuery.addEventListener('change', onDrawerChange);
    } else if (typeof drawerQuery.addListener === 'function') {
        drawerQuery.addListener(onDrawerChange);
    }

    document.querySelectorAll('[data-sidebar-toggle]').forEach((button) => {
        button.addEventListener('click', () => setSidebar(!body.classList.contains('bw-sidebar-open')));
    });
    document.querySelectorAll('[data-sidebar-close]').forEach((button) => {
        button.addEventListener('click', () => setSidebar(false));
    });
    document.querySelectorAll('.bw-navigation a').forEach((link) => {
        link.addEventListener('click', () => setSidebar(false));
    });

    const resolveTheme = (preference) => {
        if (preference !== 'system') return preference;
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    };

    const applyTheme = (preference) => {
        localStorage.setItem('powerpay-business-theme', preference);
        root.dataset.theme = resolveTheme(preference);
        body.dataset.theme = root.dataset.theme;
        const icon = document.querySelector('[data-theme-toggle] i');
        if (icon) icon.className = `fa-solid ${root.dataset.theme === 'dark' ? 'fa-sun' : 'fa-moon'}`;
        const select = document.querySelector('[data-preference="theme"]');
        if (select) select.value = preference;
    };

    const savedTheme = localStorage.getItem('powerpay-business-theme') || 'light';
    applyTheme(savedTheme);
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
        button.addEventListener('click', () => applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
    });
    const themeSelect = document.querySelector('[data-preference="theme"]');
    if (themeSelect) themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));

    const densitySelect = document.querySelector('[data-preference="density"]');
    if (densitySelect) {
        densitySelect.value = localStorage.getItem('powerpay-business-density') || 'comfortable';
        densitySelect.addEventListener('change', () => {
            localStorage.setItem('powerpay-business-density', densitySelect.value);
            root.dataset.density = densitySelect.value;
        });
    }

    const settingsShell = document.querySelector('[data-settings-shell]');
    if (settingsShell) {
        const tabs = [...settingsShell.querySelectorAll('[data-settings-tab]')];
        const panels = [...settingsShell.querySelectorAll('[data-settings-panel]')];
        const activateSettingsPanel = (key) => {
            const target = panels.find((panel) => panel.id === key) || panels[0];
            if (!target) return;
            panels.forEach((panel) => {
                const active = panel === target;
                panel.hidden = !active;
                panel.classList.toggle('active', active);
            });
            tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.settingsTab === target.id));
            window.history.replaceState(null, '', `#${target.id}`);
        };
        tabs.forEach((tab) => tab.addEventListener('click', () => activateSettingsPanel(tab.dataset.settingsTab)));
        const requested = window.location.hash.replace('#', '');
        if (requested && panels.some((panel) => panel.id === requested)) activateSettingsPanel(requested);
    }

    document.querySelectorAll('[data-alert-close]').forEach((button) => {
        button.addEventListener('click', () => button.closest('.bw-alert')?.remove());
    });

    const openDialog = (dialog) => {
        if (!dialog || typeof dialog.showModal !== 'function') return;
        dialog.showModal();
    };

    const closeDialog = (button) => {
        const dialog = button.closest('dialog');
        if (dialog?.open) dialog.close();
    };

    document.querySelectorAll('[data-dialog-open]').forEach((button) => {
        button.addEventListener('click', () => openDialog(document.getElementById(button.dataset.dialogOpen)));
    });
    document.querySelectorAll('[data-dialog-close]').forEach((button) => {
        button.addEventListener('click', () => closeDialog(button));
    });
    document.querySelectorAll('dialog').forEach((dialog) => {
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close();
        });
    });

    document.querySelectorAll('form[data-confirm]').forEach((form) => {
        form.addEventListener('submit', (event) => {
            if (form.dataset.confirmAccepted === '1') {
                delete form.dataset.confirmAccepted;
                return;
            }
            event.preventDefault();
            const message = form.dataset.confirm || 'هل تريد المتابعة؟';
            const proceed = () => {
                form.dataset.confirmAccepted = '1';
                if (typeof form.requestSubmit === 'function') form.requestSubmit();
                else form.submit();
            };
            if (config.workspaceType !== 'company') {
                if (window.confirm(message)) proceed();
                return;
            }
            const dialog = document.getElementById('companyActionDialog');
            const copy = document.getElementById('companyActionCopy');
            const submit = document.getElementById('companyActionSubmit');
            if (!dialog || !copy || !submit) {
                if (window.confirm(message)) proceed();
                return;
            }
            copy.textContent = message;
            const onSubmit = () => {
                submit.removeEventListener('click', onSubmit);
                dialog.removeEventListener('close', onClose);
                dialog.close();
                proceed();
            };
            const onClose = () => {
                submit.removeEventListener('click', onSubmit);
                dialog.removeEventListener('close', onClose);
            };
            submit.addEventListener('click', onSubmit);
            dialog.addEventListener('close', onClose);
            openDialog(dialog);
        });
    });

    const customerBalanceDialog = document.getElementById('customerBalanceDialog');
    const customerBalanceForm = document.getElementById('customerBalanceForm');
    const customerBalanceName = document.getElementById('customerBalanceName');
    document.querySelectorAll('[data-customer-balance]').forEach((button) => {
        button.addEventListener('click', () => {
            if (!customerBalanceDialog || !customerBalanceForm) return;
            customerBalanceForm.action = `/client/customers/${encodeURIComponent(button.dataset.customerId)}/balance`;
            if (customerBalanceName) customerBalanceName.textContent = button.dataset.customerName || 'العميل';
            openDialog(customerBalanceDialog);
        });
    });

    const staffPasswordDialog = document.getElementById('staffPasswordDialog');
    const staffPasswordForm = document.getElementById('staffPasswordForm');
    const staffPasswordName = document.getElementById('staffPasswordName');
    document.querySelectorAll('[data-staff-password]').forEach((button) => {
        button.addEventListener('click', () => {
            if (!staffPasswordDialog || !staffPasswordForm) return;
            staffPasswordForm.action = `/client/${config.workspaceType === 'company' ? 'company' : 'agent'}/staff/${encodeURIComponent(button.dataset.memberId)}/password`;
            if (staffPasswordName) staffPasswordName.textContent = button.dataset.memberName || 'الموظف';
            openDialog(staffPasswordDialog);
        });
    });

    const serviceButtons = [...document.querySelectorAll('[data-service-key]')];
    const transferForm = document.getElementById('businessTransferForm');
    const transferType = document.getElementById('transferType');
    const transferDestination = document.getElementById('transferDestination');
    const transferAccountNumber = document.getElementById('transferAccountNumber');
    const transferAmount = document.getElementById('transferAmount');
    const transferAmountLyd = document.getElementById('transferAmountLyd');
    const transferAmountLabel = document.getElementById('transferAmountLabel');
    const transferAmountCurrency = document.getElementById('transferAmountCurrency');
    const transferBeneficiary = document.getElementById('transferBeneficiary');
    const beneficiaryFieldLabel = document.getElementById('beneficiaryFieldLabel');
    const transferSubtype = document.getElementById('transferSubtype');
    const transferCity = document.getElementById('transferCity');
    const transferSefaAcknowledgement = document.getElementById('transferSefaAcknowledgement');
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
    let smartParseTimer = null;
    let smartParseController = null;

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
    const formatExchangeRate = (rate, service = activeService) => isSourceToLydRate(service)
        ? `1 ${sourceCurrencyLabel(service)} = ${formatNumber(rate, 2)} LYD`
        : `1 LYD = ${formatNumber(rate, 2)} ${sourceCurrencyLabel(service)}`;
    const formatRateFormula = (service = activeService) => isSourceToLydRate(service)
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

    const renderSmartPreview = () => {
        if (!smartTransferPreview || !smartParsedData) return;
        const rate = Number(activeService?.rate || 0);
        const amount = Number(smartParsedData.amountEGP || 0);
        const amountLyd = calculateCostLyd(amount, rate, activeService);
        smartTransferPreview.hidden = false;
        if (smartPreviewPhone) smartPreviewPhone.textContent = smartParsedData.phone || 'غير متوفر';
        if (smartPreviewAmount) smartPreviewAmount.textContent = amount > 0 ? `${formatNumber(amount, Number.isInteger(amount) ? 0 : 2)} ${sourceCurrencyLabel(activeService)}` : 'غير متوفر';
        if (smartPreviewRate) smartPreviewRate.textContent = rate > 0 ? formatExchangeRate(rate) : 'غير متوفر';
        if (smartPreviewLyd) smartPreviewLyd.textContent = amountLyd > 0 ? `${formatNumber(amountLyd, 3)} LYD` : '---';
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
        if (smartTransferSendButton) smartTransferSendButton.disabled = !smartParsedData.ready;
    };

    const resetSmartTransfer = (clearMessage = false) => {
        smartParsedData = null;
        if (smartTransferPreview) smartTransferPreview.hidden = true;
        if (smartTransferSendButton) smartTransferSendButton.disabled = true;
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
        const cityRequired = Boolean(activeService?.requiresSubtype && requiredSubtypes.includes(transferSubtype?.value));
        toggleConditionalField('[data-city-field]', cityRequired, transferCity);
    };

    const updateSefaAcknowledgement = () => {
        const required = Boolean(activeService?.requiresDataEntryAcknowledgement);
        const field = document.querySelector('[data-sefa-acknowledgement-field]');
        if (field) field.hidden = !required;
        if (transferSefaAcknowledgement) {
            transferSefaAcknowledgement.required = required;
            if (!required) transferSefaAcknowledgement.checked = false;
        }
    };

    const clearTransferValues = () => {
        [transferDestination, transferAccountNumber, transferAmount, transferAmountLyd, transferBeneficiary,
            transferCity, transferNationalId, transferGovernorate, transferClientPhone].forEach((input) => {
            if (input) input.value = '';
        });
        if (transferIdentityImage) transferIdentityImage.value = '';
        if (transferNotes) transferNotes.value = '';
        if (transferSefaAcknowledgement) transferSefaAcknowledgement.checked = false;
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
            selectedServiceTitle.textContent = config.workspaceType === 'company'
                ? service.label
                : `تحويل ${service.label}`;
        }
        if (destinationFieldLabel) destinationFieldLabel.textContent = service.numberLabel;
        if (destinationFieldHint) destinationFieldHint.textContent = service.numberPlaceholder || 'أدخل بيانات المستلم بدقة.';
        toggleConditionalField('[data-destination-field]', service.destinationRequired !== false, transferDestination);
        if (transferDestination) {
            transferDestination.placeholder = service.numberPlaceholder || '';
            transferDestination.inputMode = service.destinationInputMode || 'text';
            setOptionalAttribute(transferDestination, 'pattern', service.destinationPattern);
            setOptionalAttribute(transferDestination, 'minlength', service.destinationMinLength);
            setOptionalAttribute(transferDestination, 'maxlength', service.destinationMaxLength);
        }
        toggleConditionalField('[data-beneficiary-field]', Boolean(service.beneficiaryRequired), transferBeneficiary);
        if (beneficiaryFieldLabel) beneficiaryFieldLabel.textContent = service.beneficiaryLabel || 'اسم المستفيد';
        if (transferBeneficiary) transferBeneficiary.placeholder = service.beneficiaryPlaceholder || 'أدخل اسم المستفيد';
        toggleConditionalField('[data-subtype-field]', Boolean(service.requiresSubtype), transferSubtype);
        if (service.requiresSubtype && transferSubtype && !transferSubtype.value) {
            transferSubtype.value = service.allowedSubtypes?.[0] || 'nita';
        }
        toggleConditionalField('[data-national-id-field]', Boolean(service.requiresNationalId), transferNationalId);
        toggleConditionalField('[data-governorate-field]', Boolean(service.requiresGovernorate), transferGovernorate);
        toggleConditionalField('[data-identity-field]', Boolean(service.requiresIdentityImage), transferIdentityImage);
        if (transferAmount) transferAmount.step = service.amountStep || '0.01';
        updateCityRequirement();
        updateSefaAcknowledgement();
        if (transferAmountLabel) transferAmountLabel.textContent = isSourceToLydRate(service) ? 'المبلغ بالسيفا' : 'المبلغ بالجنيه المصري';
        if (transferAmountCurrency) transferAmountCurrency.textContent = sourceCurrencyLabel(service);
        if (costServiceLabel) costServiceLabel.textContent = service.label;
        if (costRate) costRate.textContent = formatExchangeRate(service.rate, service);
        if (transferRateBridge) transferRateBridge.textContent = formatExchangeRate(service.rate, service);
        if (transferRateFormula) transferRateFormula.textContent = formatRateFormula(service);
        updateCostEstimate();
    };

    serviceButtons.forEach((button) => {
        button.addEventListener('click', () => selectService(button.dataset.serviceKey, { resetSmart: true }));
    });
    transferAmount?.addEventListener('input', () => updateCostEstimate());
    transferAmountLyd?.addEventListener('input', () => {
        if (!activeService || !transferAmount) return;
        const rate = Number(activeService.rate || 0);
        const amountLyd = Number(transferAmountLyd.value || 0);
        const sourceAmount = calculateSourceAmount(amountLyd, rate, activeService);
        transferAmount.value = sourceAmount > 0
            ? (activeService.integerAmount && Number.isInteger(sourceAmount) ? String(sourceAmount) : sourceAmount.toFixed(2))
            : '';
        updateCostEstimate(false);
    });
    transferDestination?.addEventListener('input', () => {
        if (transferAccountNumber) transferAccountNumber.value = transferDestination.value.trim();
    });
    transferNationalId?.addEventListener('input', () => {
        transferNationalId.value = transferNationalId.value.replace(/\D/g, '').slice(0, 14);
        if (activeService?.key === 'post_card' && transferAccountNumber) transferAccountNumber.value = transferNationalId.value;
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
        if (!transferForm && !serviceButtons.length) return;
        if (rateRefreshController) rateRefreshController.abort();
        const controller = new AbortController();
        rateRefreshController = controller;
        try {
            const response = await fetch('/client/api/rates', {
                headers: { Accept: 'application/json' },
                cache: 'no-store',
                signal: controller.signal
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
            const rateSocket = window.io();
            rateSocket.on('exchange_rates_updated', refreshServiceRates);
        }
        window.setInterval(refreshServiceRates, 30000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) refreshServiceRates();
        });
    }

    const applySmartTransferData = (parsed) => {
        smartParsedData = parsed;
        if (parsed.serviceKey && (config.services || []).some((service) => service.key === parsed.serviceKey)) {
            selectService(parsed.serviceKey);
        }
        if (transferDestination) transferDestination.value = parsed.phone || '';
        if (transferAccountNumber) transferAccountNumber.value = parsed.phone || '';
        if (transferAmount) transferAmount.value = parsed.amountEGP || '';
        if (transferBeneficiary && parsed.beneficiaryName) transferBeneficiary.value = parsed.beneficiaryName;
        if (transferNotes) transferNotes.value = parsed.note || '';
        updateCostEstimate();
        renderSmartPreview();

        if (parsed.ready) {
            setSmartStatus((parsed.warnings || []).length
                ? `تم تجهيز البيانات للمراجعة. ${(parsed.warnings || []).join(' ')}`
                : 'تم تجهيز بيانات العملية للمراجعة.', 'success');
        } else {
            const issue = (parsed.missing || []).length
                ? `بيانات ناقصة: ${(parsed.missing || []).join('، ')}.`
                : 'راجع بيانات الرسالة قبل الإرسال.';
            setSmartStatus(`${issue} ${(parsed.warnings || []).join(' ')}`, 'danger');
        }
    };

    const analyzeSmartTransfer = async () => {
        window.clearTimeout(smartParseTimer);
        smartParseTimer = null;
        const message = smartTransferMessage?.value.trim() || '';
        if (message.length < 3) {
            resetSmartTransfer(false);
            setSmartStatus('أدخل رسالة التحويل أولاً.', 'danger');
            return;
        }

        if (smartParseController) smartParseController.abort();
        const controller = new AbortController();
        smartParseController = controller;
        const originalHtml = smartTransferAnalyzeButton?.innerHTML;
        if (smartTransferAnalyzeButton) {
            smartTransferAnalyzeButton.disabled = true;
            smartTransferAnalyzeButton.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>جارٍ التحليل';
        }
        setSmartStatus('جارٍ قراءة بيانات الرسالة...', 'loading');

        try {
            const response = await fetch('/client/api/smart-transfer/parse', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'x-csrf-token': config.csrfToken || ''
                },
                body: JSON.stringify({ message }),
                signal: controller.signal
            });
            const payload = await parseJsonResponse(response);
            if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تحليل الرسالة.');
            applySmartTransferData(payload.parsed || {});
        } catch (error) {
            if (error.name !== 'AbortError') {
                resetSmartTransfer(false);
                setSmartStatus(error.message || 'تعذر تحليل الرسالة.', 'danger');
            }
        } finally {
            if (smartParseController === controller) {
                smartParseController = null;
                if (smartTransferAnalyzeButton) {
                    smartTransferAnalyzeButton.disabled = false;
                    smartTransferAnalyzeButton.innerHTML = originalHtml;
                }
            }
        }
    };

    smartTransferAnalyzeButton?.addEventListener('click', analyzeSmartTransfer);
    smartTransferMessage?.addEventListener('input', () => {
        window.clearTimeout(smartParseTimer);
        if (smartParseController) smartParseController.abort();
        if (smartTransferMessage.value.trim().length < 3) {
            resetSmartTransfer(false);
            return;
        }
        smartParseTimer = window.setTimeout(analyzeSmartTransfer, 550);
    });
    smartTransferSendButton?.addEventListener('click', () => {
        if (!smartParsedData?.ready) return;
        if (transferForm) {
            transferForm.requestSubmit();
            return;
        }
        const service = (config.services || []).find((item) => item.key === smartParsedData.serviceKey)
            || (config.services || []).find((item) => item.key === 'vodafone')
            || config.services?.[0];
        try {
            sessionStorage.setItem('businessAssistantTransferDraft', JSON.stringify({
                phone: smartParsedData.phone,
                amountEGP: smartParsedData.amountEGP,
                note: smartParsedData.note,
                beneficiaryName: smartParsedData.beneficiaryName,
                serviceKey: service?.key || 'vodafone'
            }));
        } catch (_) { /* optional browser storage */ }
        window.location.href = `/client/services/${encodeURIComponent(service?.slug || 'cash')}`;
    });

    const addAssistantMessage = (message, role = 'assistant', action = null, draft = null) => {
        if (!assistantMessages) return;
        assistantMessages.querySelector('[data-assistant-empty]')?.remove();
        const element = document.createElement('div');
        element.className = `bw-assistant-message ${role}`;
        element.textContent = message;
        if (action?.href && action?.label) {
            const link = document.createElement('a');
            link.href = action.href;
            link.textContent = action.label;
            if (draft) {
                link.addEventListener('click', () => {
                    try { sessionStorage.setItem('businessAssistantTransferDraft', JSON.stringify(draft)); } catch (_) { /* optional browser storage */ }
                });
            }
            element.appendChild(link);
        }
        assistantMessages.appendChild(element);
        assistantMessages.scrollTop = assistantMessages.scrollHeight;
    };

    const askBusinessAssistant = async (question) => {
        const value = String(question || '').trim();
        if (!value || assistantSubmitButton?.disabled) return;
        addAssistantMessage(value, 'user');
        if (assistantQuestion) assistantQuestion.value = '';
        const typing = document.createElement('div');
        typing.className = 'bw-assistant-message assistant bw-assistant-typing';
        typing.innerHTML = '<span class="bw-assistant-response-loader" aria-hidden="true"><i class="fa-solid fa-wand-magic-sparkles"></i><b></b><b></b><b></b></span><span>جارٍ تجهيز الرد</span>';
        assistantMessages?.appendChild(typing);
        if (assistantMessages) assistantMessages.scrollTop = assistantMessages.scrollHeight;
        const originalHtml = assistantSubmitButton?.innerHTML;
        if (assistantSubmitButton) {
            assistantSubmitButton.disabled = true;
            assistantSubmitButton.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جارٍ الإرسال</span>';
        }
        try {
            const response = await fetch('/client/api/assistant/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': config.csrfToken || '' },
                body: JSON.stringify({ question: value })
            });
            const payload = await parseJsonResponse(response);
            if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر الحصول على إجابة الآن.');
            addAssistantMessage(payload.answer, 'assistant', payload.action, payload.draft);
            if (assistantSuggestions && Array.isArray(payload.suggestions) && payload.suggestions.length) {
                assistantSuggestions.replaceChildren(...payload.suggestions.map((suggestion) => {
                    const button = document.createElement('button');
                    button.type = 'button'; button.textContent = suggestion;
                    button.addEventListener('click', () => askBusinessAssistant(suggestion));
                    return button;
                }));
            }
        } catch (error) {
            addAssistantMessage(error.message || 'تعذر تشغيل المساعد الآن.', 'assistant error');
        } finally {
            typing.remove();
            if (assistantSubmitButton) {
                assistantSubmitButton.disabled = false;
                assistantSubmitButton.innerHTML = originalHtml;
            }
        }
    };

    assistantOpenButton?.addEventListener('click', () => assistantDialog?.showModal());
    document.querySelector('[data-assistant-close]')?.addEventListener('click', () => assistantDialog?.close());
    document.querySelector('[data-assistant-clear]')?.addEventListener('click', () => {
        if (!assistantMessages) return;
        const empty = document.createElement('div');
        empty.className = 'bw-assistant-empty';
        empty.dataset.assistantEmpty = '';
        empty.setAttribute('aria-hidden', 'true');
        empty.innerHTML = '<span class="bw-assistant-orbit orbit-one"><i class="fa-solid fa-sparkles"></i></span><span class="bw-assistant-orbit orbit-two"><i class="fa-solid fa-star"></i></span><span class="bw-assistant-orbit orbit-three"><i class="fa-solid fa-circle"></i></span><span class="bw-assistant-empty-core"><i class="fa-solid fa-wand-magic-sparkles"></i></span>';
        assistantMessages.replaceChildren(empty);
    });
    assistantForm?.addEventListener('submit', (event) => { event.preventDefault(); askBusinessAssistant(assistantQuestion?.value); });
    assistantSuggestions?.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => askBusinessAssistant(button.textContent)));

    const showFormResult = (element, message, success) => {
        if (!element) return;
        element.hidden = false;
        element.className = `bw-form-result ${success ? 'success' : 'danger'}`;
        element.innerHTML = `<i class="fa-solid ${success ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i> ${escapeHtml(message)}`;
    };

    const applyAssistantTransferDraft = () => {
        if (!transferForm) return;
        let draft;
        try {
            draft = JSON.parse(sessionStorage.getItem('businessAssistantTransferDraft') || 'null');
            sessionStorage.removeItem('businessAssistantTransferDraft');
        } catch (_) { return; }
        if (!draft || !draft.phone || !draft.amountEGP) return;
        if (draft.serviceKey && (config.services || []).some((service) => service.key === draft.serviceKey)) {
            selectService(draft.serviceKey, { resetSmart: true });
        }
        if (transferDestination) transferDestination.value = String(draft.phone);
        if (transferAccountNumber) transferAccountNumber.value = String(draft.phone);
        if (transferAmount) transferAmount.value = String(draft.amountEGP);
        if (transferNotes) transferNotes.value = String(draft.note || '');
        if (transferBeneficiary && draft.beneficiaryName) transferBeneficiary.value = String(draft.beneficiaryName);
        updateCostEstimate();
        showFormResult(transferResult, 'تم فتح مسودة من المساعد. راجع البيانات والتكلفة قبل إرسال العملية.', true);
    };
    applyAssistantTransferDraft();

    const validateTransfer = () => {
        const amount = Number(transferAmount?.value || 0);
        if (!Number.isFinite(amount) || amount <= 0) return { message: 'أدخل مبلغ تحويل صحيحًا.', input: transferAmount };
        if (activeService?.integerAmount && !Number.isInteger(amount)) {
            return { message: 'خدمة سيفا لا تقبل كسورًا في قيمة السيفا.', input: transferAmount };
        }

        const destination = transferDestination?.value.trim() || '';
        if (activeService?.destinationRequired !== false && !destination) {
            return { message: activeService?.destinationError || 'أدخل بيانات المستلم.', input: transferDestination };
        }
        if (activeService?.destinationPattern && !new RegExp(activeService.destinationPattern).test(destination)) {
            return { message: activeService.destinationError || 'بيانات المستلم غير صحيحة.', input: transferDestination };
        }

        const beneficiaryName = transferBeneficiary?.value.trim() || '';
        if (activeService?.beneficiaryRequired && !beneficiaryName) {
            return { message: 'اسم المستفيد مطلوب.', input: transferBeneficiary };
        }
        if (activeService?.beneficiaryMinWords && beneficiaryName.split(/\s+/).filter(Boolean).length < activeService.beneficiaryMinWords) {
            return { message: 'اسم المستفيد الرباعي مطلوب لهذه الخدمة.', input: transferBeneficiary };
        }

        const subtype = transferSubtype?.value || '';
        if (activeService?.requiresSubtype && !subtype) return { message: 'اختر نوع خدمة سيفا.', input: transferSubtype };
        if (activeService?.cityRequiredForSubtypes?.includes(subtype) && !transferCity?.value.trim()) {
            return { message: 'اسم المدينة مطلوب لخدمة NITA.', input: transferCity };
        }
        if (activeService?.requiresDataEntryAcknowledgement && !transferSefaAcknowledgement?.checked) {
            return { message: 'أكد مسؤوليتك عن صحة بيانات سيفا قبل الإرسال.', input: transferSefaAcknowledgement };
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
                return { message: 'صورة البطاقة يجب أن تكون JPG أو PNG أو WEBP وبحجم لا يتجاوز 5MB.', input: transferIdentityImage };
            }
        }

        return null;
    };

    const requestCompanyPin = () => new Promise((resolve, reject) => {
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
        const response = await fetch('/security/operation-pin/status', {
            headers: { Accept: 'application/json', 'x-csrf-token': config.csrfToken || '' }
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
            transferSuccessCopy.textContent = payload.successCopy
                || (customId
                    ? 'سيظهر الإيصال في غرفة العمليات عند اكتمال التنفيذ.'
                    : (payload.message || 'تم استلام العملية.'));
        }
        if (transferSuccessRef) {
            transferSuccessRef.hidden = !customId;
            transferSuccessRef.textContent = customId;
        }
        const intl = whatsappNumberFrom(phoneHint);
        if (transferSuccessWhatsapp) {
            if (intl) {
                const text = encodeURIComponent(`تم تسجيل عملية التحويل${customId ? ` رقم ${customId}` : ''} لدى الأهرام.`);
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
            sessionStorage.setItem(draftStorageKey, JSON.stringify({
                phone: transferDestination?.value || '',
                amount: transferAmount?.value || '',
                notes: transferNotes?.value || '',
                name: transferBeneficiary?.value || '',
                clientPhone: transferClientPhone?.value || ''
            }));
        } catch (_) { /* optional */ }
    };

    const restoreTransferDraft = () => {
        if (!draftStorageKey || !transferForm) return;
        let draft;
        try { draft = JSON.parse(sessionStorage.getItem(draftStorageKey) || 'null'); } catch (_) { return; }
        if (!draft) return;
        if (transferDestination?.value.trim()) return;
        if (transferDestination && draft.phone) transferDestination.value = draft.phone;
        if (transferAccountNumber && draft.phone) transferAccountNumber.value = draft.phone;
        if (transferAmount && draft.amount) transferAmount.value = draft.amount;
        if (transferNotes && draft.notes) transferNotes.value = draft.notes;
        if (transferBeneficiary && draft.name) transferBeneficiary.value = draft.name;
        if (transferClientPhone && draft.clientPhone) transferClientPhone.value = draft.clientPhone;
        updateCostEstimate();
    };

    const executeTransfer = async () => {
        const destination = activeService?.key === 'post_card'
            ? transferGovernorate.value
            : transferDestination.value.trim();
        const accountNumber = activeService?.key === 'post_card'
            ? transferNationalId.value.trim()
            : destination;
        if (transferAccountNumber) transferAccountNumber.value = accountNumber;
        const formData = new FormData(transferForm);
        formData.set('phone', destination);
        formData.set('number', accountNumber);
        let operationPin;
        try {
            operationPin = await requestOperationPin();
        } catch (error) {
            showFormResult(transferResult, error.message || 'تعذر تأكيد التحويل.', false);
            return;
        }
        if (operationPin === null) return;
        if (operationPin) formData.set('operationPin', operationPin);

        const submitButton = document.getElementById('transferSubmitButton');
        const originalHtml = submitButton?.innerHTML;
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جارٍ تسجيل العملية...</span>';
        }
        try {
            const response = await fetch('/client/transfer', {
                method: 'POST',
                headers: { Accept: 'application/json', 'x-csrf-token': config.csrfToken || '' },
                body: formData
            });
            const payload = await parseJsonResponse(response);
            if (!response.ok || payload.error) throw new Error(payload.error || 'تعذر إرسال العملية.');
            const reference = payload.customId ? ` الرقم المرجعي ${payload.customId}.` : '';
            showFormResult(transferResult, `${payload.message || 'تم تسجيل العملية.'}${reference} يمكنك متابعتها من سجل المعاملات.`, true);
            const phoneHint = transferClientPhone?.value.trim()
                || (activeService?.key === 'vodafone' ? destination : '');
            fillTransferSuccess(payload, phoneHint);
            if (config.workspaceType === 'company') openDialog(transferSuccessDialog);
            clearTransferValues();
            resetSmartTransfer(true);
            updateCostEstimate();
            if (draftStorageKey) {
                try { sessionStorage.removeItem(draftStorageKey); } catch (_) { /* optional */ }
            }
        } catch (error) {
            showFormResult(transferResult, error.message || 'تعذر إرسال العملية.', false);
        } finally {
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.innerHTML = originalHtml;
            }
        }
    };

    const openSealConfirm = ({ html, title, onConfirm }) => {
        if (!transferConfirmDialog || !transferConfirmBody || config.workspaceType !== 'company') {
            onConfirm();
            return;
        }
        pendingTransferConfirm = onConfirm;
        if (transferConfirmTitle) transferConfirmTitle.textContent = title || 'تأكيد العملية';
        transferConfirmBody.innerHTML = html;
        openDialog(transferConfirmDialog);
    };

    const openTransferConfirm = () => {
        const amount = Number(transferAmount?.value || 0);
        const rate = Number(activeService?.rate || 0);
        const cost = calculateCostLyd(amount, rate, activeService);
        const destination = activeService?.key === 'post_card'
            ? transferNationalId?.value.trim()
            : transferDestination?.value.trim();
        openSealConfirm({
            title: `تحويل ${activeService?.label || 'الخدمة'} ${formatNumber(amount, 0)} ${sourceCurrencyLabel(activeService)}`,
            html: `
            <div class="bw-cost-preview">
                <div><span>الخدمة</span><strong>${escapeHtml(activeService?.label || '')}</strong></div>
                <div><span>المستلم</span><strong class="bw-mono">${escapeHtml(destination || '---')}</strong></div>
                <div><span>المبلغ</span><strong class="bw-mono">${escapeHtml(formatNumber(amount, 2))} ${escapeHtml(sourceCurrencyLabel(activeService))}</strong></div>
                <div><span>التكلفة</span><strong class="bw-mono">${escapeHtml(formatNumber(cost, 3))} LYD</strong></div>
            </div>`,
            onConfirm: executeTransfer
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
    document.getElementById('transferConfirmSubmit')?.addEventListener('click', () => {
        const next = pendingTransferConfirm;
        pendingTransferConfirm = null;
        transferConfirmDialog?.close();
        if (typeof next === 'function') next();
    });
    transferConfirmDialog?.addEventListener('close', () => {
        pendingTransferConfirm = null;
        if (transferConfirmTitle) transferConfirmTitle.textContent = 'تأكيد العملية';
    });
    [transferDestination, transferAmount, transferNotes, transferBeneficiary, transferClientPhone].forEach((input) => {
        input?.addEventListener('input', persistTransferDraft);
    });
    document.querySelectorAll('[data-recipient-phone]').forEach((button) => {
        button.addEventListener('click', () => {
            if (transferDestination) transferDestination.value = button.dataset.recipientPhone || '';
            if (transferAccountNumber) transferAccountNumber.value = button.dataset.recipientPhone || '';
            if (transferBeneficiary && button.dataset.recipientName) transferBeneficiary.value = button.dataset.recipientName;
            persistTransferDraft();
            updateCostEstimate();
        });
    });
    restoreTransferDraft();

    const balanceTransferForm = document.getElementById('balanceTransferForm');
    const balanceTransferResult = document.getElementById('balanceTransferResult');

    const submitBalanceTransfer = async (bodyData) => {
        try {
            const operationPin = await requestOperationPin();
            if (operationPin === null) return;
            if (operationPin) bodyData.operationPin = operationPin;

            const transferResponse = await fetch('/client/balance-transfer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': config.csrfToken || '' },
                body: JSON.stringify(bodyData)
            });
            const transfer = await parseJsonResponse(transferResponse);
            if (!transferResponse.ok || !transfer.success) throw new Error(transfer.error || 'تعذر تحويل الرصيد.');
            showFormResult(balanceTransferResult, `${transfer.message} رقم العملية: ${transfer.transferId}`, true);
            fillTransferSuccess({
                customId: transfer.transferId,
                message: transfer.message,
                successCopy: transfer.message || 'تم تحويل الرصيد الداخلي.'
            }, '');
            if (config.workspaceType === 'company') openDialog(transferSuccessDialog);
            balanceTransferForm.reset();
        } catch (error) {
            showFormResult(balanceTransferResult, error.message || 'تعذر تحويل الرصيد.', false);
        }
    };

    balanceTransferForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!balanceTransferForm.reportValidity()) return;
        const formData = new FormData(balanceTransferForm);
        const bodyData = Object.fromEntries(formData.entries());
        try {
            const lookupResponse = await fetch('/client/balance-transfer/lookup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': config.csrfToken || '' },
                body: JSON.stringify({ targetAccountCode: bodyData.targetAccountCode })
            });
            const lookup = await parseJsonResponse(lookupResponse);
            if (!lookupResponse.ok || !lookup.success) throw new Error(lookup.error || 'تعذر التحقق من الحساب.');
            const confirmCopy = `سيتم تحويل ${bodyData.amount} LYD إلى ${lookup.target.name} (${lookup.target.accountCode}).`;
            if (config.workspaceType !== 'company') {
                if (!window.confirm(`${confirmCopy} هل تريد المتابعة؟`)) return;
                await submitBalanceTransfer(bodyData);
                return;
            }
            openSealConfirm({
                title: 'تأكيد التحويل الداخلي',
                html: `
                    <div class="bw-cost-preview">
                        <div><span>المستلم</span><strong>${escapeHtml(lookup.target.name || '')}</strong></div>
                        <div><span>رقم الحساب</span><strong class="bw-mono">${escapeHtml(lookup.target.accountCode || '')}</strong></div>
                        <div><span>المبلغ</span><strong class="bw-mono">${escapeHtml(formatNumber(Number(bodyData.amount || 0), 2))} LYD</strong></div>
                    </div>
                    <p class="bw-dialog-note">${escapeHtml(confirmCopy)}</p>`,
                onConfirm: () => submitBalanceTransfer(bodyData)
            });
        } catch (error) {
            showFormResult(balanceTransferResult, error.message || 'تعذر تحويل الرصيد.', false);
        }
    });

    const transactionDialog = document.getElementById('transactionDetailsDialog');
    const transactionDetailsBody = document.getElementById('transactionDetailsBody');

    const detailItem = (label, value, mono = false) => {
        if (value === undefined || value === null || value === '') return '';
        return `<div class="bw-detail-item"><span>${escapeHtml(label)}</span><strong class="${mono ? 'bw-mono' : ''}">${escapeHtml(value)}</strong></div>`;
    };

    const renderReceiptGallery = (transaction) => {
        const receiptImages = Array.isArray(transaction.receiptImages) ? transaction.receiptImages : [];
        if (!receiptImages.length) return '';

        return `
            <section class="bw-receipt-section">
                <header class="bw-receipt-section-head">
                    <div><span>مستندات التنفيذ</span><strong><i class="fa-solid fa-receipt"></i> صور الإيصال</strong></div>
                    <span class="bw-meta-chip">${formatNumber(receiptImages.length)} ${receiptImages.length === 1 ? 'صورة' : 'صور'}</span>
                </header>
                <div class="bw-receipt-gallery">
                    ${receiptImages.map((image, index) => {
                        const url = escapeHtml(image.url);
                        const label = escapeHtml(image.label || `صورة الإيصال ${index + 1}`);
                        return `
                            <figure class="bw-receipt-figure">
                                <a href="${url}" target="_blank" rel="noopener" class="bw-receipt-preview" title="فتح ${label} بالحجم الكامل">
                                    <img src="${url}" alt="${label}" loading="eager" data-receipt-image>
                                </a>
                                <figcaption>
                                    <strong>${label}</strong>
                                    <span class="bw-receipt-actions">
                                        <a href="${url}" target="_blank" rel="noopener" class="bw-icon-button compact" title="فتح بالحجم الكامل" aria-label="فتح ${label} بالحجم الكامل"><i class="fa-solid fa-up-right-from-square"></i></a>
                                        <a href="${url}" download="receipt-${escapeHtml(transaction.customId || index + 1)}-${index + 1}" class="bw-icon-button compact receipt" title="تحميل الصورة" aria-label="تحميل ${label}"><i class="fa-solid fa-download"></i></a>
                                    </span>
                                </figcaption>
                            </figure>
                        `;
                    }).join('')}
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
                    ${transaction.hasProof ? '<span class="bw-receipt-chip"><i class="fa-solid fa-receipt"></i> إيصال متاح</span>' : ''}
                </div>
            </div>
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
            ${renderReceiptGallery(transaction)}
        `;
    };

    const openTransactionDetails = async (transactionId, focusReceipt = false) => {
        if (!transactionDialog || !transactionDetailsBody) return;
        transactionDetailsBody.scrollTop = 0;
        transactionDetailsBody.innerHTML = '<div class="bw-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><span>جارٍ تحميل التفاصيل...</span></div>';
        openDialog(transactionDialog);
        try {
            const response = await fetch(`/client/transactions/${encodeURIComponent(transactionId)}/details`, { headers: { Accept: 'application/json' } });
            const payload = await parseJsonResponse(response);
            if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تحميل التفاصيل.');
            transactionDetailsBody.innerHTML = renderTransactionDetails(payload.transaction);
            if (focusReceipt) {
                const receiptSection = transactionDetailsBody.querySelector('.bw-receipt-section');
                if (receiptSection) {
                    transactionDetailsBody.scrollTo({
                        top: Math.max(0, receiptSection.offsetTop - transactionDetailsBody.offsetTop - 10),
                        behavior: 'auto'
                    });
                }
            }
        } catch (error) {
            transactionDetailsBody.innerHTML = `<div class="bw-empty"><i class="fa-solid fa-circle-exclamation"></i><strong>${escapeHtml(error.message)}</strong></div>`;
        }
    };

    document.querySelectorAll('[data-transaction-id]').forEach((button) => {
        button.addEventListener('click', () => openTransactionDetails(
            button.dataset.transactionId,
            button.hasAttribute('data-receipt-focus')
        ));
    });

    const supportMessages = document.getElementById('supportMessages');
    const supportForm = document.getElementById('supportMessageForm');
    const supportResult = document.getElementById('supportMessageResult');
    let supportMessagesSignature = '';

    const buildSupportMessagesSignature = (messages) => JSON.stringify((messages || []).map((message) => [
        message._id || '',
        message.sender || '',
        message.text || '',
        message.imageUrl || '',
        message.channel || '',
        message.createdAt || ''
    ]));

    const renderSupportMessages = (messages) => {
        if (!supportMessages) return;
        const signature = buildSupportMessagesSignature(messages);
        if (signature === supportMessagesSignature) return;
        const isNearBottom = supportMessages.scrollHeight - supportMessages.clientHeight <= supportMessages.scrollTop + 56;
        supportMessagesSignature = signature;
        if (!messages?.length) {
            supportMessages.innerHTML = '<div class="bw-empty"><i class="fa-regular fa-comments"></i><strong>ابدأ المحادثة</strong><span>أرسل تفاصيل استفسارك وسيظهر رد الدعم هنا.</span></div>';
            return;
        }
        supportMessages.innerHTML = messages.map((message) => `
            <article class="bw-chat-message ${['admin', 'ai'].includes(message.sender) ? 'admin' : 'user'}">
                <header><strong>${escapeHtml(['admin', 'ai'].includes(message.sender) ? 'فريق الدعم' : message.senderName || 'أنت')}${message.channel === 'whatsapp' ? ' <i class="fa-brands fa-whatsapp" title="رسالة واتساب" aria-hidden="true"></i>' : ''}</strong><time>${escapeHtml(formatDateTime(message.createdAt))}</time></header>
                ${message.text ? `<p>${escapeHtml(message.text)}</p>` : ''}
                ${message.imageUrl ? `<img src="${escapeHtml(message.imageUrl)}" alt="صورة مرفقة بالمحادثة">` : ''}
            </article>
        `).join('');
        if (isNearBottom) supportMessages.scrollTop = supportMessages.scrollHeight;
    };

    const loadSupportMessages = async () => {
        if (!supportMessages) return;
        try {
            const response = await fetch('/client/api/support/messages', { headers: { Accept: 'application/json' } });
            const payload = await parseJsonResponse(response);
            if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تحميل المحادثة.');
            renderSupportMessages(payload.messages || []);
        } catch (error) {
            supportMessages.innerHTML = `<div class="bw-empty"><i class="fa-solid fa-circle-exclamation"></i><strong>${escapeHtml(error.message)}</strong></div>`;
        }
    };

    const fileToDataUrl = (file) => new Promise((resolve, reject) => {
        if (!file) return resolve(null);
        if (file.size > 4 * 1024 * 1024) return reject(new Error('حجم الصورة يجب ألا يتجاوز 4MB.'));
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('تعذر قراءة الصورة.'));
        reader.readAsDataURL(file);
    });

    supportForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!supportForm.reportValidity()) return;
        const submit = supportForm.querySelector('button[type="submit"]');
        const textInput = supportForm.elements.text;
        const imageInput = supportForm.elements.image;
        try {
            if (submit) submit.disabled = true;
            const imageBase64 = await fileToDataUrl(imageInput?.files?.[0]);
            const response = await fetch('/client/api/support/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': config.csrfToken || '' },
                body: JSON.stringify({ text: textInput.value.trim(), imageBase64 })
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

    const companyWelcomeDialog = document.getElementById('companyWelcomeDialog');
    const companyMessageDialog = document.getElementById('companyMessageDialog');
    const companyMessageTitle = document.getElementById('companyMessageTitle');
    const companyMessageCopy = document.getElementById('companyMessageCopy');
    const companyLowBalanceDialog = document.getElementById('companyLowBalanceDialog');
    const showAdminMessage = async () => {
        if (config.workspaceType !== 'company' || !companyMessageDialog || companyWelcomeDialog?.open || companyLowBalanceDialog?.open) return;
        try {
            const response = await fetch('/client/api/notifications/unread', { headers: { Accept: 'application/json' } });
            const payload = await parseJsonResponse(response);
            const note = (payload.notifications || [])[0];
            if (!note) return;
            if (companyMessageTitle) companyMessageTitle.textContent = note.title || 'رسالة من الإدارة';
            if (companyMessageCopy) companyMessageCopy.textContent = note.message || '';
            const ack = document.getElementById('companyMessageAck');
            if (ack) {
                ack.onclick = async () => {
                    await fetch(`/client/api/notifications/${encodeURIComponent(note._id)}/read`, {
                        method: 'POST',
                        headers: { Accept: 'application/json', 'x-csrf-token': config.csrfToken || '' }
                    }).catch(() => {});
                    companyMessageDialog.close();
                };
            }
            openDialog(companyMessageDialog);
        } catch (_) { /* optional */ }
    };
    const showLowBalanceAlert = () => {
        const alert = config.lowBalanceAlert;
        if (config.workspaceType !== 'company' || !companyLowBalanceDialog || !alert) return false;
        let alreadySeen = false;
        try {
            alreadySeen = Boolean(sessionStorage.getItem('company-os-low-balance'));
            if (!alreadySeen) sessionStorage.setItem('company-os-low-balance', '1');
        } catch (_) { /* optional */ }
        if (alreadySeen) return false;
        const title = document.getElementById('companyLowBalanceTitle');
        const copy = document.getElementById('companyLowBalanceCopy');
        if (title) title.textContent = alert.title;
        if (copy) copy.textContent = alert.copy;
        companyLowBalanceDialog.dataset.tone = alert.tone || 'warning';
        openDialog(companyLowBalanceDialog);
        return true;
    };
    const afterCompanyWelcome = () => {
        if (showLowBalanceAlert()) {
            companyLowBalanceDialog.addEventListener('close', () => {
                window.setTimeout(showAdminMessage, 250);
            }, { once: true });
            return;
        }
        window.setTimeout(showAdminMessage, 400);
    };
    const showCompanyWelcome = () => {
        if (config.workspaceType !== 'company' || !companyWelcomeDialog) {
            afterCompanyWelcome();
            return;
        }
        let alreadySeen = false;
        try {
            alreadySeen = Boolean(sessionStorage.getItem('company-os-welcome'));
            if (!alreadySeen) sessionStorage.setItem('company-os-welcome', '1');
        } catch (_) { /* optional */ }
        if (alreadySeen) {
            afterCompanyWelcome();
            return;
        }
        companyWelcomeDialog.addEventListener('close', afterCompanyWelcome, { once: true });
        openDialog(companyWelcomeDialog);
    };
    showCompanyWelcome();

    const companyDepositForm = document.getElementById('companyDepositForm');
    const companyDepositResult = document.getElementById('companyDepositResult');
    companyDepositForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const amount = Number(document.getElementById('companyDepositAmount')?.value || 0);
        const note = String(document.getElementById('companyDepositNote')?.value || '').trim();
        if (!(amount > 0) || note.length < 3) {
            showFormResult(companyDepositResult, 'أدخل قيمة صحيحة وملاحظة توضح مرجع الإيداع.', false);
            return;
        }
        const submit = document.getElementById('companyDepositSubmit');
        if (submit) submit.disabled = true;
        try {
            const response = await fetch('/client/api/support/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': config.csrfToken || '' },
                body: JSON.stringify({
                    text: `طلب إيداع رصيد\nالقيمة: ${amount.toFixed(2)} LYD\nالملاحظة: ${note}`
                })
            });
            const payload = await parseJsonResponse(response);
            if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر إرسال طلب الإيداع.');
            showFormResult(companyDepositResult, 'تم إرسال طلب الإيداع إلى الإدارة عبر الدعم الفني.', true);
            companyDepositForm.reset();
            window.setTimeout(() => window.location.reload(), 700);
        } catch (error) {
            showFormResult(companyDepositResult, error.message || 'تعذر إرسال طلب الإيداع.', false);
        } finally {
            if (submit) submit.disabled = false;
        }
    });

    const companyLogoutDialog = document.getElementById('companyLogoutDialog');
    if (config.workspaceType === 'company' && companyLogoutDialog) {
        document.querySelectorAll('a[href="/client/logout"]').forEach((link) => {
            if (link.hasAttribute('data-logout-confirm')) return;
            link.addEventListener('click', (event) => {
                event.preventDefault();
                openDialog(companyLogoutDialog);
            });
        });
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setSidebar(false);
    });
})();
