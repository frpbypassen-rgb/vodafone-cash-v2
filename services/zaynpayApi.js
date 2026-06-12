const axios = require('axios');

class ZaynPayAPI {
    constructor() {
        this.baseURL = 'https://zaynpay.com';
        this.username = process.env.ZAYN_USERNAME || process.env.ZAYNPAY_USERNAME;
        this.password = process.env.ZAYN_PASSWORD || process.env.ZAYNPAY_PASSWORD;
        this.serviceId = parseInt(process.env.ZAYNPAY_SERVICE_ID || 307);
        this.providerId = parseInt(process.env.ZAYNPAY_PROVIDER_ID || 29);
        this.fieldId = parseInt(process.env.ZAYNPAY_FIELD_ID || 3488);
        this.token = null;
    }

    async login() {
        try {
            if (!this.username || !this.password) {
                throw new Error('ZaynPay credentials are not configured');
            }

            const res = await axios.post(`${this.baseURL}/api/Account/GetToken`, {
                UserName: this.username,
                Password: this.password,
                AppType: "1",
                AppId: "app12",
                VersionID: "Samsuang-502"
            }, {
                headers: { 'app-version': 'xyz67', 'Content-Type': 'application/json' }
            });
            if (res.data && res.data.Code === 200 && res.data.Data) {
                this.token = res.data.Data.Access_Token;
                return true;
            }
            throw new Error(res.data.Message || 'Failed to login to ZaynPay');
        } catch (error) {
            console.error('ZaynPay Login Error:', error.response ? error.response.data : error.message);
            throw new Error('فشل تسجيل الدخول في بوابة ZaynPay');
        }
    }

    async getHeaders() {
        if (!this.token) await this.login();
        return {
            'Authorization': `Bearer ${this.token}`,
            'app-version': 'xyz67',
            'Content-Type': 'application/json',
            'Accept-Language': 'ar-EG'
        };
    }

    async inquiry(walletNumber, amount) {
        try {
            const headers = await this.getHeaders();
            const payload = {
                Fields: [
                    { Id: this.fieldId, Value: walletNumber }
                ],
                CurrentServiceProviderId: this.providerId,
                ServiceId: this.serviceId,
                MachineSerial: "XP1",
                InqueryAmount: amount
            };

            let res = await axios.post(`${this.baseURL}/api/V1/Transactions/Inquiry`, payload, { headers });
            
            // If token expired (401), re-login and retry
            if (res.status === 401 || (res.data && res.data.Code === 401)) {
                await this.login();
                res = await axios.post(`${this.baseURL}/api/V1/Transactions/Inquiry`, payload, { headers: await this.getHeaders() });
            }

            if (res.data && res.data.Code === 200 && res.data.Data) {
                return res.data.Data.PaymentBillInfo;
            }
            throw new Error(res.data.Message || 'فشل الاستعلام');
        } catch (error) {
            console.error('ZaynPay Inquiry Error:', error.response ? error.response.data : error.message);
            throw new Error('فشل الاستعلام من بوابة ZaynPay: ' + (error.response?.data?.Message || error.message));
        }
    }

    async pay(paymentBillInfo, walletNumber, amount) {
        try {
            const headers = await this.getHeaders();
            const payload = {
                Fields: [
                    { Id: this.fieldId, Value: walletNumber }
                ],
                CurrentServiceProviderId: this.providerId,
                ServiceId: this.serviceId,
                PaymentBillInfo: paymentBillInfo,
                Amount: amount,
                MachineSerial: "XP1"
            };

            let res = await axios.post(`${this.baseURL}/api/V1/Transactions/Payment`, payload, { headers });
            
            if (res.status === 401 || (res.data && res.data.Code === 401)) {
                await this.login();
                res = await axios.post(`${this.baseURL}/api/V1/Transactions/Payment`, payload, { headers: await this.getHeaders() });
            }

            if (res.data && res.data.Code === 200 && res.data.Data) {
                return {
                    success: true,
                    transactionNumber: res.data.Data.TransactionNumber,
                    refNumber: res.data.Data.RefTransactionNumber,
                    amount: res.data.Data.TotalAmount || amount,
                    cost: res.data.Data.ServiceCost || 0
                };
            }
            
            return {
                success: false,
                error: res.data ? res.data.Message : 'فشل تنفيذ الدفع'
            };
        } catch (error) {
            console.error('ZaynPay Payment Error:', error.response ? error.response.data : error.message);
            return {
                success: false,
                error: 'خطأ في الاتصال ببوابة ZaynPay: ' + (error.response?.data?.Message || error.message)
            };
        }
    }
}

module.exports = new ZaynPayAPI();
