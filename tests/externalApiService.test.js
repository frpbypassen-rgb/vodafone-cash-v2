'use strict';

jest.mock('axios', () => ({
    post: jest.fn()
}));

const axios = require('axios');
const { executeTransferViaApi, getApiProviderBalance } = require('../services/externalApiService');

describe('externalApiService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.ZAYN_USERNAME;
        delete process.env.ZAYN_PASSWORD;
        delete process.env.ZAYNPAY_USERNAME;
        delete process.env.ZAYNPAY_PASSWORD;
        delete process.env.ZAYN_API_TOKEN;
        delete process.env.ZAYNPAY_API_TOKEN;
    });

    const mockSuccessFlow = () => {
        axios.post
            .mockResolvedValueOnce({
                data: {
                    Code: 200,
                    Data: { Access_Token: 'token-123' }
                }
            })
            .mockResolvedValueOnce({
                data: {
                    Code: 200,
                    Data: { PaymentBillInfo: 'payment-bill-info' }
                }
            })
            .mockResolvedValueOnce({
                data: {
                    Code: 200,
                    Message: 'عمليه ناجحه',
                    Data: {
                        TransactionNumber: '50011611',
                        RefTransactionNumber: '28059087',
                        Amount: 5,
                        BalanceBefore: 100,
                        BalanceAfter: 95,
                        Status: 'عمليه ناجحه'
                    }
                }
            });
    };

    test('uses Zayn External Aggregator payload from provider preset', async () => {
        mockSuccessFlow();

        const result = await executeTransferViaApi(
            { customId: 'ATT-2608-0001', vodafoneNumber: '01271870153', amount: 5 },
            {
                apiProviderKey: 'zayn_external_aggregator',
                apiUrl: 'https://zayn.example/',
                apiUsername: 'api-user',
                apiPassword: 'api-pass'
            }
        );

        expect(result.success).toBe(true);
        expect(result.external_transaction_id).toBe('50011611');
        expect(result.reference_number).toBe('28059087');
        expect(result.sender_number).toBe('28059087');

        expect(axios.post).toHaveBeenNthCalledWith(
            1,
            'https://zayn.example/api/Account/GetToken',
            expect.objectContaining({
                UserName: 'api-user',
                Password: 'api-pass',
                AppType: '1',
                AppId: 'app12',
                VersionID: 'Samsuang-502'
            }),
            expect.objectContaining({ timeout: 15000 })
        );

        expect(axios.post).toHaveBeenNthCalledWith(
            2,
            'https://zayn.example/api/V1/Transactions/Inquiry',
            {
                Fields: [{ Id: 5488, Value: '01271870153' }],
                CurrentServiceProviderId: 16,
                ServiceId: 85,
                MachineSerial: 'XP1',
                InqueryAmount: 5
            },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
                timeout: 20000
            })
        );

        expect(axios.post).toHaveBeenNthCalledWith(
            3,
            'https://zayn.example/api/V1/Transactions/Payment',
            {
                Fields: [{ Id: 5488, Value: '01271870153' }],
                CurrentServiceProviderId: 16,
                ServiceId: 85,
                PaymentBillInfo: 'payment-bill-info',
                Amount: 5,
                MachineSerial: 'XP1'
            },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
                timeout: 180000
            })
        );
    });

    test('allows executor-specific provider ids to override the preset', async () => {
        mockSuccessFlow();

        await executeTransferViaApi(
            { customId: 'ATT-2608-0002', accountNumber: '01000000000', amount: 10 },
            {
                apiUrl: 'zayn.example',
                apiUsername: 'api-user',
                apiPassword: 'api-pass',
                apiServiceId: 99,
                apiProviderId: 88,
                apiFieldId: 77,
                apiMachineSerial: 'SER-1'
            }
        );

        expect(axios.post).toHaveBeenNthCalledWith(
            2,
            'https://zayn.example/api/V1/Transactions/Inquiry',
            expect.objectContaining({
                Fields: [{ Id: 77, Value: '01000000000' }],
                CurrentServiceProviderId: 88,
                ServiceId: 99,
                MachineSerial: 'SER-1',
                InqueryAmount: 10
            }),
            expect.any(Object)
        );
    });

    test('checks provider balance through GetBalance', async () => {
        axios.post
            .mockResolvedValueOnce({
                data: {
                    Code: 200,
                    Data: { Access_Token: 'token-456' }
                }
            })
            .mockResolvedValueOnce({
                data: {
                    Code: 200,
                    Message: 'عمليه ناجحه',
                    Data: {
                        ServiceCredit: 23,
                        CashCredit: 7
                    }
                }
            });

        const result = await getApiProviderBalance({
            apiProviderKey: 'zayn_external_aggregator',
            apiUrl: 'https://zayn.example/',
            apiUsername: 'api-user',
            apiPassword: 'api-pass'
        });

        expect(result.success).toBe(true);
        expect(result.serviceCredit).toBe(23);
        expect(result.cashCredit).toBe(7);
        expect(result.availableBalance).toBe(30);

        expect(axios.post).toHaveBeenNthCalledWith(
            2,
            'https://zayn.example/api/Account/GetBalance',
            {},
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token-456' }),
                timeout: 20000
            })
        );
    });
});
