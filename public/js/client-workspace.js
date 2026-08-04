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
        return `${date.toLocaleDateString('en-GB')} - ${date.toLocaleTimeString('ar-LY', { hour: '2-digit', minute: '2-digit' })}`;
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
        body.classList.toggle('bw-sidebar-open', open);
        document.querySelectorAll('[data-sidebar-toggle]').forEach((button) => {
            button.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
    };

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
            if (!window.confirm(form.dataset.confirm)) event.preventDefault();
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
    const transferBeneficiary = document.getElementById('transferBeneficiary');
    const transferBankName = document.getElementById('transferBankName');
    const transferSubtype = document.getElementById('transferSubtype');
    const transferCity = document.getElementById('transferCity');
    const transferIdentityImage = document.getElementById('transferIdentityImage');
    const selectedServiceTitle = document.getElementById('selectedServiceTitle');
    const destinationFieldLabel = document.getElementById('destinationFieldLabel');
    const destinationFieldHint = document.getElementById('destinationFieldHint');
    const costServiceLabel = document.getElementById('costServiceLabel');
    const costRate = document.getElementById('costRate');
    const costEstimate = document.getElementById('costEstimate');
    const transferResult = document.getElementById('transferFormResult');
    let activeService = null;

    const toggleConditionalField = (selector, enabled, input) => {
        const field = document.querySelector(selector);
        if (field) field.hidden = !enabled;
        if (input) input.required = Boolean(enabled);
        if (!enabled && input) input.value = '';
    };

    const updateCostEstimate = () => {
        if (!activeService || !costEstimate) return;
        const amount = Number(transferAmount?.value || 0);
        const rate = Number(activeService.rate || 0);
        const estimate = amount > 0 && rate > 0 ? amount / rate : 0;
        costEstimate.textContent = `${formatNumber(estimate, 3)} LYD`;
    };

    const selectService = (serviceKey) => {
        const service = (config.services || []).find((item) => item.key === serviceKey) || config.services?.[0];
        if (!service) return;
        activeService = service;
        serviceButtons.forEach((button) => {
            const selected = button.dataset.serviceKey === service.key;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });
        if (transferType) transferType.value = service.webType;
        if (selectedServiceTitle) selectedServiceTitle.textContent = `تحويل ${service.label}`;
        if (destinationFieldLabel) destinationFieldLabel.textContent = service.numberLabel;
        if (destinationFieldHint) destinationFieldHint.textContent = service.numberPlaceholder || 'أدخل بيانات المستلم بدقة.';
        if (transferDestination) transferDestination.placeholder = service.numberPlaceholder || '';
        if (transferBeneficiary) transferBeneficiary.required = Boolean(service.beneficiaryRequired);
        toggleConditionalField('[data-bank-field]', Boolean(service.requiresBankName), transferBankName);
        toggleConditionalField('[data-subtype-field]', Boolean(service.requiresSubtype), transferSubtype);
        toggleConditionalField('[data-city-field]', Boolean(service.requiresCity), transferCity);
        toggleConditionalField('[data-identity-field]', Boolean(service.requiresIdentityImage), transferIdentityImage);
        if (costServiceLabel) costServiceLabel.textContent = service.label;
        if (costRate) costRate.textContent = formatNumber(service.rate, 2);
        updateCostEstimate();
    };

    serviceButtons.forEach((button) => {
        button.addEventListener('click', () => selectService(button.dataset.serviceKey));
    });
    transferAmount?.addEventListener('input', updateCostEstimate);
    transferDestination?.addEventListener('input', () => {
        if (transferAccountNumber) transferAccountNumber.value = transferDestination.value.trim();
    });
    if (serviceButtons.length) selectService(config.selectedService || serviceButtons[0].dataset.serviceKey);

    const showFormResult = (element, message, success) => {
        if (!element) return;
        element.hidden = false;
        element.className = `bw-form-result ${success ? 'success' : 'danger'}`;
        element.innerHTML = `<i class="fa-solid ${success ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i> ${escapeHtml(message)}`;
    };

    transferForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!transferForm.reportValidity()) return;
        if (activeService?.requiresIdentityImage && !transferIdentityImage?.files?.length) {
            showFormResult(transferResult, 'أرفق صورة بطاقة الهوية لهذه الخدمة.', false);
            return;
        }
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
                body: new FormData(transferForm)
            });
            const payload = await parseJsonResponse(response);
            if (!response.ok || payload.error) throw new Error(payload.error || 'تعذر إرسال العملية.');
            showFormResult(transferResult, `${payload.message || 'تم تسجيل العملية.'} يمكنك متابعتها من سجل المعاملات.`, true);
            transferAmount.value = '';
            transferForm.querySelector('textarea[name="notes"]').value = '';
            updateCostEstimate();
        } catch (error) {
            showFormResult(transferResult, error.message || 'تعذر إرسال العملية.', false);
        } finally {
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.innerHTML = originalHtml;
            }
        }
    });

    const balanceTransferForm = document.getElementById('balanceTransferForm');
    const balanceTransferResult = document.getElementById('balanceTransferResult');
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
            const approved = window.confirm(`سيتم تحويل ${bodyData.amount} LYD إلى ${lookup.target.name} (${lookup.target.accountCode}). هل تريد المتابعة؟`);
            if (!approved) return;

            const transferResponse = await fetch('/client/balance-transfer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': config.csrfToken || '' },
                body: JSON.stringify(bodyData)
            });
            const transfer = await parseJsonResponse(transferResponse);
            if (!transferResponse.ok || !transfer.success) throw new Error(transfer.error || 'تعذر تحويل الرصيد.');
            showFormResult(balanceTransferResult, `${transfer.message} رقم العملية: ${transfer.transferId}`, true);
            balanceTransferForm.reset();
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

    const renderTransactionDetails = (transaction) => {
        const serviceDetails = transaction.serviceDetails || {};
        const statusTone = ['completed', 'deposit'].includes(transaction.status)
            ? 'success'
            : ['pending', 'processing', 'accepted', 'deposit_pending'].includes(transaction.status)
                ? 'warning'
                : 'danger';
        return `
            <div class="bw-detail-hero">
                <div><small>رقم العملية</small><strong class="bw-mono">${escapeHtml(transaction.customId)}</strong></div>
                <span class="bw-status ${statusTone}">${escapeHtml(transaction.statusLabel)}</span>
            </div>
            <div class="bw-detail-grid">
                ${detailItem('الخدمة', transaction.serviceLabel)}
                ${detailItem('المبلغ', `${formatNumber(transaction.amount, 0)} EGP`, true)}
                ${config.canViewBalance ? detailItem('التكلفة', `${formatNumber(transaction.costLYD, 3)} LYD`, true) : ''}
                ${config.canViewBalance ? detailItem('سعر الصرف', formatNumber(transaction.exchangeRate, 2), true) : ''}
                ${detailItem('رقم المستلم / الحساب', transaction.destination, true)}
                ${detailItem('اسم المستفيد', transaction.accountName)}
                ${detailItem('العميل', transaction.customerName || 'الحساب الرئيسي')}
                ${detailItem('أرسلها الموظف', transaction.employeeName)}
                ${detailItem('نوع سيفا', serviceDetails.subtype)}
                ${detailItem('المدينة', serviceDetails.city)}
                ${detailItem('البنك', serviceDetails.bankName)}
                ${detailItem('تاريخ الإنشاء', formatDateTime(transaction.createdAt), true)}
                ${detailItem('رقم الإلغاء', transaction.cancellationNumber, true)}
                ${detailItem('سبب الإلغاء', transaction.cancellationReason)}
            </div>
            <div class="bw-detail-notes"><span>ملاحظة العميل</span><p>${escapeHtml(transaction.notes || 'لا توجد ملاحظة')}</p></div>
        `;
    };

    const openTransactionDetails = async (transactionId) => {
        if (!transactionDialog || !transactionDetailsBody) return;
        transactionDetailsBody.innerHTML = '<div class="bw-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><span>جارٍ تحميل التفاصيل...</span></div>';
        openDialog(transactionDialog);
        try {
            const response = await fetch(`/client/transactions/${encodeURIComponent(transactionId)}/details`, { headers: { Accept: 'application/json' } });
            const payload = await parseJsonResponse(response);
            if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تحميل التفاصيل.');
            transactionDetailsBody.innerHTML = renderTransactionDetails(payload.transaction);
        } catch (error) {
            transactionDetailsBody.innerHTML = `<div class="bw-empty"><i class="fa-solid fa-circle-exclamation"></i><strong>${escapeHtml(error.message)}</strong></div>`;
        }
    };

    document.querySelectorAll('[data-transaction-id]').forEach((button) => {
        button.addEventListener('click', () => openTransactionDetails(button.dataset.transactionId));
    });

    const supportMessages = document.getElementById('supportMessages');
    const supportForm = document.getElementById('supportMessageForm');
    const supportResult = document.getElementById('supportMessageResult');

    const renderSupportMessages = (messages) => {
        if (!supportMessages) return;
        if (!messages?.length) {
            supportMessages.innerHTML = '<div class="bw-empty"><i class="fa-regular fa-comments"></i><strong>ابدأ المحادثة</strong><span>أرسل تفاصيل استفسارك وسيظهر رد الدعم هنا.</span></div>';
            return;
        }
        supportMessages.innerHTML = messages.map((message) => `
            <article class="bw-chat-message ${message.sender === 'admin' ? 'admin' : 'user'}">
                <header><strong>${escapeHtml(message.sender === 'admin' ? 'فريق الدعم' : message.senderName || 'أنت')}</strong><time>${escapeHtml(formatDateTime(message.createdAt))}</time></header>
                ${message.text ? `<p>${escapeHtml(message.text)}</p>` : ''}
                ${message.imageUrl ? `<img src="${escapeHtml(message.imageUrl)}" alt="صورة مرفقة بالمحادثة">` : ''}
            </article>
        `).join('');
        supportMessages.scrollTop = supportMessages.scrollHeight;
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

    if (supportMessages) loadSupportMessages();

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setSidebar(false);
    });
})();
