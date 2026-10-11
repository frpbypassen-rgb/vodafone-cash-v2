'use strict';

const crypto = require('crypto');
const TelegramAccountLink = require('../models/TelegramAccountLink');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');

const token = () => String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const api = (method) => `https://api.telegram.org/bot${token()}/${method}`;
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const generateCode = () => `TG-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

const telegramConfigured = () => Boolean(token());

const telegramRequest = async (method, body) => {
    if (!telegramConfigured()) return { ok: false, error_code: 'TELEGRAM_NOT_CONFIGURED' };
    const response = await fetch(api(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) throw new Error(payload.description || 'Telegram request failed.');
    return payload;
};

const createAccountCode = async ({ ownerModel, ownerId, tenantId }) => {
    const code = generateCode();
    const link = await TelegramAccountLink.findOneAndUpdate(
        { ownerModel, ownerId },
        { $set: { codeHash: hash(code), codeHint: code.slice(-4), tenantId, active: true, chatId: '', linkedAt: null } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return { link, code };
};

const linkChatByCode = async ({ code, chatId }) => {
    const normalized = String(code || '').trim().toUpperCase();
    if (!/^TG-[A-F0-9]{12}$/.test(normalized)) return { success: false, code: 'INVALID_CODE' };
    const link = await TelegramAccountLink.findOneAndUpdate(
        { codeHash: hash(normalized), active: true },
        { $set: { chatId: String(chatId), linkedAt: new Date(), linkedBy: 'telegram' } },
        { new: true }
    ).select('+codeHash');
    return link ? { success: true, link } : { success: false, code: 'CODE_NOT_FOUND' };
};

const setWebhook = async () => {
    const url = String(process.env.TELEGRAM_WEBHOOK_URL || `${process.env.PUBLIC_APP_URL || ''}/webhooks/telegram`).replace(/\/$/, '');
    if (!url || !url.startsWith('https://')) throw new Error('TELEGRAM_WEBHOOK_URL must be HTTPS.');
    return telegramRequest('setWebhook', { url, secret_token: String(process.env.TELEGRAM_WEBHOOK_SECRET || '') });
};

const sendMessage = (chatId, text) => telegramRequest('sendMessage', { chat_id: String(chatId), text });

const findLinkForTransaction = async (transaction) => {
    let ownerModel;
    let ownerId;
    if (transaction?.subAccountId) {
        ownerModel = 'SubAccount'; ownerId = transaction.subAccountId;
    } else if (transaction?.companyId) {
        ownerModel = 'ClientCompany'; ownerId = transaction.companyId;
    } else if (transaction?.userId) {
        const user = await User.findOne({ $or: [{ _id: transaction.userId }, { phone: transaction.userId }, { webUsername: transaction.userId }] }).select('_id').lean();
        if (user) { ownerModel = 'User'; ownerId = user._id; }
    }
    if (!ownerModel || !ownerId) return null;
    return TelegramAccountLink.findOne({ ownerModel, ownerId, active: true }).select('+codeHash').lean();
};

const sendReceipt = async ({ transaction, receiptUrl, reference, amount, currency }) => {
    const link = await findLinkForTransaction(transaction);
    if (!link?.chatId || link.deliveryMode === 'off' || link.deliveryMode === 'whatsapp') return { success: false, skipped: true, code: 'TELEGRAM_NOT_SELECTED' };
    const caption = `إيصال العملية ${reference || transaction.customId || ''}\nالمبلغ: ${amount || transaction.amount || ''} ${currency || ''}`;
    return telegramRequest('sendPhoto', { chat_id: link.chatId, photo: receiptUrl, caption });
};

module.exports = { telegramConfigured, createAccountCode, linkChatByCode, setWebhook, sendMessage, findLinkForTransaction, sendReceipt };
