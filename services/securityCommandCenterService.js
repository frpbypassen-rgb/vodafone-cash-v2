'use strict';

const AuditLog = require('../models/AuditLog');
const SecurityDevice = require('../models/SecurityDevice');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const Employee = require('../models/Employee');
const AgentEmployee = require('../models/AgentEmployee');
const SubAccount = require('../models/SubAccount');

const ONLINE_WINDOW_MINUTES = 10;

const TYPE_LABELS = Object.freeze({
    master_admin: 'مدير رئيسي',
    admin: 'إدارة',
    executor: 'منفذ',
    client_user: 'عميل',
    client_company: 'شركة',
    agent_staff: 'موظف وكيل',
    sub_client: 'عميل فرعي'
});

const ACTION_LABELS = Object.freeze({
    LOGIN_SUCCESS: 'تسجيل دخول',
    LOGIN_FAILED: 'محاولة دخول فاشلة',
    LOGOUT: 'تسجيل خروج',
    TRANSFER_CREATED: 'تحويل جديد',
    TRANSFER_COMPLETED: 'اكتمال تحويل',
    TRANSFER_CANCELLED: 'إلغاء تحويل',
    TRANSACTION_RATE_EDITED: 'تعديل سعر عملية',
    TRANSACTION_DATA_EDITED: 'تعديل بيانات عملية',
    TRANSACTION_CANCELLED_BY_ADMIN: 'إلغاء عملية من الإدارة',
    TRANSACTION_EXECUTOR_CHANGED: 'تغيير منفذ العملية',
    SECURITY_DEVICE_REVOKED: 'إلغاء جهاز',
    SECURITY_DEVICE_REVOKED_BY_OWNER: 'إلغاء جهاز بواسطة صاحبه',
    SECURITY_DEVICE_TRANSFER_APPROVED: 'اعتماد نقل جهاز',
    SECURITY_DEVICE_TRANSFER_REJECTED: 'رفض نقل جهاز',
    SECURITY_PASSKEY_REGISTERED: 'تسجيل مفتاح مرور',
    SECURITY_POLICY_UPDATED: 'تحديث سياسة الأمان',
    SECURITY_OPERATION_PIN_RESET: 'إعادة ضبط رمز العمليات'
});

const safeText = (value, fallback = '') => String(value ?? fallback).slice(0, 500);
const keyFor = (type, id) => `${safeText(type)}:${safeText(id)}`;
const startOfToday = (now) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

const mapLinkFor = (location) => {
    const latitude = Number(location?.latitude);
    const longitude = Number(location?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
    return `https://www.google.com/maps?q=${latitude},${longitude}`;
};

const channelLabel = (channels) => {
    const values = new Set(channels || []);
    if (values.has('web') && values.has('app')) return 'الموقع والتطبيق';
    if (values.has('app')) return 'التطبيق';
    if (values.has('web')) return 'الموقع';
    return 'لم يسجل دخولًا بعد';
};

const deviceLabel = (types) => {
    const values = new Set(types || []);
    const hasPhone = values.has('phone') || values.has('tablet');
    const hasComputer = values.has('computer');
    if (hasPhone && hasComputer) return 'هاتف وكمبيوتر';
    if (hasPhone) return 'هاتف';
    if (hasComputer) return 'كمبيوتر';
    return 'غير محدد';
};

const activityTone = (log) => {
    if (!log.success || log.result === 'فاشل' || log.result === 'محظور' || log.severity === 'critical') return 'danger';
    if (log.severity === 'warning' || /CANCELLED|FAILED|REJECTED|REVOKED/.test(log.action || '')) return 'warning';
    if (/TRANSFER_COMPLETED|LOGIN_SUCCESS/.test(log.action || '')) return 'success';
    return 'info';
};

const stripSensitive = (value, depth = 0) => {
    if (depth > 3 || value == null) return value == null ? null : '[بيانات مختصرة]';
    if (Array.isArray(value)) return value.slice(0, 12).map((item) => stripSensitive(item, depth + 1));
    if (typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 500) : value;
    const blocked = /password|secret|token|hash|credential|cookie|authorization|otp|pin/i;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !blocked.test(key))
        .slice(0, 30)
        .map(([key, item]) => [key, stripSensitive(item, depth + 1)]));
};

const formatActivity = (log) => ({
    id: safeText(log._id),
    action: safeText(log.action),
    label: ACTION_LABELS[log.action] || safeText(log.action).replaceAll('_', ' '),
    actor: safeText(log.performedByName, 'حساب غير معروف'),
    actorType: safeText(log.performedByModel, 'حساب'),
    result: safeText(log.result, log.success === false ? 'فاشل' : 'ناجح'),
    initiator: safeText(log.initiator, 'موقع'),
    deviceType: safeText(log.deviceType, 'كمبيوتر'),
    ipAddress: safeText(log.ipAddress, '-'),
    createdAt: log.createdAt,
    tone: activityTone(log),
    mapUrl: mapLinkFor(log.location),
    details: stripSensitive({
        action: log.action,
        result: log.result,
        endpoint: log.endpoint,
        errorCode: log.errorCode,
        targetModel: log.targetModel,
        targetId: log.targetId,
        metadata: log.metadata,
        oldData: log.oldData,
        newData: log.newData
    })
});

const buildDeviceMap = (devices) => {
    const map = new Map();
    for (const device of devices) {
        const key = keyFor(device.principalType, device.principalId);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(device);
    }
    return map;
};

