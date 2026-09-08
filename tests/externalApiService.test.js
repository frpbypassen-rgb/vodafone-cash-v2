'use strict';

jest.mock('axios', () => ({
    post: jest.fn()
}));

const axios = require('axios');
const {
    executeTransferViaApi,
    getApiProviderBalance,
    runApiTransferPreflight,
    getApiProviderTransactions,
    isReturnedProviderStatus
} = require('../services/externalApiService');

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

    test('uses documented Key/Value entries for the ZaynPay Legacy inquiry contract only', async () => {
        mockSuccessFlow();

        await executeTransferViaApi(
            { customId: 'ATT-2609-LEGACY', vodafoneNumber: '01108172258', amount: 5000 },
            {
                apiProviderKey: 'zaynpay_legacy',
                apiUrl: 'https://zayn.example',
                apiUsername: 'api-user',
                apiPassword: 'api-pass'
            }
        );

        expect(axios.post).toHaveBeenNthCalledWith(
            2,
            'https://zayn.example/api/V1/Transactions/Inquiry',
            {
                Fields: [
                    { Key: 'Key1', Value: '01108172258' },
                    { Key: 'Key2', Value: '5000' }
                ],
                CurrentServiceProviderId: 29,
                MachineSerial: 'XP1',
                ServiceId: '307'
            },
            expect.any(Object)
        );
        expect(axios.post).toHaveBeenNthCalledWith(
            3,
            'https://zayn.example/api/V1/Transactions/Payment',
            expect.objectContaining({
                Fields: [{ Id: 3488, Value: '01108172258' }],
                Amount: 5000
            }),
            expect.any(Object)
        );
    });

    test('uses the MogaPay authentication, inquiry, and payment contract', async () => {
        axios.post
            .mockResolvedValueOnce({ data: { Code: 200, Data: { Access_Token: 'moga-token' } } })
            .mockResolvedValueOnce({ data: { Code: 200, Data: { PaymentBillInfo: 'moga-bill-info' } } })
            .mockResolvedValueOnce({
                data: {
                    Code: 200,
                    Message: 'عمليه ناجحه',
                    Data: {
                        TransactionNumber: 'MOGA-5001',
                        ApprovalNumber: 'MOGA-APPROVAL-1',
                        IsPaid: 1,
                        IsFailure: 0,
                        Amount: 29
                    }
                }
            });

        const result = await executeTransferViaApi(
            { customId: 'ATT-MOGA-1', vodafoneNumber: '01271870153', amount: 29 },
            {
                apiProviderKey: 'mogapay',
                apiUrl: 'https://moga.example',
                apiUsername: 'moga-user',
                apiPassword: 'moga-password',
                apiServiceId: 64,
                apiServiceVersion: 0,
                apiFieldKey: 'Key1'
            }
        );

        expect(result.success).toBe(true);
        expect(result.reference_number).toBe('MOGA-APPROVAL-1');
        expect(axios.post).toHaveBeenNthCalledWith(
            1,
            'https://moga.example/api/Account/Authenticate',
            {
                UserName: 'moga-user',
                Password: 'moga-password',
                RememberMe: true,
                AppType: '1',
                AppId: 'app12'
            },
            expect.objectContaining({ headers: expect.objectContaining({ 'app-version': '45', AppId: 'app12' }) })
        );
        expect(axios.post).toHaveBeenNthCalledWith(
            2,
            'https://moga.example/api/V1/Transactions/Inquiry',
            {
                Fields: [{ Key: 'Key1', Value: '01271870153' }],
                ServiceId: 64,
                MachineSerial: 'XP1',
                InqueryAmount: 29,
                ServiceVersion: 0
            },
            expect.any(Object)
        );
        expect(axios.post).toHaveBeenNthCalledWith(
            3,
            'https://moga.example/api/V1/Transactions/Payment',
            {
                Fields: [{ Key: 'Key1', Value: '01271870153' }],
                ServiceId: 64,
                MachineSerial: 'XP1',
                ServiceVersion: 0,
                PaymentBillInfo: 'moga-bill-info',
                Amount: 29
            },
            expect.any(Object)
        );
    });

    test('rejects direct payment for MogaPay before any provider request', async () => {
        const result = await executeTransferViaApi(
            { vodafoneNumber: '01271870153', amount: 29 },
            {
                apiProviderKey: 'mogapay',
                apiUrl: 'https://moga.example',
                apiUsername: 'moga-user',
                apiPassword: 'moga-password',
                apiPaymentFlow: 'direct_payment'
            }
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('يتطلب الاستعلام');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('sends payment directly without an inquiry when direct mode is explicitly selected', async () => {
        axios.post
            .mockResolvedValueOnce({ data: { Code: 200, Data: { Access_Token: 'direct-token' } } })
            .mockResolvedValueOnce({
                data: {
                    Code: 200,
                    Data: { TransactionNumber: 'DIRECT-5001', RefTransactionNumber: 'REF-DIRECT', IsPaid: 1, Amount: 500 }
                }
            });

        const result = await executeTransferViaApi(
            { customId: 'ATT-DIRECT-1', vodafoneNumber: '01108172258', amount: 500 },
            {
                apiUrl: 'https://zayn.example', apiUsername: 'api-user', apiPassword: 'api-pass',
                apiPaymentFlow: 'direct_payment'
            }
        );

        expect(result.success).toBe(true);
        expect(axios.post).toHaveBeenCalledTimes(2);
        expect(axios.post).toHaveBeenNthCalledWith(
            2,
            'https://zayn.example/api/V1/Transactions/Payment',
            {
                Fields: [{ Id: 5488, Value: '01108172258' }],
                CurrentServiceProviderId: 16,
                ServiceId: 85,
                MachineSerial: 'XP1',
                Amount: 500
            },
            expect.any(Object)
        );
        expect(axios.post.mock.calls.some(([url]) => String(url).includes('/Transactions/Inquiry'))).toBe(false);
        expect(result.communication).toEqual(expect.arrayContaining([
            expect.objectContaining({ direction: 'outbound', stage: 'payment_request' }),
            expect.objectContaining({ direction: 'inbound', stage: 'payment_response' })
        ]));
        expect(result.processLog).toContain('PAYMENT_REQUEST_JSON');
        expect(result.processLog).toContain('PAYMENT_RESPONSE_JSON');
        expect(result.processLog).toContain('"Amount": 500');
        expect(result.processLog).toContain('INQUIRY_SKIPPED');
    });

    test('records the direct-payment provider error response for the operation log', async () => {
        axios.post
            .mockResolvedValueOnce({ data: { Code: 200, Data: { Access_Token: 'direct-token' } } })
            .mockRejectedValueOnce({
                config: { url: 'https://zayn.example/api/V1/Transactions/Payment' },
                response: { status: 503, data: { Code: 503, Message: 'Provider unavailable' } },
                message: 'Request failed with status code 503'
            });

        const result = await executeTransferViaApi(
            { vodafoneNumber: '01108172258', amount: 500 },
            { apiUrl: 'https://zayn.example', apiUsername: 'api-user', apiPassword: 'api-pass', apiPaymentFlow: 'direct_payment' }
        );

        expect(result.success).toBe(false);
        expect(result.communication).toEqual(expect.arrayContaining([
            expect.objectContaining({ direction: 'outbound', stage: 'payment_request' }),
            expect.objectContaining({ direction: 'inbound', stage: 'payment_error_response', httpStatus: 503, payload: { Code: 503, Message: 'Provider unavailable' } })
        ]));
        expect(result.processLog).toContain('PAYMENT_REQUEST_JSON');
        expect(result.processLog).toContain('PAYMENT_ERROR_RESPONSE_JSON');
        expect(result.processLog).toContain('"Message": "Provider unavailable"');
    });

    test('runs a safe transfer preflight through authentication, balance, and inquiry without payment', async () => {
        axios.post
            .mockResolvedValueOnce({
                data: { Code: 200, Data: { Access_Token: 'preflight-token' } }
            })
            .mockResolvedValueOnce({
                data: { Code: 200, Data: { ServiceCredit: 100, CashCredit: 20 } }
            })
            .mockResolvedValueOnce({
                data: { Code: 200, Data: { PaymentBillInfo: 'safe-inquiry-token' } }
            });

        const result = await runApiTransferPreflight({
            apiUrl: 'https://zayn.example',
            apiUsername: 'api-user',
            apiPassword: 'api-pass'
        }, {
            phone: '01271870153',
            amount: 5
        });

        expect(result).toMatchObject({
            success: true,
            stage: 'completed',
            availableBalance: 120,
            targetNumber: '01271870153',
            amount: 5
        });
        expect(result.checks.map((check) => check.status)).toEqual(['success', 'success', 'success', 'success']);
        expect(axios.post).toHaveBeenCalledTimes(3);
        expect(axios.post).toHaveBeenNthCalledWith(
            3,
            'https://zayn.example/api/V1/Transactions/Inquiry',
            {
                Fields: [{ Id: 5488, Value: '01271870153' }],
                CurrentServiceProviderId: 16,
                ServiceId: 85,
                MachineSerial: 'XP1',
                InqueryAmount: 5
            },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer preflight-token' }),
                timeout: 20000
            })
        );
        expect(axios.post.mock.calls.some(([url]) => String(url).includes('/Transactions/Payment'))).toBe(false);
    });

    test('reports the inquiry stage and provider message when safe transfer preflight fails', async () => {
        axios.post
            .mockResolvedValueOnce({
                data: { Code: 200, Data: { Access_Token: 'preflight-token' } }
            })
            .mockResolvedValueOnce({
                data: { Code: 200, Data: { ServiceCredit: 100, CashCredit: 0 } }
            })
            .mockResolvedValueOnce({
                data: { Code: 422, Message: 'Recipient is not available', Data: null }
            });

        const result = await runApiTransferPreflight({
            apiUrl: 'https://zayn.example',
            apiUsername: 'api-user',
            apiPassword: 'api-pass'
        }, {
            phone: '01271870153',
            amount: 5
        });

        expect(result).toMatchObject({
            success: false,
            stage: 'inquiry',
            message: 'Recipient is not available'
        });
        expect(result.checks.at(-1)).toMatchObject({ key: 'inquiry', status: 'failed' });
        expect(axios.post).toHaveBeenCalledTimes(3);
        expect(axios.post.mock.calls.some(([url]) => String(url).includes('/Transactions/Payment'))).toBe(false);
    });

    test('accepts a payment response that contains a provider reference without TransactionNumber', async () => {
        axios.post
            .mockResolvedValueOnce({
                data: { Code: 200, Data: { Access_Token: 'token-789' } }
            })
            .mockResolvedValueOnce({
                data: { Code: 200, Data: { PaymentBillInfo: 'payment-bill-info' } }
            })
            .mockResolvedValueOnce({
                data: {
                    Code: 200,
                    Data: {
                        IsPaid: 1,
                        RefTransactionNumber: 'REF-789',
                        ApprovalNumber: 'APP-789'
                    }
                }
            });

        const result = await executeTransferViaApi(
            { vodafoneNumber: '01271870153', amount: 5 },
            { apiUrl: 'https://zayn.example', apiUsername: 'api-user', apiPassword: 'api-pass' }
        );

        expect(result).toMatchObject({
            success: true,
            reference_number: 'REF-789',
            external_transaction_id: 'REF-789'
        });
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

    test('reviews provider transactions with one authentication and detects returned statuses', async () => {
        axios.post
            .mockResolvedValueOnce({
                data: { Code: 200, Data: { Access_Token: 'review-token' } }
            })
            .mockResolvedValueOnce({
                data: {
                    Code: 200,
                    Message: 'عمليه ناجحه',
                    Data: {
                        TransactionId: 9001,
                        RefNumber: 'REF-9001',
                        TransactionStatus: 'عملية مسترجعة',
                        Amount: 150,
                        PrintServiceDetailes: [{ Key: 'رقم الموبايل', Value: '01000000001' }]
                    }
                }
            })
            .mockResolvedValueOnce({
                data: {
                    Code: 200,
                    Data: {
                        TransactionId: 9002,
                        TransactionStatus: 'عمليه ناجحه',
                        Amount: 200,
                        PhoneNumber: '01000000002'
                    }
                }
            });

        const result = await getApiProviderTransactions({
            apiUrl: 'https://zayn.example',
            apiUsername: 'api-user',
            apiPassword: 'api-pass'
        }, ['9001', '9002']);

        expect(result.success).toBe(true);
        expect(result.checkedCount).toBe(2);
        expect(result.operations[0]).toMatchObject({
            success: true,
            requestedTransactionId: '9001',
            providerTransactionId: '9001',
            referenceNumber: 'REF-9001',
            phone: '01000000001',
            isReturned: true
        });
        expect(result.operations[1].isReturned).toBe(false);
        expect(axios.post).toHaveBeenCalledTimes(3);
        expect(axios.post).toHaveBeenNthCalledWith(
            2,
            'https://zayn.example/api/V1/Transactions/Print',
            { TransactionNumber: '9001' },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer review-token' })
            })
        );
        expect(isReturnedProviderStatus('تم إلغاء العملية وردها')).toBe(true);
        expect(isReturnedProviderStatus('عملية ناجحة')).toBe(false);
    });
});
