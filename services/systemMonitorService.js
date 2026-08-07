'use strict';

const Transaction = require('../models/Transaction');

const EVENT_LIMIT = 140;
const VISITOR_TTL_MS = 2 * 60 * 1000;
const STATIC_PATH_RE = /\.(?:css|js|png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|map)$/i;
const QUIET_ENDPOINTS = new Set([
    '/executor-portal/api/live-tasks',
    '/api/sidebar-stats',
    '/api/notifications/unread',
    '/client/api/transactions',
    '/client/api/notifications/unread'
]);

let io = null;
let movementCount = 0;
let movementDay = getDayKey();
let broadcastTimer = null;

const visitors = new Map();
const events = [];
const bootStartedAt = new Date();

function getDayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function getStartOfToday() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
}

function resetDailyCountersIfNeeded() {
    const currentDay = getDayKey();
    if (movementDay !== currentDay) {
        movementDay = currentDay;
        movementCount = 0;
        recordActivity('system', 'بدأ عداد يوم جديد للحركات داخل المنظومة.', { silentDailyReset: true });
    }
}

function isStaticOrNoisePath(path = '') {
    const cleanPath = String(path).split('?')[0];
    return (
        STATIC_PATH_RE.test(cleanPath)
        || cleanPath.startsWith('/css/')
        || cleanPath.startsWith('/images/')
        || cleanPath.startsWith('/uploads/')
        || cleanPath.startsWith('/socket.io/')
        || cleanPath.startsWith('/favicon')
        || cleanPath.startsWith('/manifest')
        || cleanPath.startsWith('/sw.js')
        || cleanPath.startsWith('/metrics')
        || cleanPath.startsWith('/health')
        || cleanPath.startsWith('/system-monitor')
        || cleanPath.startsWith('/api-docs')
        || QUIET_ENDPOINTS.has(cleanPath)
    );
}

function getVisitorKey(req) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
    const ua = req.headers['user-agent'] || 'unknown';
    return req.sessionID || `${ip}|${ua.slice(0, 80)}`;
}

function getActorName(req) {
    if (req.session?.adminName) return `الإدارة: ${req.session.adminName}`;
    if (req.session?.clientId) return 'حساب عميل';
    if (req.session?.executorId) return 'حساب منفذ';
    if (req.headers['x-api-key']) return 'واجهة API خارجية';
    return 'زائر';
}

function getAreaLabel(path = '') {
    if (path.startsWith('/client')) return 'بوابة العملاء والشركات والوكلاء';
    if (path.startsWith('/executor-portal')) return 'بوابة المنفذين';
    if (path.startsWith('/api/v1/merchant')) return 'واجهة التاجر API';
    if (path.startsWith('/api/mobile') || path.startsWith('/api/v1/mobile')) return 'تطبيق الموبايل';
    if (path.startsWith('/settings')) return 'إعدادات المنظومة';
    if (path.startsWith('/transactions')) return 'سجل العمليات';
    if (path.startsWith('/financial-movements')) return 'الحركات المالية';
    if (path.startsWith('/reports')) return 'التقارير';
    if (path.startsWith('/support')) return 'الدعم الفني';
    if (path.startsWith('/login')) return 'تسجيل الدخول';
    return 'لوحة الإدارة';
}

function getMethodLabel(method = 'GET') {
    if (method === 'GET') return 'زيارة صفحة';
    if (method === 'POST') return 'تنفيذ إجراء';
    if (method === 'PUT' || method === 'PATCH') return 'تعديل بيانات';
    if (method === 'DELETE') return 'حذف بيانات';
    return `طلب ${method}`;
}

function cleanVisitors() {
    const now = Date.now();
    for (const [key, visitor] of visitors.entries()) {
        if (now - visitor.lastSeenAt > VISITOR_TTL_MS) visitors.delete(key);
    }
}

function touchVisitor(req) {
    const key = getVisitorKey(req);
    visitors.set(key, {
        key,
        area: getAreaLabel(req.originalUrl || req.url || ''),
        actor: getActorName(req),
        lastSeenAt: Date.now()
    });
    cleanVisitors();
}

