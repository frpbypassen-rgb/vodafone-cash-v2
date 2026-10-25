import { config, parseJsonResponse, portalFetch, portalUrl } from './core.js';
import {
    assistantQuestion,
    assistantMessages,
    assistantSuggestions,
    assistantSubmitButton,
    assistantDialog,
    assistantOpenButton,
    assistantForm,
} from './services.js';
import { addAssistantMessage } from './smart-transfer.js';

const askBusinessAssistant = async (question) => {
    const value = String(question || '').trim();
    if (!value || assistantSubmitButton?.disabled) return;
    addAssistantMessage(value, 'user');
    if (assistantQuestion) assistantQuestion.value = '';
    const typing = document.createElement('div');
    typing.className = 'bw-assistant-message assistant bw-assistant-typing';
    typing.innerHTML =
        '<span class="bw-assistant-response-loader" aria-hidden="true"><i class="fa-solid fa-wand-magic-sparkles"></i><b></b><b></b><b></b></span><span>جارٍ تجهيز الرد</span>';
    assistantMessages?.appendChild(typing);
    if (assistantMessages) assistantMessages.scrollTop = assistantMessages.scrollHeight;
    const originalHtml = assistantSubmitButton?.innerHTML;
    if (assistantSubmitButton) {
        assistantSubmitButton.disabled = true;
        assistantSubmitButton.innerHTML =
            '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جارٍ الإرسال</span>';
    }
    try {
        const response = await portalFetch(portalUrl('/client/api/assistant/query'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'x-csrf-token': config.csrfToken || '',
            },
            body: JSON.stringify({ question: value }),
        });
        const payload = await parseJsonResponse(response);
        if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر الحصول على إجابة الآن.');
        addAssistantMessage(payload.answer, 'assistant', payload.action, payload.draft);
        if (assistantSuggestions && Array.isArray(payload.suggestions) && payload.suggestions.length) {
            assistantSuggestions.replaceChildren(
                ...payload.suggestions.map((suggestion) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = suggestion;
                    button.addEventListener('click', () => askBusinessAssistant(suggestion));
                    return button;
                })
            );
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
    empty.innerHTML =
        '<span class="bw-assistant-orbit orbit-one"><i class="fa-solid fa-sparkles"></i></span><span class="bw-assistant-orbit orbit-two"><i class="fa-solid fa-star"></i></span><span class="bw-assistant-orbit orbit-three"><i class="fa-solid fa-circle"></i></span><span class="bw-assistant-empty-core"><i class="fa-solid fa-wand-magic-sparkles"></i></span>';
    assistantMessages.replaceChildren(empty);
});

assistantForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    askBusinessAssistant(assistantQuestion?.value);
});

assistantSuggestions
    ?.querySelectorAll('button')
    .forEach((button) => button.addEventListener('click', () => askBusinessAssistant(button.textContent)));
