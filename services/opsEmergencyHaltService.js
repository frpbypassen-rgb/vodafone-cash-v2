'use strict';

const bcrypt = require('bcryptjs');
const Settings = require('../models/Settings');
const Admin = require('../models/Admin');
const { logAction } = require('./auditService');

const CONFIRM_PHRASE = 'إيقاف التحويلات';
const HALT_MESSAGE = 'تم إيقاف التحويلات الصادرة مؤقتاً من لوحة المراقبة الحية. لن تُنشأ تحويلات جديدة حتى يُرفع الإيقاف.';

const isMaster = (req) => req.session?.adminRole === 'master';

const parseHaltEnable = (value) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return null;
};

const getEmergencyHaltStatus = async () => {
    const settings = await Settings.findOne();
    return {
        active: Boolean(settings?.isManualClosed),
        at: settings?.opsHaltAt || null,
        by: settings?.opsHaltByName || '',
        reason: settings?.opsHaltReason || '',
        confirmPhrase: CONFIRM_PHRASE,
        blastRadius: 'new_outbound_transfers_only',
        note: 'يوقف إنشاء التحويلات الجديدة عبر isManualClosed. لا يلغي العمليات الجارية ولا يفعّل إغلاق الأمن الطارئ.'
    };
};

const setEmergencyHalt = async (req, { enable, confirmPhrase, password, reason } = {}) => {
    if (!isMaster(req)) {
        const error = new Error('إيقاف التحويلات متاح للمدير الأساسي فقط.');
        error.status = 403;
        throw error;
    }
    const wantOn = Boolean(enable);
    if (String(confirmPhrase || '').trim() !== CONFIRM_PHRASE) {
        const error = new Error(`أدخل عبارة التأكيد حرفياً: ${CONFIRM_PHRASE}`);
        error.status = 400;
        throw error;
    }
    if (!String(password || '').trim()) {
        const error = new Error('أعد إدخال كلمة مرور المدير لتأكيد الإجراء.');
        error.status = 400;
        throw error;
    }
    const admin = req.session.adminId
        ? await Admin.findById(req.session.adminId).select('webPassword name status')
        : null;
    if (!admin || admin.status === 'suspended') {
        const error = new Error('تعذر التحقق من حساب المدير.');
        error.status = 403;
        throw error;
    }
    const passwordOk = await bcrypt.compare(String(password), admin.webPassword);
    if (!passwordOk) {
        const error = new Error('كلمة المرور غير صحيحة.');
        error.status = 403;
        throw error;
    }

    const settings = await Settings.findOne() || new Settings();
    settings.isManualClosed = wantOn;
    settings.opsHaltAt = wantOn ? new Date() : null;
    settings.opsHaltByName = wantOn ? (req.session.adminName || admin.name) : '';
    settings.opsHaltReason = wantOn ? String(reason || 'إيقاف طارئ من المراقبة الحية').slice(0, 300) : '';
    if (wantOn && !settings.closedMessage) settings.closedMessage = HALT_MESSAGE;
    await settings.save();

    await logAction({
        action: wantOn ? 'OPS_EMERGENCY_HALT_ON' : 'OPS_EMERGENCY_HALT_OFF',
        req,
        performedById: req.session.adminId || null,
        performedByModel: 'Admin',
        performedByName: req.session.adminName || admin.name,
        metadata: {
            blastRadius: 'new_outbound_transfers_only',
            reason: settings.opsHaltReason
        },
        success: true,
        severity: 'critical',
        required: true
    });

    return getEmergencyHaltStatus();
};

module.exports = {
    CONFIRM_PHRASE,
    getEmergencyHaltStatus,
    isMaster,
    parseHaltEnable,
    setEmergencyHalt
};
