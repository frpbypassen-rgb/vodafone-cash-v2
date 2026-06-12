import logger from '../../../utils/logger';
import User from '../../Domain/Entities/User';
import Transaction from '../../Domain/Entities/Transaction';

export interface IFraudCheckResult {
    isFraudulent: boolean;
    reason?: string;
    riskScore: number;
}

export class FraudDetectionEngine {
    // تتبع أوقات المعاملات الأخيرة لكل مستخدم في الذاكرة لتطبيق Rate Limiting للمدفوعات
    private userTxTimestamps: Map<string, number[]> = new Map();

    private MAX_TX_PER_MINUTE = 50;

    /**
     * التحقق من سلامة المعاملة الحالية والتأكد من خلوها من الاحتيال
     */
    public async evaluateTransaction(userId: string, amount: number, isTrustedDevice: boolean): Promise<IFraudCheckResult> {
        const now = Date.now();
        const oneMinuteAgo = now - 60 * 1000;

        // 1. تتبع المعاملات في آخر دقيقة
        if (!this.userTxTimestamps.has(userId)) {
            this.userTxTimestamps.set(userId, []);
        }

        const timestamps = this.userTxTimestamps.get(userId)!;
        // تنظيف الطوابع القديمة (الأقدم من دقيقة)
        const activeTimestamps = timestamps.filter(ts => ts > oneMinuteAgo);
        activeTimestamps.push(now);
        this.userTxTimestamps.set(userId, activeTimestamps);

        // 2. الكشف عن هجمات الإغراق المالي (Velocity Check)
        if (activeTimestamps.length > this.MAX_TX_PER_MINUTE) {
            logger.warn(`Fraud Alert: User ${userId} exceeded transaction speed limits! Freezing account...`, {
                count: activeTimestamps.length
            });

            // تجميد الحساب تلقائياً للحماية من الاختراق
            await User.updateOne({ phone: userId }, { $set: { status: 'suspended' } });
            
            return {
                isFraudulent: true,
                reason: 'VELOCITY_LIMIT_EXCEEDED',
                riskScore: 100
            };
        }

        // 3. حساب درجة المخاطر (Risk Scoring)
        let riskScore = 10; // درجة المخاطر الأساسية

        // إذا كان الجهاز غير موثوق، ارفع نسبة المخاطر
        if (!isTrustedDevice) {
            riskScore += 30;
        }

        // الحوالات بمبالغ ضخمة جداً تزيد المخاطر
        if (amount > 50000) {
            riskScore += 25;
        } else if (amount > 10000) {
            riskScore += 10;
        }

        // التحقق من نسبة نجاح الحوالات التاريخية للمستخدم
        try {
            const totalCount = await Transaction.countDocuments({ userId });
            if (totalCount > 10) {
                const failedCount = await Transaction.countDocuments({ userId, status: 'rejected' });
                const failureRate = failedCount / totalCount;
                // إذا كان معدل الفشل يتخطى 30%، ارفع نسبة المخاطر
                if (failureRate > 0.3) {
                    riskScore += 20;
                }
            }
        } catch (_dbError) {
            // تجاهل خطأ قراءة الداتابيز واستمر
        }

        const isFraudulent = riskScore >= 80;

        return {
            isFraudulent,
            reason: isFraudulent ? 'HIGH_RISK_SCORE' : undefined,
            riskScore: Math.min(riskScore, 100)
        };
    }

    /**
     * إعادة حساب تصنيف المخاطر الشامل للمستخدم (من 0 إلى 100)
     */
    public async calculateUserRiskScore(userId: string): Promise<number> {
        let score = 20;

        const user = await User.findOne({ phone: userId });
        if (!user) return 100; // مستخدم غير معروف = أقصى خطورة

        if (user.status !== 'active') {
            score += 40;
        }

        if (user.creditLimit > 10000) {
            score += 15;
        }

        return Math.min(score, 100);
    }
}

export const fraudDetectionEngine = new FraudDetectionEngine();
