'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const EDIT_VIEW = path.join(__dirname, '../views/admin_account_edit.ejs');
const CARD_VIEW = path.join(__dirname, '../views/partials/owner_email_otp_card.ejs');
const CLIENTS_VIEW = path.join(__dirname, '../views/clients.ejs');
const USER_DETAILS = path.join(__dirname, '../views/user_details.ejs');
const COMPANY_DETAILS = path.join(__dirname, '../views/company_details.ejs');
const REGISTRATION_ROUTE = path.join(__dirname, '../routes/registrationRequests.js');
const REGISTRATION_VIEW = path.join(__dirname, '../views/registration_requests.ejs');

const formData = (overrides = {}) => ({
    name: 'حساب تجريبي',
    phone: '0911111111',
    webUsername: 'account_user',
    status: 'active',
    role: 'user',
    tier: 2,
    creditLimit: 0,
    accountCode: '123456',
    customMargin: 0,
    cardMargin: 0,
    companyId: '',
    agentId: '',
    groupId: '',
    parentGroupId: '',
    serviceKey: 'vodafone',
    serviceKeys: ['vodafone'],
    telegramId: '',
    apiUrl: '',
    apiUsername: '',
    apiServiceId: 85,
    apiProviderId: 16,
    apiFieldId: 5488,
    apiMachineSerial: 'XP1',
    contactName: '',
    email: 'owner@example.com',
    ownerEmail: '',
    ownerName: '',
    ownerUsername: '',
    hasCompanyOwner: false,
    emailOtpEnabled: false,
    city: '',
    address: '',
    registrationNumber: '',
    canViewAllReports: false,
    canManageCompany: false,
    canCreateCompanyStaff: false,
    canManageAgent: false,
    canCreateAgentStaff: false,
    inheritCompanyPolicy: true,
    proofRequired: false,
    phoneLengthMode: 'all',
    maxConcurrentDevices: 1,
    sessionTtlEnabled: false,
    sessionTtlHours: 8,
    newPassword: '',
    apiPassword: '',
    apiToken: '',
    ...overrides
});

const renderEditor = (accountType, overrides = {}) => ejs.renderFile(EDIT_VIEW, {
    csrfToken: 'test-csrf',
    adminName: 'مدير الاختبار',
    account: {
        _id: '507f1f77bcf86cd799439011',
        name: 'حساب تجريبي',
        status: 'active',
        balance: 10,
        verificationDocuments: []
    },
    accountType,
    accountLabel: accountType === 'company' ? 'شركة' : accountType === 'agent' ? 'وكيل' : 'عميل',
    formData: formData(overrides),
    options: {
        statuses: ['active', 'inactive', 'banned'],
        roles: [],
        companies: [],
        agents: [],
        executors: [],
        managerGroups: [],
        executorServices: [],
        accountCodeLength: accountType === 'company' ? 5 : 6,
        ownerName: ''
    },
    returnUrl: '/clients',
    activePage: 'clients',
    error: accountType === 'company' ? 'البريد الإلكتروني مطلوب ويجب أن يكون بريداً صالحاً.' : '',
    query: {}
}, { filename: EDIT_VIEW });