const accountRow = ({ id, principalType, name, category, status, devicesByAccount }) => {
    const devices = devicesByAccount.get(keyFor(principalType, id)) || [];
    return {
        id: safeText(id), principalType, name: safeText(name, 'حساب بلا اسم'), category,
        status: safeText(status, 'active'), channel: channelLabel(devices.map((item) => item.channel)),
        device: deviceLabel(devices.map((item) => item.deviceType)),
        lastSeenAt: devices.reduce((latest, item) => !latest || item.lastSeenAt > latest ? item.lastSeenAt : latest, null)
    };
};

const buildCommandCenter = async ({ now = new Date() } = {}) => {
    const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MINUTES * 60 * 1000);
    const today = startOfToday(now);
    const [devices, logs, users, companyStaff, executors, agentStaff, subAccounts] = await Promise.all([
        SecurityDevice.find().sort({ lastSeenAt: -1 }).limit(500).lean(),
        AuditLog.find().sort({ createdAt: -1 }).limit(150).lean(),
        User.find({ deletedAt: { $exists: false } }).select('name role status').sort({ name: 1 }).limit(1000).lean(),
        ClientEmployee.find({ deletedAt: { $exists: false } }).select('name status companyId').populate('companyId', 'name').sort({ name: 1 }).limit(1000).lean(),
        Employee.find({ archivedAt: null }).select('name status groupId').populate('groupId', 'name').sort({ name: 1 }).limit(1000).lean(),
        AgentEmployee.find({ deletedAt: { $exists: false } }).select('name status agentId').populate('agentId', 'name').sort({ name: 1 }).limit(1000).lean(),
        SubAccount.find({ deletedAt: { $exists: false } }).select('name status').sort({ name: 1 }).limit(1000).lean()
    ]);

    const devicesByAccount = buildDeviceMap(devices);
    const accounts = [
        ...users.map((item) => accountRow({ id: item._id, principalType: 'client_user', name: item.name, category: item.role === 'agent' ? 'وكيل' : 'عميل', status: item.status, devicesByAccount })),
        ...companyStaff.map((item) => accountRow({ id: item._id, principalType: 'client_company', name: item.companyId?.name ? `${item.companyId.name} — ${item.name}` : item.name, category: 'شركة', status: item.status, devicesByAccount })),
        ...executors.map((item) => accountRow({ id: item._id, principalType: 'executor', name: item.groupId?.name ? `${item.groupId.name} — ${item.name}` : item.name, category: 'منفذ', status: item.status, devicesByAccount })),
        ...agentStaff.map((item) => accountRow({ id: item._id, principalType: 'agent_staff', name: item.agentId?.name ? `${item.agentId.name} — ${item.name}` : item.name, category: 'وكيل', status: item.status, devicesByAccount })),
        ...subAccounts.map((item) => accountRow({ id: item._id, principalType: 'sub_client', name: item.name, category: 'عميل', status: item.status, devicesByAccount }))
    ];
    const names = new Map(accounts.map((item) => [keyFor(item.principalType, item.id), item.name]));
    const onlineDevices = devices.filter((item) => item.status === 'active' && item.lastSeenAt && new Date(item.lastSeenAt) >= onlineSince);
    const connectedDevices = onlineDevices.map((device) => ({
        ...device,
        accountName: names.get(keyFor(device.principalType, device.principalId)) || device.displayName || device.principalId,
        principalLabel: TYPE_LABELS[device.principalType] || device.principalType,
        deviceLabel: deviceLabel([device.deviceType]),
        channelLabel: channelLabel([device.channel]),
        mapUrl: mapLinkFor(device.lastLocation)
    }));
    const activities = logs.map(formatActivity);
    const todayLogs = logs.filter((log) => new Date(log.createdAt) >= today);
    const failedToday = todayLogs.filter((log) => log.success === false || /FAILED|REJECTED/.test(log.action || '')).length;
    const transfersToday = todayLogs.filter((log) => log.action === 'TRANSFER_CREATED').length;
    const criticalToday = todayLogs.filter((log) => log.severity === 'critical').length;
    const newDevicesToday = devices.filter((device) => new Date(device.createdAt) >= today).length;
    const alerts = [];
    if (failedToday) alerts.push({ tone: 'danger', title: `${failedToday} محاولة أو حركة فاشلة اليوم`, text: 'راجع سجل الحركة وحدد الحسابات أو عناوين الشبكة المتكررة.', tab: 'activity' });
    if (criticalToday) alerts.push({ tone: 'danger', title: `${criticalToday} حدث حرج اليوم`, text: 'تحتاج الأحداث الحرجة إلى مراجعة الإدارة.', tab: 'activity' });
    if (newDevicesToday) alerts.push({ tone: 'warning', title: `${newDevicesToday} جهاز جديد اليوم`, text: 'تحقق من الجهاز والموقع قبل اعتماد أي طلب دخول.', tab: 'devices' });
    if (!alerts.length) alerts.push({ tone: 'success', title: 'لا توجد تنبيهات حرجة اليوم', text: 'حركة الدخول والأجهزة ضمن الوضع الطبيعي حتى الآن.', tab: 'activity' });

    return {
        onlineWindowMinutes: ONLINE_WINDOW_MINUTES,
        connectedDevices,
        activities,
        accounts,
        alerts,
        stats: {
            onlineAccounts: new Set(onlineDevices.map((item) => keyFor(item.principalType, item.principalId))).size,
            onlineDevices: onlineDevices.length,
            transfersToday,
            failedToday,
            criticalToday,
            newDevicesToday
        }
    };
};

module.exports = {
    ONLINE_WINDOW_MINUTES,
    buildCommandCenter,
    channelLabel,
    deviceLabel,
    formatActivity,
    mapLinkFor,
    stripSensitive
};
