/* exported dismissEmergency, encodeQuickExecuteTelUri, launchQuickExecuteTel, copyQuickExecuteUssd, showQuickExecuteCopyFallback, quickExecuteDial */
// 🎯 الزر التفاعلي (إيقاف الإنذار)
async function dismissEmergency() {
    if (!currentEmergencyId) return;
    const tempId = currentEmergencyId;
    dismissedAlertsIds.add(tempId);

    document.getElementById('sirenSound').pause();
    document.getElementById('sirenSound').currentTime = 0;
    document.getElementById('emergencyOverlay').style.display = 'none';
    currentEmergencyId = null;

    try {
        await executorApiFetch('/executor-portal/api/clear-alert/' + tempId, { method: 'POST' });
    } catch {}
}

function encodeQuickExecuteTelUri(ussdOrUri) {
    const raw = String(ussdOrUri || '').trim();
    const payload = raw.replace(/^tel:/i, '').replace(/%2a/gi, '*').replace(/%23/g, '#');
    return 'tel:' + payload.replace(/\*/g, '%2A').replace(/#/g, '%23');
}

function launchQuickExecuteTel(telUri) {
    const href = encodeQuickExecuteTelUri(telUri);
    try {
        const anchor = document.createElement('a');
        anchor.setAttribute('href', href);
        anchor.setAttribute('rel', 'noopener');
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        return true;
    } catch (_error) {
        try {
            window.location.href = href;
            return true;
        } catch (_fallback) {
            return false;
        }
    }
}

async function copyQuickExecuteUssd(ussd) {
    const text = String(ussd || '');
    if (!text) return;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }
    } catch (_error) {}
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.focus();
    area.select();
    try {
        document.execCommand('copy');
    } catch (_error) {}
    area.remove();
}

async function showQuickExecuteCopyFallback(ussd, telUri) {
    const code = String(ussd || '').trim();
    const result = await Swal.fire({
        icon: 'info',
        title: 'تعذر فتح الاتصال',
        html: `<p class="mb-2">انسخ كود USSD واتصل يدوياً إذا لم يفتح الهاتف شاشة الاتصال.</p>
                   <code dir="ltr" class="d-block p-2 rounded-3" style="background:rgba(0,0,0,0.06);font-size:1.05rem;">${escapeTaskHtml(code)}</code>`,
        showCancelButton: true,
        confirmButtonText: 'نسخ الكود',
        cancelButtonText: 'إعادة المحاولة',
        reverseButtons: true,
    });
    if (result.isConfirmed) {
        await copyQuickExecuteUssd(code);
    } else if (result.dismiss === Swal.DismissReason.cancel) {
        launchQuickExecuteTel(telUri || code);
    }
}

async function quickExecuteDial(taskId) {
    const needsPinPrompt = executorQuickExecute.pinRequired && !executorQuickExecute.pinSet;
    let pin = '';
    if (needsPinPrompt) {
        const prompt = await Swal.fire({
            title: 'رقم سر المحفظة',
            html: '<p class="small text-end mb-2">هذه الشبكة تتطلب رقم السر. سيظهر في شاشة الاتصال ولن يُحفظ ما لم تحفظه من الإعدادات.</p>',
            input: 'password',
            inputAttributes: { maxlength: 8, inputmode: 'numeric', autocomplete: 'new-password', dir: 'ltr' },
            showCancelButton: true,
            confirmButtonText: 'فتح الاتصال',
            cancelButtonText: 'إلغاء',
            preConfirm: (value) => {
                const digits = String(value || '').replace(/\D/g, '');
                if (digits.length < 4 || digits.length > 8) {
                    Swal.showValidationMessage('رقم السر من 4 إلى 8 أرقام.');
                    return false;
                }
                return digits;
            },
        });
        if (!prompt.isConfirmed) return;
        pin = prompt.value;
    } else if (executorQuickExecute.pinRequired) {
        const confirmed = await Swal.fire({
            icon: 'warning',
            title: 'تنفيذ سريع',
            text: 'سيظهر رقم سر المحفظة في شاشة الاتصال لهذه الشبكة. لا تشارك الشاشة أثناء الاتصال.',
            showCancelButton: true,
            confirmButtonText: 'فتح الاتصال',
            cancelButtonText: 'إلغاء',
        });
        if (!confirmed.isConfirmed) return;
    }

    try {
        const response = await executorApiFetch('/executor-portal/api/quick-execute/dial/' + taskId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pin ? { pin } : {}),
        });
        const data = await readExecutorApiResponse(response);
        const telUri = data.telUri || encodeQuickExecuteTelUri(data.ussd || '');
        if (!telUri || telUri === 'tel:') throw new Error('تعذر تجهيز كود الاتصال.');
        const launched = launchQuickExecuteTel(telUri);
        if (!launched) await showQuickExecuteCopyFallback(data.ussd || '', telUri);
        if (data.acceptedNow) window.location.assign(activeTaskUrl(taskId));
    } catch (error) {
        const message = error.message || 'فشل تجهيز الاتصال.';
        const needsSettings = /رقم سر|PIN/i.test(message);
        const goSettings = await Swal.fire({
            icon: 'error',
            title: 'تعذر التنفيذ السريع',
            text: message,
            showCancelButton: true,
            confirmButtonText: needsSettings ? 'الإعدادات' : 'حسناً',
            cancelButtonText: 'إغلاق',
        });
        if (goSettings.isConfirmed && needsSettings) {
            window.location.assign('/executor-portal/settings');
        }
    }
}