describe('owner email OTP admin screens', () => {
    test.each(['user', 'agent', 'company'])('%s edit screen shows the owner email and email OTP control', async (accountType) => {
        const html = await renderEditor(accountType, accountType === 'company'
            ? { hasCompanyOwner: true, ownerName: 'مالك الشركة', ownerUsername: 'company.owner', ownerEmail: 'owner@example.com', emailOtpEnabled: true }
            : { emailOtpEnabled: true });

        expect(html).toContain('id="owner-email-otp"');
        expect(html).toContain('البريد الإلكتروني لصاحب الحساب');
        expect(html).toContain(accountType === 'user' ? 'طلب كود عند تسجيل الدخول' : 'إرسال رمز التحقق عبر البريد');
        expect(html).toContain('يلزم بريد صالح فقط عند تفعيل رمز الدخول بالبريد');
        expect(html).toContain('name="emailOtpEnabled"');
        expect(html.match(/name="emailOtpEnabled"/g)).toHaveLength(1);
        expect(html).toContain('data-email-otp-address');
        expect(html).toContain('input.required = otpToggle.checked');
        if (accountType === 'company') {
            expect(html).toContain('name="ownerEmail"');
            expect(html).toContain('البريد الإلكتروني للشركة');
            expect(html).toContain('company.owner');
            expect(html).toContain('checked');
        } else {
            expect(html).toContain('name="email"');
            expect(html).not.toContain('name="ownerEmail"');
        }
    });

    test('detail card and directory links expose the same owner email controls', async () => {
        const card = await ejs.renderFile(CARD_VIEW, {
            ownerOtp: {
                type: 'company',
                id: '507f1f77bcf86cd799439011',
                email: 'owner@example.com',
                emailOtpEnabled: false,
                ownerName: 'مالك الشركة',
                ownerUsername: 'company.owner',
                showLoginAccount: true,
                missingOwner: false
            }
        }, { filename: CARD_VIEW });
        const clients = fs.readFileSync(CLIENTS_VIEW, 'utf8');
        const userDetails = fs.readFileSync(USER_DETAILS, 'utf8');
        const companyDetails = fs.readFileSync(COMPANY_DETAILS, 'utf8');

        expect(card).toContain('البريد الإلكتروني لصاحب الحساب');
        expect(card).toContain('طلب كود التحقق عند تسجيل الدخول');
        expect(card).toContain('name="loginOtpChannel"');
        expect(card).toContain('value="telegram"');
        expect(card).toContain('يلزم بريد صالح فقط عند تفعيل رمز الدخول بالبريد');
        expect(card).toContain('input.required = otpToggle.checked');
        expect(card).toContain('type="text"');
        expect(card).toContain('/js/account-email-address.js');
        expect(card).not.toContain('type="email"');
        expect(fs.readFileSync(path.join(__dirname, '../public/js/account-email-address.js'), 'utf8')).toContain('البريد الإلكتروني مطلوب.');
        expect(card).toContain('/admin/accounts/company/507f1f77bcf86cd799439011/owner-otp');
        expect(card).toContain('checked');
        expect(clients).toContain('admin_merchant_list');
        const listPath=path.join(__dirname,'../views/partials/admin_merchant_list.ejs');
        const account={_id:'507f1f77bcf86cd799439011',name:'Test account',status:'active',balance:0};
        for(const [section,type] of [['users','user'],['agents','agent'],['companies','company']]) {
            const data={activeSection:section,users:[account],agents:[account],companies:[account],isMaster:true};
            const list=await ejs.renderFile(listPath,data,{filename:listPath});
            expect(list).toContain(`/admin/accounts/${type}/${account._id}/edit`);
            const restricted=await ejs.renderFile(listPath,{...data,isMaster:false},{filename:listPath});
            expect(restricted).not.toContain(`/admin/accounts/${type}/${account._id}/edit`);
        }
        const detail=fs.readFileSync(path.join(__dirname,'../views/admin_merchant_details.ejs'),'utf8');
        expect(detail).toContain("include('partials/owner_email_otp_card'");
        expect(userDetails).toContain('owner_email_otp_card');
        expect(companyDetails).toContain('owner_email_otp_card');
        expect(companyDetails).toContain('لا يوجد حساب مالك لهذه الشركة');
    });

    test('approving a client, company, or agent requires an email and enables email OTP', () => {
        const source = fs.readFileSync(REGISTRATION_ROUTE, 'utf8');
        const view = fs.readFileSync(REGISTRATION_VIEW, 'utf8');
        expect(source).toContain('businessProfile: { email: ownerEmail }');
        expect(source).toContain('email: ownerEmail');
        expect(source).toContain("otpDeliveryChannel: 'email'");
        expect(source).toContain("'email_required'");
        expect(source).toContain("'email_invalid'");
        expect(view).toContain('name="ownerEmail"');
        expect(view).toContain('data-required-email="owner"');
        expect(view).toContain('type="text"');
        expect(view).not.toContain('type="email"');
        expect(view).toContain('البريد الإلكتروني مطلوب قبل إنشاء الحساب.');
        expect(view).toContain('أدخل بريداً إلكترونياً صالحاً.');
    });
});

test('customer admin editor shows canonical confirmed Telegram and email status', async () => {
    const html = await renderEditor('user',{otpDeliveryChannel:'telegram',emailOtpVerified:true,telegramLoginVerified:true,emailOtpEnabled:false});
    expect(html).toContain('name="loginOtpChannel"');
    expect(html).toContain('value="telegram" selected');
    expect(html).toContain('البريد: مؤكد');
    expect(html).toContain('تليجرام: مرتبط ومؤكد');
    expect(html.match(/name="emailOtpEnabled"/g)).toHaveLength(1);
});
