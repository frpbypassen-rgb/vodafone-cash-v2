'use strict';
const crypto = require('crypto'),
    mongoose = require('mongoose');
const Pref = require('../models/CustomerNotificationPreference'),
    Link = require('../models/TelegramAccountLink'),
    Email = require('../models/CustomerReportEmail'),
    Push = require('../models/WebPushSubscription');
const { scope, fail } = require('./customerNotificationContext');
const { withRevision, revisionOf, conflict } = require('../utils/portalSettingsRevision');
const email = require('./customerReportEmailService'),
    telegram = require('./telegramService'),
    pushConfig = require('./rateAlerts/webPushService');
const ensure = async (ctx) => {
    try {
        await Pref.updateOne(scope(ctx), { $setOnInsert: scope(ctx) }, { upsert: true });
    } catch (e) {
        if (e.code !== 11000) throw e;
    }
};
const telegramStatus = (row) => ({
    revision: revisionOf(row),
    linked: Boolean(row?.chatId && row?.linkedAt),
    enabled: Boolean(
        row?.active && row?.chatId && row?.linkedAt && ['telegram', 'both'].includes(row.deliveryMode)
    ),
    username: row?.username || '',
    available: telegram.telegramConfigured() && Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
    botUsername: 'Ahrampay_bot',
});
const status = async (ctx) => {
    const [pref, link, mail] = await Promise.all([
        Pref.findOne(scope(ctx)).lean(),
        Link.findOne(scope(ctx)).lean(),
        email.getStatus(ctx),
    ]);
    return {
        revision: revisionOf(pref),
        ratesEnabled: pref?.ratesEnabled !== false,
        email: mail,
        telegram: telegramStatus(link),
        push: { configured: pushConfig.isConfigured(), publicKey: pushConfig.getConfiguration().publicKey },
    };
};
const save = async (ctx, body) => {
    for (const key of ['ratesEnabled', 'emailEnabled', 'telegramEnabled'])
        if (typeof body[key] !== 'boolean') throw fail('INVALID_PREFERENCE', 'تفضيلات غير صالحة.');
    await ensure(ctx);
    await mongoose.connection.transaction(async (session) => {
        const mail = await Email.findOne(email.ownerFilter(ctx)).session(session),
            link = await Link.findOne(scope(ctx)).session(session);
        if (revisionOf(mail) !== body.emailRevision || revisionOf(link) !== body.telegramRevision)
            throw conflict();
        if (body.emailEnabled && (!mail?.verifiedAt || !mail.email))
            throw fail('VERIFY_EMAIL', 'أكّد البريد أولًا.');
        if (body.telegramEnabled && (!link?.chatId || !link.linkedAt))
            throw fail('LINK_TELEGRAM', 'اربط تليجرام أولًا.');
        const updated = await Pref.updateOne(
            withRevision(scope(ctx), body.revision),
            {
                $set: {
                    ratesEnabled: body.ratesEnabled,
                    settingsUpdatedBy: String(ctx.actor.name || 'العميل'),
                },
                $inc: { settingsRevision: 1 },
            },
            { session }
        );
        if (!updated.modifiedCount) throw conflict();
        if (mail) {
            const saved = await Email.updateOne(
                withRevision({ _id: mail._id, ...email.ownerFilter(ctx) }, body.emailRevision),
                {
                    $set: {
                        enabled: body.emailEnabled,
                        settingsUpdatedBy: String(ctx.actor.name || 'العميل'),
                    },
                    $inc: { settingsRevision: 1 },
                },
                { session }
            );
            if (!saved.modifiedCount) throw conflict();
        }
        if (link) {
            const whatsapp = ['whatsapp', 'both'].includes(link.deliveryMode);
            const mode = body.telegramEnabled
                ? whatsapp
                    ? 'both'
                    : 'telegram'
                : whatsapp
                  ? 'whatsapp'
                  : 'off';
            const saved = await Link.updateOne(
                withRevision({ _id: link._id, ...scope(ctx) }, body.telegramRevision),
                {
                    $set: {
                        deliveryMode: mode,
                        active: mode !== 'off',
                        settingsUpdatedBy: String(ctx.actor.name || 'العميل'),
                    },
                    $inc: { settingsRevision: 1 },
                },
                { session }
            );
            if (!saved.modifiedCount) throw conflict();
        }
    });
    return status(ctx);
};
const requestTelegram = async (ctx, revision) => {
    if (!telegramStatus(null).available) throw fail('UNAVAILABLE', 'بوت الإشعارات غير مهيأ حاليًا.', 503);
    if ((await telegram.getBotUsername()).toLowerCase() !== 'ahrampay_bot')
        throw fail('BOT_MISMATCH', 'بوت الإشعارات غير مضبوط بشكل صحيح.', 503);
    const found = await Link.findOne(scope(ctx)).lean();
    if (found?.chatId && found.linkedAt) throw fail('ALREADY_LINKED', 'الحساب مرتبط بالفعل.');
    const code = 'TG-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
        values = {
            codeHash: crypto.createHash('sha256').update(code).digest('hex'),
            codeHint: code.slice(-4),
            codeExpiresAt: new Date(Date.now() + 600000),
            active: true,
            activateOnLink: false,
        };
    if (found) {
        const result = await Link.updateOne(
            withRevision({ _id: found._id, ...scope(ctx), linkedAt: null }, revision),
            { $set: values, $inc: { settingsRevision: 1 } }
        );
        if (!result.modifiedCount) throw conflict();
    } else {
        if (revision !== 0) throw conflict();
        try {
            await Link.create({ ...scope(ctx), ...values, deliveryMode: 'off', settingsRevision: 1 });
        } catch (e) {
            if (e.code === 11000) throw conflict();
            throw e;
        }
    }
    return {
        botUrl: 'https://t.me/Ahrampay_bot?start=' + encodeURIComponent(code),
        expiresAt: values.codeExpiresAt,
    };
};
const reserveTest = async (ctx) => {
    await ensure(ctx);
    const reserved = await Pref.updateOne(
        { ...scope(ctx), testAfter: { $lte: new Date() } },
        { $set: { testAfter: new Date(Date.now() + 60000) } }
    );
    if (!reserved.modifiedCount) throw fail('COOLDOWN', 'انتظر دقيقة بين رسائل الاختبار.', 429);
};
const testTelegram = async (ctx) => {
    const row = await Link.findOne(scope(ctx)).lean();
    if (!telegramStatus(row).enabled || !telegramStatus(row).available)
        throw fail('NOT_ENABLED', 'فعّل إشعارات تليجرام أولًا.');
    await reserveTest(ctx);
    const result = await telegram.sendMessage(
        row.chatId,
        'إشعار تجريبي من الأهرام باي. تم تفعيل إشعارات حسابك بنجاح.'
    );
    if (!result?.ok) throw fail('SEND_FAILED', 'تعذر تأكيد إرسال الاختبار.', 503);
    return { sent: true };
};
const endpoint = (value) => {
    let url;
    try {
        url = new URL(value);
    } catch (_) {
        throw fail('INVALID_ENDPOINT', 'اشتراك الإشعارات غير صالح.');
    }
    const host = url.hostname.toLowerCase(),
        allowed = [
            'fcm.googleapis.com',
            'updates.push.services.mozilla.com',
            'web.push.apple.com',
            'notify.windows.com',
        ];
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        (url.port && url.port !== '443') ||
        !allowed.some((name) => host === name || host.endsWith('.' + name))
    )
        throw fail('INVALID_ENDPOINT', 'خدمة إشعارات هذا المتصفح غير مدعومة.');
    return url.href;
};
const pushScope = (ctx) => ({ userId: String(ctx.actor._id), accountType: ctx.accountType });
const deviceStatus = async (ctx, target) => ({
    active: Boolean(
        target && (await Push.exists({ ...pushScope(ctx), endpoint: endpoint(target), active: true }))
    ),
});
const subscribe = async (ctx, subscription) => {
    if (!pushConfig.isConfigured()) throw fail('UNAVAILABLE', 'إشعارات الجهاز غير مهيأة حاليًا.', 503);
    const normalized = require('./companyWebPushService').normalizeSubscription(subscription);
    endpoint(normalized.endpoint);
    try {
        await Push.updateOne(
            { ...pushScope(ctx), endpoint: normalized.endpoint },
            {
                $set: { subscription: normalized.subscription, active: true, lastError: '' },
                $inc: { settingsRevision: 1 },
            },
            { upsert: true }
        );
    } catch (e) {
        if (e.code === 11000)
            throw fail('SUBSCRIPTION_CONFLICT', 'أوقف اشتراك المتصفح ثم فعّله مجددًا.', 409);
        throw e;
    }
    return { active: true };
};
const disable = async (ctx, target) => {
    await Push.updateOne(
        { ...pushScope(ctx), endpoint: endpoint(target) },
        { $set: { active: false }, $inc: { settingsRevision: 1 } }
    );
    return { active: false };
};
const testPush = async (ctx, target) => {
    if (!pushConfig.isConfigured()) throw fail('UNAVAILABLE', 'إشعارات الجهاز غير مهيأة.', 503);
    const row = await Push.findOne({ ...pushScope(ctx), endpoint: endpoint(target), active: true }).lean();
    if (!row) throw fail('NOT_ENABLED', 'فعّل الإشعارات على هذا الجهاز أولًا.');
    await reserveTest(ctx);
    const webpush = require('web-push'),
        config = pushConfig.getConfiguration();
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    try {
        await webpush.sendNotification(
            row.subscription,
            JSON.stringify({
                title: 'الأهرام باي',
                message: 'هذا إشعار تجريبي. إشعارات جهازك تعمل.',
                tag: 'customer-notification-test',
            }),
            { TTL: 60 }
        );
    } catch (_) {
        throw fail('SEND_FAILED', 'تعذر إرسال الإشعار التجريبي.', 503);
    }
    return { sent: true };
};
module.exports = {
    status,
    save,
    requestTelegram,
    testTelegram,
    deviceStatus,
    subscribe,
    disable,
    testPush,
    telegramStatus,
    endpoint,
};
