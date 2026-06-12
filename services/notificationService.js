// تم استبدال آلية الإشعارات الخارجية بآلية الإشعارات الداخلية عبر الموقع/التطبيق
const Notification = require('../models/Notification'); // موديل الإشعارات الموجود لديك

/**
 * خدمة الإشعارات المعزولة (Decoupled Notification Service)
 * تضمن عدم توقف النظام أو انهياره.
 */
class NotificationService {
    
    // إرسال رسالة نصية آمنة
    static async sendSafeMessage(token, userId, message, markup = { parse_mode: 'HTML' }) {
        if (!userId) return null;
        
        try {
            // 🟢 حفظ الإشعار في قاعدة البيانات ليراه المستخدم في الموقع أو التطبيق
            try {
                await Notification.create({
                    userId: userId,
                    title: 'إشعار نظام',
                    message: message.replace(/<[^>]*>?/gm, ''), // إزالة كود الـ HTML
                    type: 'system_alert'
                });
            } catch (dbError) {}
            
            return null; // نرجع null بدلاً من أن ينهار التطبيق
        } catch (error) {
            return null;
        }
    }

    // إرسال صورة آمنة
    static async sendSafePhoto(token, userId, photoData, options = { parse_mode: 'HTML' }) {
        if (!userId || !photoData) return null;

        try {
            // 🟢 محاولة إرسال النص فقط (حفظ كإشعار).
            if (options.caption) {
                return await this.sendSafeMessage(token, userId, `🖼️ (مرفق صورة)\n\n${options.caption}`, { parse_mode: options.parse_mode });
            }
            return null;
        } catch (error) {
            console.error(`⚠️ فشل تسجيل إشعار الصورة لـ ${userId}: ${error.message}`);
            return null;
        }
    }
}

module.exports = NotificationService;