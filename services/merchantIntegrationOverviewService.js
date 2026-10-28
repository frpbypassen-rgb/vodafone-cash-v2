'use strict';
const integration = require('./merchantIntegrationService');
const { tenantMode } = require('../middlewares/tenantResolver');
const { sourceIp } = require('../utils/merchantIpPolicy');
const { isMerchantWebhookWorkerEnabled } = require('../utils/runtimeControls');
const classifyWebhook = (access, stats, transport) => {
    if (!access.webhooksEnabled)
        return {
            state: 'unavailable',
            label: 'موقوف من الإدارة',
            reason: 'تحتاج الخدمة إلى تفعيل من الإدارة.',
        };
    if (!transport)
        return {
            state: 'stopped',
            label: 'التسليم متوقف',
            reason: 'الإدارة سمحت بالخدمة، لكن الإرسال متوقف من الخادم.',
        };
    if (!stats.enabled)
        return {
            state: 'incomplete',
            label: 'غير مكتمل الإعداد',
            reason: 'أضف رابط استقبال مفعّلًا.',
        };
    if (stats.failing)
        return {
            state: 'error',
            label: 'يحتاج مراجعة',
            reason: 'توجد روابط مفعّلة فشل تسليمها. راجع سجل الإرسال.',
        };
    if (stats.confirmed < stats.enabled)
        return {
            state: 'available',
            label: 'بانتظار تأكيد التسليم',
            reason: 'الروابط معدّة، لكن لم يتأكد نجاح التسليم لجميعها.',
        };
    return {
        state: 'ready',
        label: 'جاهز',
        reason: 'سُجّل تسليم ناجح للروابط المفعّلة.',
    };
};
const overview = async (workspace, req) => {
    integration.assertOwner(workspace);
    const scope = {
        ownerModel: workspace.isCompany ? 'ClientCompany' : 'User',
        ownerId: workspace.entity._id,
        ...(tenantMode() === 'multi'
            ? { tenantId: workspace.entity.tenantId || { $in: [] } }
            : {}),
    };
    const [access, groups, lastDelivery, eventsResult, transactions, uniqueIndexReady, outboxReady] =
        await Promise.all([
            integration.getStatus(workspace),
            require('../models/MerchantWebhookEndpoint')
                .aggregate([
                    { $match: scope },
                    {
                        $group: {
                            _id: null,
                            total: { $sum: 1 },
                            enabled: { $sum: { $cond: ['$enabled', 1, 0] } },
                            confirmed: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                '$enabled',
                                                {
                                                    $ne: [
                                                        {
                                                            $ifNull: [
                                                                '$lastSuccessAt',
                                                                null,
                                                            ],
                                                        },
                                                        null,
                                                    ],
                                                },
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            failing: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                '$enabled',
                                                { $gt: ['$failureCount', 0] },
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            lastSuccessAt: { $max: '$lastSuccessAt' },
                            lastFailureAt: { $max: '$lastFailureAt' },
                        },
                    },
                ])
                .option({ maxTimeMS: 1500 }),
            require('../models/MerchantWebhookDelivery')
                .findOne(scope)
                .sort({ updatedAt: -1 })
                .select(
                    'status responseCode lastAttemptAt deliveredAt updatedAt -_id',
                )
                .maxTimeMS(1500)
                .lean(),
            require('./merchantIntegrationEventService')
                .listEvents(scope)
                .then(
                    (rows) => ({ available: true, rows }),
                    () => ({ available: false, rows: [] }),
                ),
            require('mongoose')
                .connection.db.command({ hello: 1, maxTimeMS: 1000 })
                .then(
                    (result) => ({
                        available: true,
                        supported: Boolean(
                            result.setName || result.msg === 'isdbgrid',
                        ),
                    }),
                    () => ({ available: false, supported: false }),
                ),
            require('./merchantIdempotencyService').indexReady(),
            require('./merchantWebhookOutboxService').indexesReady(),
        ]);
    const stats = groups[0] || {
        total: 0,
        enabled: 0,
        confirmed: 0,
        failing: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
    };
    delete stats._id;
    const transport = isMerchantWebhookWorkerEnabled();
    const proxyReady = Boolean(sourceIp(req));
    const apiReady =
        access.apiEnabled &&
        access.keyActive &&
        transactions.supported &&
        uniqueIndexReady &&
        (!access.ipAllowlistEnabled ||
            (proxyReady && access.allowedIps.length > 0));
    return {
        access,
        api: {
            state: apiReady
                ? 'ready'
                : access.apiEnabled
                  ? 'incomplete'
                  : 'unavailable',
            label: apiReady
                ? 'متاح'
                : access.apiEnabled
                  ? 'يحتاج إعدادًا'
                  : 'موقوف من الإدارة',
            proxyReady,
            reason: !transactions.supported
                ? transactions.available
                    ? 'الخادم غير مهيأ لحماية Idempotency-Key. تواصل مع الإدارة.'
                    : 'تعذر التحقق من دعم المعاملات المالية.'
                : !uniqueIndexReady ? 'فهرس منع تكرار التحويل غير جاهز. تواصل مع الإدارة.' : '',
        },
        webhooks: {
            ...stats,
            ...classifyWebhook(access, stats, transport && outboxReady),
            ...(access.webhooksEnabled && transport && !outboxReady ? {
                state:'stopped',label:'التسليم متوقف',reason:'فهارس سجل الإشعارات الدائم غير مهيأة. تواصل مع الإدارة.',
            } : {}),
            transportEnabled: transport,
            lastDelivery,
        },
        checks: [
            {label:'سجل الإشعارات الدائم',ok:outboxReady,message:outboxReady?'فهارس Outbox جاهزة.':'يلزم تجهيز فهارس Outbox قبل تشغيل العامل.'},
            {
                label: 'فهرس منع التكرار',
                ok: uniqueIndexReady,
                message: uniqueIndexReady ? 'الفهرس الفريد موجود.'
                    : 'تعذر تأكيد الفهرس الفريد؛ الطلبات المحمية تتوقف قبل الخصم.',
            },
            {
                label: 'حماية منع تكرار التحويل',
                ok: transactions.supported,
                message: transactions.supported
                    ? 'قاعدة البيانات تدعم المعاملات اللازمة لحفظ النتيجة مع الخصم.'
                    : transactions.available
                      ? 'يلزم تهيئة دعم المعاملات على الخادم لاستخدام Idempotency-Key.'
                      : 'تعذر التحقق من دعم المعاملات المالية.',
            },
            {
                label: 'سماح الإدارة للـAPI',
                ok: access.apiEnabled,
                message: access.apiEnabled
                    ? 'متاح'
                    : 'الخدمة موقوفة من الإدارة.',
            },
            {
                label: 'التوكن',
                ok: access.keyActive,
                message: access.keyActive ? 'نشط' : 'لا يوجد مفتاح نشط.',
            },
            {
                label: 'القائمة البيضاء IP',
                ok:
                    !access.ipAllowlistEnabled ||
                    (proxyReady && access.allowedIps.length > 0),
                message: !access.ipAllowlistEnabled
                    ? 'اختيارية وغير مفعّلة.'
                    : !proxyReady
                      ? 'يلزم ضبط البروكسي الموثوق صراحةً على الخادم.'
                      : `${access.allowedIps.length} عنوان مسجل؛ اختبر الاتصال من سيرفرك.`,
            },
            {
                label: 'روابط Webhooks',
                ok: access.webhooksEnabled && stats.enabled > 0,
                message: `${stats.enabled} مفعّل من ${stats.total} رابط.`,
            },
            {
                label: 'إرسال Webhooks',
                ok: access.webhooksEnabled && transport,
                message: transport
                    ? 'النقل متاح؛ لا يثبت هذا الاختبار وصولًا خارجيًا.'
                    : 'التسليم متوقف من الخادم.',
            },
        ],
        events: eventsResult.rows,
        eventsAvailable: eventsResult.available,
        checkedAt: new Date().toISOString(),
        readOnly: true,
    };
};
module.exports = { overview, classifyWebhook };
