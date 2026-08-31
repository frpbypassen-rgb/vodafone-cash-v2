'use strict';

const API_URL = 'https://api.openai.com/v1/responses';
const MAX_QUESTION_LENGTH = 800;
const MAX_ANSWER_LENGTH = 1800;
const REQUEST_TIMEOUT_MS = Math.max(5000, Math.min(30000, Number(process.env.BUSINESS_ASSISTANT_AI_TIMEOUT_MS || 15000)));

const clean = (value, limit = MAX_ANSWER_LENGTH) => String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);

const isEnabled = () => Boolean(
    String(process.env.OPENAI_API_KEY || '').trim()
    && String(process.env.BUSINESS_ASSISTANT_AI_ENABLED || 'true').trim().toLowerCase() !== 'false'
);

const buildInstructions = (workspace) => {
    const canViewBalance = Boolean(workspace.permissions?.canViewBalance);
    const accountContext = {
        portal: workspace.type || 'business',
        role: workspace.roleLabel || 'مستخدم',
        accountName: clean(workspace.entity?.name, 120),
        balanceAvailable: canViewBalance ? Number(workspace.entity?.balance || 0) : null,
        permissions: {
            canViewBalance,
            canTransfer: Boolean(workspace.permissions?.canTransfer),
            canViewReports: Boolean(workspace.permissions?.canViewReports),
            canManageStaff: Boolean(workspace.permissions?.canManageStaff),
            canManageCustomers: Boolean(workspace.permissions?.canManageCustomers)
        }
    };
    return [
        'أنت مساعد أهرام الذكي داخل بوابة أعمال مالية. تحدث بالعربية الطبيعية والودية وباختصار مناسب.',
        'أجب عن الأسئلة العامة والتحية بصورة إنسانية. في الأسئلة المتعلقة بالمنظومة، اعتمد فقط على سياق الحساب المرفق.',
        'لا تكشف أو تناقش كود المصدر أو مفاتيح API أو كلمات المرور أو رموز المصادقة أو أسرار الإدارة أو بيانات حسابات أخرى.',
        'لا تنفذ تحويلاً أو تعدل بيانات أو تدّعي حصول أي عملية. وجّه المستخدم إلى الشاشة المناسبة عند الحاجة.',
        'لا تخترع رصيداً أو حالة عملية أو سعراً أو سياسة غير موجودة في السياق. إذا احتاج السؤال بيانات مباشرة، اطلب فتح التقرير أو سجل العمليات.',
        `سياق الحساب المسموح: ${JSON.stringify(accountContext)}`
    ].join('\n');
};

const answer = async ({ workspace, question }) => {
    if (!isEnabled()) return null;
    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: String(process.env.BUSINESS_ASSISTANT_AI_MODEL || 'gpt-5.6-terra').trim(),
                store: false,
                max_output_tokens: 450,
                instructions: buildInstructions(workspace),
                input: clean(question, MAX_QUESTION_LENGTH)
            }),
            signal: controller.signal
        });
        if (!response.ok) {
            const requestId = response.headers.get('x-request-id') || 'unknown';
            console.warn(`[Business Assistant AI] OpenAI request failed (${response.status}, ${requestId})`);
            return null;
        }
        const payload = await response.json();
        const output = clean(payload.output_text);
        return output || null;
    } catch (error) {
        const reason = error?.name === 'AbortError' ? 'timeout' : 'network_error';
        console.warn(`[Business Assistant AI] OpenAI unavailable (${reason})`);
        return null;
    } finally {
        clearTimeout(timeout);
    }
};

module.exports = { answer, isEnabled, buildInstructions };
