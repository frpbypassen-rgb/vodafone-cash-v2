const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const ClientCompany = require('../models/ClientCompany');

/**
 * خدمة إرسال إشعارات Webhook للشركات عند تغير حالة المعاملات
 */
class WebhookNotificationService {
    /**
     * إرسال إشعار Webhook لشركة معينة
     * @param {string} companyId - معرف الشركة
     * @param {object} payload - بيانات الإشعار
     * @param {string} eventType - نوع الحدث (transaction.completed, transaction.failed, etc.)
     */
    async sendNotification(companyId, payload, eventType) {
        try {
            const company = await ClientCompany.findById(companyId);
            
            if (!company || !company.webhookEnabled || !company.webhookUrl) {
                return { success: false, reason: 'Webhook not configured for this company' };
            }

            const timestamp = Date.now();
            const signature = this._generateSignature(payload, company.webhookSecret, timestamp);

            const config = {
                method: 'post',
                url: company.webhookUrl,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Signature': signature,
                    'X-Webhook-Timestamp': timestamp,
                    'X-Webhook-Event': eventType
                },
                data: payload,
                timeout: 10000 // 10 seconds timeout
            };

            const response = await axios(config);
            
            logger.info('Webhook notification sent successfully', {
                companyId,
                eventType,
                statusCode: response.status
            });

            return { success: true, statusCode: response.status };
        } catch (error) {
            logger.error('Webhook notification failed', {
                companyId,
                eventType,
                error: error.message,
                code: error.code
            });

            // هنا يمكن إضافة منطق إعادة المحاولة لاحقاً
            return { 
                success: false, 
                error: error.message,
                shouldRetry: this._shouldRetry(error)
            };
        }
    }

    /**
     * توليد توقيع HMAC للتحقق من صحة الطلب
     */
    _generateSignature(payload, secret, timestamp) {
        const payloadString = JSON.stringify(payload) + timestamp;
        return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
    }

    /**
     * تحديد ما إذا كان يجب إعادة المحاولة بناءً على نوع الخطأ
     */
    _shouldRetry(error) {
        const retryableCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'];
        const retryableStatuses = [429, 500, 502, 503, 504];
        
        if (error.code && retryableCodes.includes(error.code)) {
            return true;
        }
        
        if (error.response && retryableStatuses.includes(error.response.status)) {
            return true;
        }
        
        return false;
    }

    /**
     * التحقق من صحة توقيع Webhook وارد
     */
    verifySignature(payload, signature, secret, timestamp) {
        const expectedSignature = this._generateSignature(payload, secret, timestamp);
        return crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'),
            Buffer.from(expectedSignature, 'hex')
        );
    }
}

module.exports = new WebhookNotificationService();
