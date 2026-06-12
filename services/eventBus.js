// services/eventBus.js
// ===============================================
// 🔄 باص الأحداث — Event Driven Architecture
// ===============================================
'use strict';

const EventEmitter = require('events');
const logger = require('../utils/logger');

class FinancialEventBus extends EventEmitter {
    constructor() {
        super();
        this.on('error', (err) => {
            logger.error('🚨 [EventBus Error]:', { error: err.message });
        });
    }

    /**
     * نشر حدث مالي
     * @param {string} eventName - اسم الحدث (مثال: transfer:created)
     * @param {Object} data - البيانات المصاحبة للحدث
     */
    publish(eventName, data) {
        logger.info(`📢 [EventBus] Publishing event: ${eventName}`, { data });
        this.emit(eventName, data);
    }
}

// تصدير نسخة فريدة (Singleton) لضمان اشتراك موحد في كافة أرجاء النظام
const eventBus = new FinancialEventBus();

// ── تسحيل المستمعين الافتراضيين لفك الارتباط (Decoupling) ──

// 1. عند إنشاء تحويل مالي
eventBus.on('transfer:created', async (data) => {
    try {
        const { tx, companyName, employeeName } = data;
        logger.financial('Transfer Created Event Received', { customId: tx.customId, amount: tx.amount });
        
        // إشعار المديرين والعملاء بالطلب الخلفي (BullMQ)
        const { addNotificationJob } = require('./bullQueueService');
        const adminMsg = `🔔 طلب تحويل جديد!\n\n🏢 العميل: ${companyName}\n👤 المنشئ: ${employeeName}\n📞 الرقم: ${tx.vodafoneNumber}\n💵 المبلغ: ${tx.amount} EGP\n🔢 كود: ${tx.customId}`;
        
        // إرسال للإدارة
        const Admin = require('../models/Admin');
        const admins = await Admin.find({}).lean();
        for (const admin of admins) {
            await addNotificationJob(admin.webUsername || 'admin', 'طلب تحويل جديد', adminMsg, 'transfer');
        }
    } catch (err) {
        logger.error('Failed to handle transfer:created event', { error: err.message });
    }
});

// 2. عند إتمام تحويل مالي
eventBus.on('transfer:completed', async (data) => {
    try {
        const { tx, emp } = data;
        logger.financial('Transfer Completed Event Received', { customId: tx.customId, status: tx.status });
        
        const { addNotificationJob } = require('./bullQueueService');
        const msg = `✅ تم إتمام الحوالة رقم ${tx.customId} بقيمة ${tx.amount} EGP بنجاح عبر المنفذ ${emp.name}`;
        
        // إشعار المستخدم أو الشركة المنشئة للعملية
        if (tx.userId) {
            await addNotificationJob(tx.userId, 'تم إتمام الحوالة بنجاح', msg, 'transfer_complete');
        }
    } catch (err) {
        logger.error('Failed to handle transfer:completed event', { error: err.message });
    }
});

// 3. عند إلغاء تحويل مالي
eventBus.on('transfer:cancelled', async (data) => {
    try {
        const { tx, emp, reason } = data;
        logger.financial('Transfer Cancelled Event Received', { customId: tx.customId, refund: tx.costLYD });

        const { addNotificationJob } = require('./bullQueueService');
        const msg = `❌ تم إلغاء الحوالة رقم ${tx.customId} وإرجاع القيمة ${tx.costLYD} LYD لرصيدك. السبب: ${reason}`;
        
        if (tx.userId) {
            await addNotificationJob(tx.userId, 'إلغاء التحويل وإرجاع الرصيد', msg, 'transfer_cancelled');
        }
    } catch (err) {
        logger.error('Failed to handle transfer:cancelled event', { error: err.message });
    }
});

module.exports = eventBus;
