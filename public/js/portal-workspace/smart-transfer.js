import { config, parseJsonResponse, portalFetch, portalUrl } from './core.js';
import {
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
} from './services.js';
import { openSmartTransferConfirm } from './transfers.js';

let smartParseTimer = null;

let smartParseController = null;

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
    resetSmartTransfer(false);
    const controller = new AbortController();
    smartParseController = controller;
    if (smartTransferAnalyzeButton) {
        smartTransferAnalyzeButton.disabled = true;
        smartTransferAnalyzeButton.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>جارٍ التحليل';
    }
    setSmartStatus('جارٍ قراءة بيانات الرسالة...', 'loading');

    try {
        const response = await portalFetch(portalUrl('/client/api/smart-transfer/parse'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'x-csrf-token': config.csrfToken || '',
            },
            body: JSON.stringify({ message }),
            signal: controller.signal,
        });
        const payload = await parseJsonResponse(response);
        if (
            controller.signal.aborted ||
            smartParseController !== controller ||
            smartTransferMessage.value.trim() !== message
        )
            return false;
        if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تحليل الرسالة.');
        applySmartTransferData(payload.parsed || {});
        return true;
    } catch (error) {
        if (error.name !== 'AbortError' && smartParseController === controller) {
            resetSmartTransfer(false);
            setSmartStatus(error.message || 'تعذر تحليل الرسالة.', 'danger');
        }
    } finally {
        if (smartParseController === controller) {
            smartParseController = null;
            if (smartTransferAnalyzeButton) {
                smartTransferAnalyzeButton.disabled = false;
                smartTransferAnalyzeButton.innerHTML = smartAnalyzeLabel;
            }
        }
    }
};

smartTransferAnalyzeButton?.addEventListener('click', analyzeSmartTransfer);

smartTransferMessage?.addEventListener('input', () => {
    window.clearTimeout(smartParseTimer);
    if (smartParseController) smartParseController.abort();
    resetSmartTransfer(false);
    if (smartTransferMessage.value.trim().length < 3) {
        resetSmartTransfer(false);
        return;
    }
    smartParseTimer = window.setTimeout(analyzeSmartTransfer, 550);
});

smartTransferSendButton?.addEventListener('click', async () => {
    if (!smartParsedData?.ready) return;
    // Recheck recent operations immediately before showing the final review.
    if (!(await analyzeSmartTransfer()) || !smartParsedData?.ready) return;
    const directIssue = smartTransferDirectIssue();
    if (directIssue) {
        setSmartStatus(directIssue, 'danger');
        return;
    }
    openSmartTransferConfirm();
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
                try {
                    sessionStorage.setItem('businessAssistantTransferDraft', JSON.stringify(draft));
                } catch (_) {
                    /* optional browser storage */
                }
            });
        }
        element.appendChild(link);
    }
    assistantMessages.appendChild(element);
    assistantMessages.scrollTop = assistantMessages.scrollHeight;
};

export { addAssistantMessage };
