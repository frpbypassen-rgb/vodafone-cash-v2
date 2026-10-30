'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const TelegramAccountLink = require('../models/TelegramAccountLink');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');
const TelegramDelivery = require('../models/TelegramDelivery');
const TelegramReceiptClaim = require('../models/TelegramReceiptClaim');
const AgentTelegramConnection = require('../models/AgentTelegramConnection');
const CompanyTelegramConnection = require('../models/CompanyTelegramConnection');
const AgentEmployee = require('../models/AgentEmployee');
const { tenantScope } = require('../utils/tenantScope');
const { tenantMode } = require('../middlewares/tenantResolver');
const { resolveAgentPermissions } = require('../utils/agentPortalPolicy');

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
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) throw Object.assign(new Error('Telegram request failed.'), { code: 'TELEGRAM_REQUEST_FAILED' });
    return payload;
};

const createAccountCode = async ({ ownerModel, ownerId, tenantId, preserveChat = false, activateOnLink = false, requestedById, requestedByModel }) => {
    const code = generateCode();
    const link = await TelegramAccountLink.findOneAndUpdate(
        { ownerModel, ownerId },
        { $set: { codeHash: hash(code), codeHint: code.slice(-4), tenantId, active: true, codeExpiresAt: new Date(Date.now() + 600000), activateOnLink,
            ...(requestedById ? { requestedById, requestedByModel } : {}),
            ...(!preserveChat ? { linkedAt: null } : {}) }, ...(!preserveChat ? { $unset: { chatId: 1 } } : {}) },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    return { link, code };
};

const linkChatByCode = async ({ code, chatId, telegramUser }) => {
    if (/^AGT-/i.test(String(code || '').trim())) return require('./agentTelegramSettingsService').confirmLink({ code: String(code).trim(), chatId, telegramUser });
    if (/^CMP-/i.test(String(code || '').trim())) return require('./companyTelegramSettingsService').confirmLink({ code: String(code).trim(), chatId, telegramUser });
    const normalized = String(code || '').trim().toUpperCase();
    if (!/^TG-[A-F0-9]{12}$/.test(normalized)) return { success: false, code: 'INVALID_CODE' };
    if (!/^[1-9]\d{0,19}$/.test(String(chatId))) return { success: false, code: 'PRIVATE_CHAT_REQUIRED' };
    const filter = { codeHash: hash(normalized), active: true, $or: [{ codeExpiresAt: { $gt: new Date() } }, { codeExpiresAt: { $exists: false }, linkedAt: null }] };
    const pending = await TelegramAccountLink.findOne(filter).lean();
    if (!pending) return { success: false, code: 'CODE_NOT_FOUND' };
    if (pending.ownerModel === 'User' && await AgentTelegramConnection.exists({ agentId: pending.ownerId, chatId: String(chatId), deletedAt: null, linkedAt: { $ne: null } })) return { success: false, code: 'CHAT_ALREADY_LINKED' };
    if (pending.ownerModel === 'ClientCompany' && await CompanyTelegramConnection.exists({ companyId: pending.ownerId, chatId: String(chatId), deletedAt: null, linkedAt: { $ne: null } })) return { success: false, code: 'CHAT_ALREADY_LINKED' };
    if (pending.activateOnLink) {
        const agent = await User.findById(pending.ownerId).lean();
        const actor = pending.requestedByModel === 'User' ? agent : await AgentEmployee.findById(pending.requestedById).lean();
        if (!agent || agent.role !== 'agent' || agent.status !== 'active' || !actor || String(actor._id) !== String(pending.requestedById)
            || actor.status !== 'active' || !resolveAgentPermissions(actor).canEditSettings
            || (pending.requestedByModel !== 'User' && String(actor.agentId) !== String(agent._id))
            || String(agent.tenantId || '') !== String(pending.tenantId || '') || String(actor.tenantId || '') !== String(agent.tenantId || '')) return { success: false, code: 'FORBIDDEN' };
    }
    let link;
    try {
    link = await TelegramAccountLink.findOneAndUpdate(
        filter,
        { $inc: { settingsRevision: 1 }, $set: { chatId: String(chatId), linkedAt: new Date(), linkedBy: 'telegram', codeHash: hash(crypto.randomBytes(32).toString('hex')),
            ...(pending.activateOnLink ? { deliveryMode: ['whatsapp', 'both'].includes(pending.deliveryMode) ? 'both' : 'telegram' } : {}) }, $unset: { codeExpiresAt: 1, activateOnLink: 1, requestedById: 1, requestedByModel: 1 } },
        { returnDocument: 'after' }
    ).select('+codeHash');
    } catch (error) { if (error.code === 11000) return { success: false, code: 'CHAT_ALREADY_LINKED' }; throw error; }
    return link ? { success: true, link } : { success: false, code: 'CODE_NOT_FOUND' };
};

const setWebhook = async () => {
    const url = String(process.env.TELEGRAM_WEBHOOK_URL || `${process.env.PUBLIC_APP_URL || ''}/webhooks/telegram`).replace(/\/$/, '');
    if (!url || !url.startsWith('https://')) throw new Error('TELEGRAM_WEBHOOK_URL must be HTTPS.');
    return telegramRequest('setWebhook', { url, secret_token: String(process.env.TELEGRAM_WEBHOOK_SECRET || '') });
};

const sendMessage = (chatId, text) => telegramRequest('sendMessage', { chat_id: String(chatId), text });
const recordInteraction = async chatId => {
    const update = { $set: { lastInteractionAt: new Date() } };
    await Promise.all([
        AgentTelegramConnection.updateMany({ chatId: String(chatId), deletedAt: null }, update),
        CompanyTelegramConnection.updateMany({ chatId: String(chatId), deletedAt: null }, update),
        TelegramAccountLink.updateMany({ chatId: String(chatId) }, update),
    ]);
};
let botCache = null;
const getBotUsername = async () => {
    const configuredName = String(process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
    if (/^[A-Za-z0-9_]{5,32}$/.test(configuredName)) return configuredName;
    if (botCache?.token === token() && botCache.expires > Date.now()) return botCache.username;
    const result = await telegramRequest('getMe', {});
    const username = String(result.result?.username || '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error('TELEGRAM_BOT_UNAVAILABLE');
    botCache = { token: token(), username, expires: Date.now() + 1800000 };
    return username;
};

const resolveTransactionOwner = async (transaction) => {
    if (tenantMode() === 'multi' && !transaction?.tenantId) return null;
    const tenant = tenantScope(transaction?.tenantId);
    let ownerModel;
    let ownerId;
    if (transaction?.subAccountId) {
        ownerModel = 'SubAccount'; ownerId = transaction.subAccountId;
    } else if (transaction?.companyId) {
        ownerModel = 'ClientCompany'; ownerId = transaction.companyId;
    } else if (transaction?.userId) {
        const rawUserId = String(transaction.userId).trim();
        const userFilters = [{ phone: rawUserId }, { webUsername: rawUserId }];
        if (mongoose.Types.ObjectId.isValid(rawUserId)) userFilters.unshift({ _id: rawUserId });
        const user = await User.findOne({ $or: userFilters, ...tenant }).select('_id').lean();
        if (user) { ownerModel = 'User'; ownerId = user._id; }
    }
    if (!ownerModel || !ownerId) return null;
    const Model = { User, ClientCompany, SubAccount }[ownerModel];
    const owner = await Model.findOne({ _id: ownerId, ...tenant }).select('_id status role').lean();
    if (!owner || (owner.status && owner.status !== 'active')) return null;
    return { ownerModel, ownerId, owner, tenant };
};
const findLinksForTransaction = async transaction => {
    const identity = await resolveTransactionOwner(transaction);
    if (!identity) return [];
    const { ownerModel, ownerId, owner, tenant } = identity;
    const legacy = await TelegramAccountLink.findOne({ ownerModel, ownerId, active: true, deliveryMode: { $in: ['telegram', 'both'] }, chatId: { $exists: true, $nin: ['', null] }, ...tenant }).lean();
    const connections = ownerModel === 'User' && owner.role === 'agent'
        ? await AgentTelegramConnection.find({ agentId: ownerId, ...tenant, enabled: true, deletedAt: null, linkedAt: { $ne: null }, chatId: { $exists: true, $nin: ['', null] } }).lean() : [];
    const companyConnections = ownerModel === 'ClientCompany'
        ? await CompanyTelegramConnection.find({ companyId: ownerId, ...tenant, enabled: true, deletedAt: null, linkedAt: { $ne: null }, chatId: { $exists: true, $nin: ['', null] } }).lean() : [];
    const rows = [...(legacy ? [legacy] : []), ...connections.map(row => ({ ...row, deliveryMode: legacy?.deliveryMode === 'telegram' ? 'telegram' : 'both', connectionId: row._id })),
        ...companyConnections.map(row => ({ ...row, deliveryMode: legacy?.deliveryMode === 'telegram' ? 'telegram' : 'both', connectionId: row._id, connectionModel: 'company' }))];
    return [...new Map(rows.map(row => [row.chatId, row])).values()];
};
const findLinkForTransaction = async transaction => (await findLinksForTransaction(transaction))[0] || null;

const sendReceiptToLink = async ({ transaction, receiptUrl, reference, amount, currency, proofIndex = 0 }, link) => {
    if (link.connectionId) {
        const Connection = link.connectionModel === 'company' ? CompanyTelegramConnection : AgentTelegramConnection;
        const active = await Connection.exists({ _id: link.connectionId, enabled: true, deletedAt: null, chatId: link.chatId });
        if (!active) return { success: false, skipped: true, code: 'TELEGRAM_NOT_SELECTED' };
    }
    const caption = `إيصال العملية ${reference || transaction.customId || ''}\nالمبلغ: ${amount || transaction.amount || ''} ${currency || ''}`;
    const identity = `${transaction.status}:${proofIndex}`;
    const key = { transactionId: transaction._id, chatId: link.chatId };
    const claimKey = hash(`${transaction._id}:${link.chatId}:${identity}`);
    try { await TelegramReceiptClaim.updateOne({ key: claimKey }, { $setOnInsert: { key: claimKey } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    const claim = await TelegramReceiptClaim.findOneAndUpdate({ key: claimKey, status: { $in: ['pending', 'failed'] } }, { $set: { status: 'sending' } }, { returnDocument: 'after' });
    if (!claim) {
        const existing = await TelegramReceiptClaim.findOne({ key: claimKey }).lean();
        return { success: existing?.status === 'sent', ok: existing?.status === 'sent', duplicate: true, code: existing?.status === 'uncertain' ? 'TELEGRAM_DELIVERY_UNCERTAIN' : 'TELEGRAM_ALREADY_CLAIMED' };
    }
    const delivery = await TelegramDelivery.findOneAndUpdate(key, { $set: { tenantId: link.tenantId || transaction.tenantId, reference: reference || transaction.customId || '', receiptUrl, receiptIdentity: identity, status: 'sending', failureCode: '', failureReason: '' } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
    try {
        const result = await telegramRequest('sendPhoto', { chat_id: link.chatId, photo: receiptUrl, caption });
        if (result.ok !== true) throw Object.assign(new Error('Telegram not available'), { code: 'TELEGRAM_REQUEST_FAILED' });
        delivery.status = 'sent'; delivery.messageId = String(result.result?.message_id || ''); delivery.sentAt = new Date(); await delivery.save();
        await TelegramReceiptClaim.updateOne({ _id: claim._id }, { $set: { status: 'sent', messageId: delivery.messageId } });
        return { ...result, success: true, deliveryId: delivery._id };
    } catch (error) {
        await TelegramReceiptClaim.updateOne({ _id: claim._id }, { $set: { status: error.code === 'TELEGRAM_REQUEST_FAILED' ? 'failed' : 'uncertain' } });
        delivery.status = 'failed'; delivery.failureCode = error.code || 'TELEGRAM_SEND_FAILED'; delivery.failureReason = 'تعذر إرسال إيصال Telegram.'; await delivery.save();
        throw error;
    }
};
const sendReceipt = async args => {
    if (!telegramConfigured()) return { success: false, skipped: true, code: 'TELEGRAM_NOT_CONFIGURED' };
    const links = await findLinksForTransaction(args.transaction);
    if (!links.length) return { success: false, skipped: true, code: 'TELEGRAM_NOT_SELECTED' };
    const outcomes = await Promise.allSettled(links.map(link => sendReceiptToLink(args, link)));
    const sent = outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value.success);
    if (!sent.length && outcomes.some(outcome => outcome.status === 'rejected')) throw outcomes.find(outcome => outcome.status === 'rejected').reason;
    if (!sent.length) return outcomes[0].value;
    return { success: true, ok: true, sentCount: sent.length, failedCount: outcomes.length - sent.length, duplicate: sent.every(outcome => outcome.value.duplicate), deliveryId: sent[0].value.deliveryId };
};

module.exports = { telegramConfigured, createAccountCode, linkChatByCode, setWebhook, sendMessage, recordInteraction, findLinkForTransaction, findLinksForTransaction, sendReceipt, getBotUsername };
