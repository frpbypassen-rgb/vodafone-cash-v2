'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const Link = require('../models/TelegramAccountLink');
const Connection = require('../models/CompanyTelegramConnection');
const Company = require('../models/ClientCompany');
const CompanyEmployee = require('../models/ClientEmployee');
const telegram = require('./telegramService');
const { resolveCompanyAccess } = require('./companyAccessService');
const BOT_USERNAME = 'Ahrampay_bot';
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const assertAccess = workspace => {
    if (!workspace?.isCompany || !workspace.permissions.canEditSettings) throw fail('FORBIDDEN', 'إدارة حسابات تيليجرام متاحة لمدير الشركة ومدير التشغيل فقط.', 403);
};
const scope = workspace => ({ companyId: workspace.entity._id, tenantId: workspace.entity.tenantId || null, deletedAt: null });
const legacyScope = workspace => ({ ownerModel: 'ClientCompany', ownerId: workspace.entity._id, tenantId: workspace.entity.tenantId || null });
const configured = () => telegram.telegramConfigured() && Boolean(process.env.TELEGRAM_WEBHOOK_SECRET);
const cleanName = value => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 60) throw fail('INVALID_NAME', 'أدخل اسماً للحساب لا يتجاوز 60 حرفاً.');
    return value.trim();
};
const publicConnection = (row, legacy = false) => ({
    id: legacy ? 'legacy' : String(row._id), name: row.name || row.displayName || 'حساب تيليجرام الحالي',
    username: row.username || '', telegramName: row.telegramName || '',
    linked: Boolean(row.chatId && row.linkedAt),
    enabled: legacy ? Boolean(row.active && row.chatId && ['both', 'telegram'].includes(row.deliveryMode)) : Boolean(row.enabled && row.chatId && row.linkedAt),
    chatHint: row.chatId ? '••••' + row.chatId.slice(-4) : '',
    linkedAt: row.linkedAt || null, lastInteractionAt: row.lastInteractionAt || row.linkedAt || null,
    expiresAt: row.codeExpiresAt || null,
    status: row.chatId && row.linkedAt ? 'linked' : row.codeExpiresAt > new Date() ? 'pending' : 'expired',
});
const status = async workspace => {
    assertAccess(workspace);
    const [rows, legacy] = await Promise.all([
        Connection.find(scope(workspace)).sort({ createdAt: 1 }).lean(), Link.findOne(legacyScope(workspace)).lean(),
    ]);
    const connections = [...(legacy?.chatId && legacy.linkedAt ? [publicConnection(legacy, true)] : []), ...rows.map(row => publicConnection(row))];
    return { available: configured(), botUsername: BOT_USERNAME, connections,
        linked: connections.some(row => row.linked), enabled: connections.some(row => row.enabled),
        chatHint: connections.find(row => row.linked)?.chatHint || '',
    };
};
const requestLink = async (workspace, name, id) => {
    assertAccess(workspace);
    let existing = null;
    if (id) {
        const found = await target(workspace, id);
        if (found.legacy || found.row.chatId) throw fail('ALREADY_LINKED', 'هذا الحساب مربوط بالفعل. يمكنك إضافة حساب آخر.');
        existing = found.row;
    }
    const label = cleanName(existing ? existing.name : name);
    if (!configured()) throw fail('TELEGRAM_UNAVAILABLE', 'تيليجرام غير مهيأ على الخادم حالياً.', 503);
    let username;
    try { username = await telegram.getBotUsername(); } catch (_) { throw fail('TELEGRAM_UNAVAILABLE', 'تعذر الاتصال ببوت تيليجرام حالياً.', 503); }
    if (username.toLowerCase() !== BOT_USERNAME.toLowerCase()) throw fail('TELEGRAM_BOT_MISMATCH', 'يجب ضبط الخادم على بوت Ahrampay_bot لإتمام الربط.', 503);
    const code = 'CMP-' + crypto.randomBytes(24).toString('hex');
    const values = { ...scope(workspace), name: label,
        requestedById: workspace.actor._id, requestedByModel: workspace.actorModel,
        codeHash: crypto.createHash('sha256').update(code).digest('hex'), codeExpiresAt: new Date(Date.now() + 600000),
    };
    const row = existing ? await Connection.findOneAndUpdate({ ...scope(workspace), _id: existing._id, chatId: { $exists: false } }, { $set: values }, { returnDocument: 'after' }) : await Connection.create(values);
    if (!row) throw fail('SETTINGS_CHANGED', 'تغيرت حالة الربط. حدّث القائمة.', 409);
    return { ...await status(workspace), connectionId: String(row._id), code, expiresAt: row.codeExpiresAt,
        botUrl: 'https://t.me/' + BOT_USERNAME + '?start=' + encodeURIComponent(code) };
};
const target = async (workspace, id) => {
    assertAccess(workspace);
    if (!id) {
        const rows = (await status(workspace)).connections.filter(row => row.linked);
        if (rows.length !== 1) throw fail('SELECT_CONNECTION', 'اختر حساب تيليجرام المطلوب.');
        id = rows[0].id;
    }
    if (id === 'legacy') {
        const row = await Link.findOne(legacyScope(workspace));
        if (!row?.chatId || !row.linkedAt) throw fail('NOT_FOUND', 'الحساب غير موجود.', 404);
        return { row, legacy: true };
    }
    if (!mongoose.isObjectIdOrHexString(id)) throw fail('NOT_FOUND', 'الحساب غير موجود.', 404);
    const row = await Connection.findOne({ ...scope(workspace), _id: id });
    if (!row) throw fail('NOT_FOUND', 'الحساب غير موجود.', 404);
    return { row, legacy: false };
};
const setEnabled = async (workspace, enabled, id) => {
    if (typeof enabled !== 'boolean') throw fail('INVALID_PREFERENCE', 'إعداد غير صالح.');
    const { row, legacy } = await target(workspace, id);
    if (!row.chatId || !row.linkedAt) throw fail('TELEGRAM_NOT_LINKED', 'أكمل ربط هذا الحساب أولاً.');
    if (legacy) {
        const whatsappEnabled = ['whatsapp', 'both'].includes(row.deliveryMode);
        row.deliveryMode = enabled ? (whatsappEnabled ? 'both' : 'telegram') : (whatsappEnabled ? 'whatsapp' : 'off');
        row.active = row.deliveryMode !== 'off'; row.codeExpiresAt = new Date(0); row.activateOnLink = false;
    } else row.enabled = enabled;
    await row.save();
    return status(workspace);
};
const rename = async (workspace, id, name) => {
    const label = cleanName(name);
    const { row, legacy } = await target(workspace, id);
    row[legacy ? 'displayName' : 'name'] = label;
    await row.save();
    return status(workspace);
};
const unlink = async (workspace, id) => {
    const { row, legacy } = await target(workspace, id);
    if (legacy) {
        await Link.updateOne({ _id: row._id }, { $set: { deliveryMode: ['whatsapp', 'both'].includes(row.deliveryMode) ? 'whatsapp' : 'off', active: false, linkedAt: null, codeExpiresAt: new Date(0), activateOnLink: false }, $unset: { chatId: 1, requestedById: 1, requestedByModel: 1 } });
    } else {
        await Connection.updateOne({ ...scope(workspace), _id: row._id }, { $set: { enabled: false, deletedAt: new Date(), codeExpiresAt: new Date(0) }, $unset: { codeHash: 1 } });
    }
    return status(workspace);
};
const sendTest = async (workspace, id) => {
    const { row, legacy } = await target(workspace, id);
    if (!row.chatId || !row.linkedAt) throw fail('TELEGRAM_NOT_LINKED', 'أكمل ربط الحساب أولاً.');
    if (!configured()) throw fail('TELEGRAM_UNAVAILABLE', 'تيليجرام غير مهيأ حالياً.', 503);
    try { await telegram.sendMessage(row.chatId, 'رسالة اختبار من أهرام باي — ' + (legacy ? row.displayName || 'حساب تيليجرام' : row.name) + '. الربط يعمل، ويمكنك إدارة استقبال الإيصالات من إعدادات حساب الشركة.'); }
    catch (_) { throw fail('TELEGRAM_TEST_FAILED', 'تعذر إرسال رسالة الاختبار إلى هذا الحساب.', 503); }
    return status(workspace);
};
const confirmLink = async ({ code, chatId, telegramUser = {} }) => {
    if (!/^CMP-[a-f0-9]{48}$/i.test(String(code)) || !/^[1-9]\d{0,19}$/.test(String(chatId))) return { success: false, code: 'INVALID_CODE' };
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const filter = { codeHash, deletedAt: null, codeExpiresAt: { $gt: new Date() } };
    const pending = await Connection.findOne(filter).lean();
    if (!pending) return { success: false, code: 'CODE_NOT_FOUND' };
    const company=await Company.findById(pending.companyId).lean();
    const actor=await CompanyEmployee.findById(pending.requestedById).lean();
    if(pending.requestedByModel !== 'ClientEmployee' || !company || company.status !== 'active' || !actor || actor.status !== 'active'
        || String(actor.companyId)!==String(company._id) || !resolveCompanyAccess(actor).canEditSettings
        || String(company.tenantId || '')!==String(pending.tenantId || '') || String(actor.tenantId || '')!==String(company.tenantId || '')) return {success:false,code:'FORBIDDEN'};
    const username = /^[A-Za-z0-9_]{5,32}$/.test(String(telegramUser.username || '')) ? telegramUser.username : '';
    const telegramName = [telegramUser.first_name, telegramUser.last_name].filter(value => typeof value === 'string').join(' ').slice(0, 120);
    if (await Link.exists({ ownerModel: 'ClientCompany', ownerId: pending.companyId, tenantId: pending.tenantId || null, chatId: String(chatId), linkedAt: { $ne: null } })) return { success: false, code: 'CHAT_ALREADY_LINKED' };
    try {
        const row = await Connection.findOneAndUpdate(filter, { $set: { chatId: String(chatId), username, telegramName, enabled: true, linkedAt: new Date(), lastInteractionAt: new Date() }, $unset: { codeHash: 1, codeExpiresAt: 1 } }, { returnDocument: 'after' });
        return row ? { success: true, link: row } : { success: false, code: 'CODE_NOT_FOUND' };
    } catch (error) { if (error.code === 11000) return { success: false, code: 'CHAT_ALREADY_LINKED' }; throw error; }
};
module.exports = { status, requestLink, setEnabled, rename, unlink, sendTest, confirmLink, BOT_USERNAME };
