import logger from '../../../utils/logger';
import FxRate from '../../Domain/Entities/FxRate';

export class FxEngine {
    private rates: Map<string, number> = new Map([
        ['USD_EGP', 47.50],
        ['EUR_EGP', 51.20],
        ['SAR_EGP', 12.65],
        ['AED_EGP', 12.93],
        ['LYD_EGP', 9.80],
        ['EGP_EGP', 1.00]
    ]);

    /**
     * تحميل جميع أسعار الصرف من قاعدة البيانات لتحديث الذاكرة المؤقتة
     */
    public async loadRatesFromDb(): Promise<void> {
        try {
            const dbRates = await FxRate.find({});
            for (const r of dbRates) {
                this.rates.set(r.pair, r.rate);
            }
            logger.info('FX Engine loaded rates from database successfully');
        } catch (err: any) {
            logger.error('Failed to load FX rates from database, using in-memory defaults', { error: err.message });
        }
    }

    /**
     * الحصول على سعر الصرف لزوج عملات معين
     */
    public getRate(from: string, to: string): number {
        if (from === to) return 1.0;
        
        const pair = `${from}_${to}`;
        if (this.rates.has(pair)) {
            return this.rates.get(pair)!;
        }

        // محاولة العثور على السعر العكسي
        const reversePair = `${to}_${from}`;
        if (this.rates.has(reversePair)) {
            return 1.0 / this.rates.get(reversePair)!;
        }

        // إذا كانت العملات غير الجنيه المصري، استخدم الجنيه المصري كوسيط
        if (from !== 'EGP' && to !== 'EGP') {
            const fromToEgp = this.getRate(from, 'EGP');
            const egpToTo = this.getRate('EGP', to);
            return fromToEgp * egpToTo;
        }

        logger.warn(`FX rate not found for ${from} to ${to}, falling back to 1.0`);
        return 1.0;
    }

    /**
     * تحويل مبلغ من عملة لأخرى
     */
    public convert(amount: number, from: string, to: string): number {
        const rate = this.getRate(from, to);
        const result = amount * rate;
        return Number(result.toFixed(4));
    }

    /**
     * تحديث سعر الصرف لزوج عملات يدوياً
     */
    public updateRate(from: string, to: string, rate: number): void {
        if (rate <= 0) throw new Error('Exchange rate must be positive');
        const pair = `${from}_${to}`;
        this.rates.set(pair, rate);
        logger.info(`FX Engine updated rate for ${pair} to ${rate}`);

        // حفظ التحديث في قاعدة البيانات بشكل غير متزامن
        FxRate.findOneAndUpdate(
            { pair },
            { fromCurrency: from, toCurrency: to, rate },
            { upsert: true, new: true }
        ).catch(err => {
            logger.error(`Failed to save FX rate update to DB for ${pair}`, { error: err.message });
        });
    }
}

export const fxEngine = new FxEngine();
