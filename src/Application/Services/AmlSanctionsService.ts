import logger from '../../../utils/logger';

export interface IScreeningResult {
    passed: boolean;
    hitLists: string[];
    riskLevel: 'low' | 'medium' | 'high';
    source: 'DEMO_STUB' | 'LIVE_PROVIDER';
}

export interface ISanctionsProvider {
    screenName(fullName: string): Promise<string[]>;
    screenCountry(country: string): Promise<string[]>;
}

/**
 * DEMO-ONLY local denylist. This is not OFAC, UN, or EU data and must not be
 * described as a live sanctions feed. Wire a licensed provider behind
 * ISanctionsProvider before claiming production AML coverage.
 */
class DemoSanctionsProvider implements ISanctionsProvider {
    readonly source = 'DEMO_STUB' as const;

    private sanctionedNames = new Set([
        'john doe criminal',
        'osama bin malik',
        'terrorist name example',
        'ali badr'
    ]);

    private sanctionedCountries = new Set([
        'north korea',
        'iran',
        'syria',
        'crimea'
    ]);

    async screenName(fullName: string): Promise<string[]> {
        if (this.sanctionedNames.has(fullName.trim().toLowerCase())) {
            return ['DEMO denylist (not a live OFAC/UN/EU feed)'];
        }
        return [];
    }

    async screenCountry(country: string): Promise<string[]> {
        if (this.sanctionedCountries.has(country.trim().toLowerCase())) {
            return ['DEMO embargo denylist (not a live OFAC/UN/EU feed)'];
        }
        return [];
    }
}

export class AmlSanctionsService {
    constructor(private readonly provider: ISanctionsProvider = new DemoSanctionsProvider()) {}

    public async screenSanctions(fullName: string, country: string): Promise<IScreeningResult> {
        const hitLists = [
            ...(await this.provider.screenName(fullName)),
            ...(await this.provider.screenCountry(country))
        ];
        const passed = hitLists.length === 0;

        if (!passed) {
            logger.warn(`DEMO AML/Sanctions stub hit for name: "${fullName}", country: "${country}"`, {
                hitLists,
                source: 'DEMO_STUB'
            });
        }

        return {
            passed,
            hitLists,
            riskLevel: passed ? 'low' : 'high',
            source: 'DEMO_STUB'
        };
    }

    public async checkAmlRules(amount: number, currency: string, historyTotalAmount: number): Promise<{ passed: boolean; reason?: string; source: 'DEMO_STUB' }> {
        const limitInEgp = 250000;
        let egpEquivalent = amount;

        if (currency === 'USD') egpEquivalent = amount * 47.5;
        else if (currency === 'EUR') egpEquivalent = amount * 51.2;

        if (egpEquivalent > limitInEgp) {
            logger.warn(`DEMO AML stub: large transaction flagged: ${amount} ${currency}`);
            return {
                passed: false,
                reason: 'SUSPICIOUS_TRANSACTION_LIMIT_EXCEEDED',
                source: 'DEMO_STUB'
            };
        }

        if (historyTotalAmount > 1000000) {
            return {
                passed: false,
                reason: 'ACCUMULATED_VOLUME_LIMIT_EXCEEDED',
                source: 'DEMO_STUB'
            };
        }

        return { passed: true, source: 'DEMO_STUB' };
    }
}

export const amlSanctionsService = new AmlSanctionsService();
