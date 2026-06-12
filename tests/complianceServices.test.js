'use strict';

const { kycService } = require('../src/Application/Services/KycService');
const { amlSanctionsService } = require('../src/Application/Services/AmlSanctionsService');

describe('Compliance Services Tests', () => {
    describe('KYC Service', () => {
        test('Should submit document and retrieve status successfully', async () => {
            const userId = 'user-kyc-123';
            const submitRes = await kycService.submitDocument(userId, {
                documentType: 'passport',
                fileUrl: 'http://example.com/passport.jpg',
                fullName: 'Ahmed Ali'
            });

            expect(submitRes.success).toBe(true);
            expect(submitRes.message).toBe('تم تقديم مستند الهوية بنجاح وهو قيد المراجعة');

            const statusRes = await kycService.getKycStatus(userId);
            expect(statusRes.status).toBe('pending');
        });

        test('Should update KYC verification status successfully', async () => {
            const userId = 'user-kyc-123';
            await kycService.updateKycStatus(userId, 'verified');

            const statusRes = await kycService.getKycStatus(userId);
            expect(statusRes.status).toBe('verified');
            expect(statusRes.verificationDate).toBeDefined();
        });
    });

    describe('AML and Sanctions Screening Service', () => {
        test('Should screen sanctioned names and return high risk / failed status', async () => {
            const res = await amlSanctionsService.screenSanctions('Osama Bin Malik', 'Egypt');
            expect(res.passed).toBe(false);
            expect(res.riskLevel).toBe('high');
            expect(res.hitLists).toContain('OFAC Specially Designated Nationals (SDN)');
        });

        test('Should screen sanctioned countries and return high risk', async () => {
            const res = await amlSanctionsService.screenSanctions('Normal Name', 'North Korea');
            expect(res.passed).toBe(false);
            expect(res.riskLevel).toBe('high');
            expect(res.hitLists).toContain('UN Embargo List');
        });

        test('Should pass screening for normal user and country', async () => {
            const res = await amlSanctionsService.screenSanctions('Mohamed Ali', 'Egypt');
            expect(res.passed).toBe(true);
            expect(res.riskLevel).toBe('low');
        });

        test('Should detect suspicious amount under AML rules', async () => {
            const ruleCheck = await amlSanctionsService.checkAmlRules(300000, 'EGP', 0);
            expect(ruleCheck.passed).toBe(false);
            expect(ruleCheck.reason).toBe('SUSPICIOUS_TRANSACTION_LIMIT_EXCEEDED');
        });

        test('Should pass AML rules for small amounts', async () => {
            const ruleCheck = await amlSanctionsService.checkAmlRules(1000, 'EGP', 10000);
            expect(ruleCheck.passed).toBe(true);
        });
    });
});