function onlineVisitorsCount() {
    cleanVisitors();
    return visitors.size;
}

function pushEvent(event) {
    events.unshift({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        at: new Date().toISOString(),
        level: event.level || 'info',
        type: event.type || 'activity',
        message: event.message,
        meta: event.meta || {}
    });
    if (events.length > EVENT_LIMIT) events.length = EVENT_LIMIT;
}

function recordActivity(type, message, meta = {}) {
    resetDailyCountersIfNeeded();
    if (!meta.silentDailyReset && !meta.silent) movementCount += 1;
    pushEvent({ type, message, meta, level: meta.level });
    scheduleBroadcast();
}

function trackRequest(req, res, next) {
    const path = req.originalUrl || req.url || '';
    const shouldTrack = !isStaticOrNoisePath(path);
    const startedAt = Date.now();

    if (shouldTrack) touchVisitor(req);

    res.on('finish', () => {
        if (!shouldTrack) return;
        touchVisitor(req);
        const durationMs = Date.now() - startedAt;
        const status = res.statusCode;
        const area = getAreaLabel(path);
        const action = getMethodLabel(req.method);
        const actor = getActorName(req);
        const level = status >= 500 ? 'danger' : status >= 400 ? 'warning' : 'info';
        recordActivity('request', `${action} في ${area} بواسطة ${actor} - الحالة ${status}`, {
            path,
            method: req.method,
            status,
            durationMs,
            actor,
            area,
            level
        });
    });

    next();
}

function describeStatus(status) {
    const labels = {
        pending: 'قيد الانتظار',
        processing: 'قيد التنفيذ',
        accepted: 'مقبولة لدى منفذ',
        completed: 'ناجحة',
        rejected: 'مرفوضة',
        deposit_pending: 'إيداع قيد المراجعة',
        deposit: 'إيداع ناجح',
        deduction: 'خصم',
        cancelled_by_admin: 'ملغية'
    };
    return labels[status] || status || 'غير محددة';
}

function recordTransactionChange(doc, operation = 'تحديث') {
    const tx = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
    const customId = tx?.customId || tx?._id || 'عملية غير معروفة';
    const amount = Number(tx?.amount || 0).toLocaleString('ar-EG');
    const status = describeStatus(tx?.status);
    recordActivity('transaction', `${operation} عملية مالية رقم ${customId} بقيمة ${amount} - الحالة: ${status}`, {
        customId: String(customId),
        amount: tx?.amount,
        status: tx?.status,
        level: tx?.status === 'rejected' || tx?.status === 'cancelled_by_admin' ? 'warning' : 'success'
    });
}

async function getTodayTransactionsCount() {
    try {
        return await Transaction.countDocuments({ createdAt: { $gte: getStartOfToday() } });
    } catch (error) {
        return 0;
    }
}

async function getSnapshot() {
    resetDailyCountersIfNeeded();
    return {
        ready: true,
        startedAt: bootStartedAt.toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        stats: {
            onlineVisitors: onlineVisitorsCount(),
            transactionsToday: await getTodayTransactionsCount(),
            siteMovements: movementCount
        },
        events: events.slice(0, EVENT_LIMIT)
    };
}

function scheduleBroadcast() {
    if (!io || broadcastTimer) return;
    broadcastTimer = setTimeout(async () => {
        broadcastTimer = null;
        if (!io) return;
        io.to('system-monitor').emit('system-monitor:snapshot', await getSnapshot());
    }, 350);
}

function attachSocketServer(socketServer) {
    io = socketServer;
    recordActivity('system', 'تم تجهيز لوحة المراقبة الحية واستقبال الأحداث.', { level: 'success', silent: true });
}

function handleSocket(socket) {
    if (socket.handshake?.query?.monitor !== '1') return;
    socket.join('system-monitor');
    getSnapshot().then((snapshot) => socket.emit('system-monitor:snapshot', snapshot)).catch(() => {});
}

module.exports = {
    attachSocketServer,
    handleSocket,
    trackRequest,
    recordActivity,
    recordTransactionChange,
    getSnapshot,
    isStaticOrNoisePath
};
