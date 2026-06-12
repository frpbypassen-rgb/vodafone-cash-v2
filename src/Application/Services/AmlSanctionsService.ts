import logger from '../../../utils/logger';

export interface IScreeningResult {
    passed: boolean;
    hitLists: string[];
    riskLevel: 'low' | 'medium' | 'high';
}

export class AmlSanctionsService {
    // محاكاة لقوائم الحظر والعقوبات الدولية المشبوهة لمنع الربط المكلف أثناء بيئات التجريب
    private sanctionedNames: Set<string> = new Set([
        'john doe criminal',
        'osama bin malik',
        'terrorist name example',
        'ali badr'
    ]);

    private sanctionedCountries: Set<string> = new Set([
        'north korea',
        'iran',
        'syria',
        'crimea'
    ]);

    /**
     * فحص اسم العميل وموقع التحويل ضد قوائم العقوبات الدولية (OFAC, UN, EU)
     */
    public async screenSanctions(fullName: string, country: string): Promise<IScreeningResult> {
        const cleanName = fullName.trim().toLowerCase();
        const cleanCountry = country.trim().toLowerCase();
        const hitLists: string[] = [];

        // 1. فحص قوائم الحظر بالاسم
        if (this.sanctionedNames.has(cleanName)) {
            hitLists.push('OFAC Specially Designated Nationals (SDN)');
        }

        // 2. فحص الدول الخاضعة للعقوبات الشاملة
        if (this.sanctionedCountries.has(cleanCountry)) {
            hitLists.push('EU Sanctioned Jurisdictions');
            hitLists.push('UN Embargo List');
        }

        const passed = hitLists.length === 0;

        if (!passed) {
            logger.warn(`Security Warning: AML/Sanctions hit detected for name: "${fullName}", country: "${country}"`, {
                hitLists
            });
        }

        return {
            passed,
            hitLists,
            riskLevel: passed ? 'low' : 'high'
        };
    }

    /**
     * مراقبة العمليات المالية ومكافحة غسيل الأموال (AML Check)
     */
    public async checkAmlRules(amount: number, currency: string, historyTotalAmount: number): Promise<{ passed: boolean; reason?: string }> {
        // القاعدة 1: تحويلات بمبالغ نقدية ضخمة مفاجئة تتطلب مراجعة (مثال: أكثر من 250,000 جنيه مصري)
        const limitInEgp = 250000;
        let egpEquivalent = amount;

        if (currency === 'USD') egpEquivalent = amount * 47.5;
        else if (currency === 'EUR') egpEquivalent = amount * 51.2;

        if (egpEquivalent > limitInEgp) {
            logger.warn(`AML Flag: Abnormally large transaction detected: ${amount} ${currency}`);
            return {
                passed: false,
                reason: 'SUSPICIOUS_TRANSACTION_LIMIT_EXCEEDED'
            };
        }

        // القاعدة 2: الحجم الكلي للمعاملات اليومية يتجاوز الحد المسموح به دون كشف هوية متقدم
        if (historyTotalAmount > 1000000) {
            return {
                passed: false,
                reason: 'ACCUMULATED_VOLUME_LIMIT_EXCEEDED'
            };
        }

        return { passed: true };
    }
}

export const amlSanctionsService = new AmlSanctionsService();
