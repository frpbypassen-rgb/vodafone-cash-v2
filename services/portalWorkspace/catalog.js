'use strict';

const { getTransferServiceRules } = require('../../utils/transferServiceRules');
const { getTransferPricingDefinition } = require('../../utils/transferPricing');

const STATUS_META = Object.freeze({
    pending: { label: 'قيد الانتظار', tone: 'warning' },
    processing: { label: 'قيد التنفيذ', tone: 'info' },
    accepted: { label: 'قيد التنفيذ', tone: 'info' },
    completed: { label: 'ناجحة', tone: 'success' },
    rejected: { label: 'مرفوضة', tone: 'danger' },
    cancelled_by_admin: { label: 'ملغية', tone: 'danger' },
    deposit_pending: { label: 'إيداع معلق', tone: 'warning' },
    deposit: { label: 'إيداع', tone: 'success' },
    deduction: { label: 'خصم', tone: 'danger' },
});

const SERVICE_CATALOG = Object.freeze([
    Object.freeze({
        key: 'vodafone',
        slug: 'cash',
        webType: 'كاش',
        label: 'محافظ كاش',
        shortLabel: 'كاش',
        icon: 'fa-mobile-screen-button',
        tone: 'green',
        description: 'تحويل مباشر إلى المحافظ الإلكترونية المصرية.',
        numberLabel: 'رقم المحفظة',
        numberPlaceholder: '01XXXXXXXXX',
        ...getTransferServiceRules('vodafone'),
        ...getTransferPricingDefinition('vodafone'),
    }),
    Object.freeze({
        key: 'post_account',
        slug: 'post-account',
        webType: 'بريد حساب',
        label: 'البريد - حساب',
        shortLabel: 'بريد حساب',
        icon: 'fa-building-columns',
        tone: 'blue',
        description: 'تحويل إلى حساب بريدي باسم المستفيد.',
        numberLabel: 'رقم الحساب البريدي',
        numberPlaceholder: 'أدخل رقم الحساب',
        ...getTransferServiceRules('post_account'),
        ...getTransferPricingDefinition('post_account'),
    }),
    Object.freeze({
        key: 'post_card',
        slug: 'post-card',
        webType: 'بريد بطاقة',
        label: 'البريد - بطاقة',
        shortLabel: 'بريد بطاقة',
        icon: 'fa-id-card',
        tone: 'amber',
        description: 'تحويل بالرقم القومي مع مستند الهوية.',
        numberLabel: 'الرقم القومي',
        numberPlaceholder: '14 رقماً',
        ...getTransferServiceRules('post_card'),
        ...getTransferPricingDefinition('post_card'),
    }),
    Object.freeze({
        key: 'bank_account',
        slug: 'bank',
        webType: 'حساب بنكي',
        label: 'حساب بنكي',
        shortLabel: 'تحويل بنكي',
        icon: 'fa-landmark',
        tone: 'navy',
        description: 'تحويل إلى حساب مصرفي أو رقم IBAN.',
        numberLabel: 'رقم الحساب أو IBAN',
        numberPlaceholder: 'رقم الحساب البنكي',
        ...getTransferServiceRules('bank_account'),
        ...getTransferPricingDefinition('bank_account'),
    }),
    Object.freeze({
        key: 'sefa_niger',
        slug: 'sefa',
        webType: 'سيفا النيجر',
        label: 'سيفا النيجر',
        shortLabel: 'سيفا النيجر',
        icon: 'fa-earth-africa',
        tone: 'cyan',
        description: 'تحويل NITA أو NITA Account داخل النيجر.',
        numberLabel: 'رقم حساب NITA',
        numberPlaceholder: 'رقم الحساب من 8 إلى 10 أرقام',
        ...getTransferServiceRules('sefa_niger'),
        ...getTransferPricingDefinition('sefa_niger'),
    }),
    Object.freeze({
        key: 'bankak_sudan',
        slug: 'bankak',
        webType: 'بنكك السودان',
        label: 'بنكك السودان',
        shortLabel: 'بنكك',
        icon: 'fa-money-bill-transfer',
        tone: 'red',
        description: 'تحويل إلى حساب بنكك داخل السودان.',
        numberLabel: 'رقم حساب بنكك',
        numberPlaceholder: 'أدخل رقم الحساب',
        ...getTransferServiceRules('bankak_sudan'),
        ...getTransferPricingDefinition('bankak_sudan'),
    }),
]);

const findServiceByToken = (token) => {
    const value = String(token || '')
        .trim()
        .toLowerCase();
    if (!value) return null;
    return SERVICE_CATALOG.find((service) => service.key === value || service.slug === value) || null;
};

const PAGE_META = Object.freeze({
    overview: { title: 'مركز العمل', eyebrow: 'نظرة تشغيلية', icon: 'fa-grid-2' },
    services: { title: 'الخدمات والتحويل', eyebrow: 'إنشاء عملية', icon: 'fa-paper-plane' },
    transactions: { title: 'المعاملات', eyebrow: 'المتابعة والتنفيذ', icon: 'fa-list-check' },
    finance: { title: 'الحركات المالية', eyebrow: 'كشف الحساب', icon: 'fa-scale-balanced' },
    agency_balances: { title: 'أرصدة العملاء', eyebrow: 'حسابات الوكالة', icon: 'fa-wallet' },
    agency_debts: { title: 'ديون العملاء', eyebrow: 'التحصيل والمتابعة', icon: 'fa-file-invoice-dollar' },
    agency_account: { title: 'حساب الوكالة', eyebrow: 'الرصيد لدى الشركة', icon: 'fa-building-columns' },
    agency_position: { title: 'المركز المالي', eyebrow: 'تغطية الوكالة', icon: 'fa-scale-balanced' },
    agency_profits: { title: 'أرباح العملاء', eyebrow: 'هوامش سعر الصرف', icon: 'fa-chart-line' },
    customer_profile: { title: 'ملف العميل', eyebrow: 'إدارة مالية كاملة', icon: 'fa-user-gear' },
    customers: { title: 'العملاء', eyebrow: 'إدارة الحسابات التابعة', icon: 'fa-users' },
    staff: { title: 'الموظفون والصلاحيات', eyebrow: 'إدارة الفريق', icon: 'fa-user-group' },
    reports: { title: 'التقارير والتحليلات', eyebrow: 'قرارات مبنية على البيانات', icon: 'fa-chart-column' },
    settings: { title: 'الإعدادات', eyebrow: 'بيانات المنشأة والأمان', icon: 'fa-sliders' },
    security: { title: 'أمان الحساب', eyebrow: 'كلمة المرور والأجهزة', icon: 'fa-shield-halved' },
    support: { title: 'الدعم الفني', eyebrow: 'تواصل مباشر وآمن', icon: 'fa-headset' },
    smart_transfer: { title: 'التحويل الذكي', eyebrow: 'لصق رسالة وتحويلها', icon: 'fa-wand-magic-sparkles' },
    internal_transfer: { title: 'تحويل داخلي', eyebrow: 'بين حسابات المنشأة', icon: 'fa-right-left' },
    service_workbench: { title: 'منضدة التحويل', eyebrow: 'خدمة معزولة', icon: 'fa-paper-plane' },
    deposits: { title: 'طلب إيداع', eyebrow: 'تمويل الرصيد', icon: 'fa-building-columns' },
});

const COMPANY_PAGE_META = Object.freeze({
    overview: { title: 'مركز قيادة الشركة', eyebrow: 'لوحة موحّدة للتشغيل' },
    services: { title: 'معرض الخدمات', eyebrow: 'قناة واحدة لكل بطاقة' },
    transactions: { title: 'غرفة العمليات', eyebrow: 'بحث ومتابعة التنفيذ' },
    staff: { title: 'فريق الشركة', eyebrow: 'الحسابات والأدوار' },
    finance: { title: 'مكتب المحاسبة', eyebrow: 'رصيد وكشوف بلا تنفيذ' },
    reports: { title: 'كشف الحساب', eyebrow: 'بيانات موحّدة من الإدارة' },
    settings: { title: 'بيانات المنشأة', eyebrow: 'الملف والتواصل' },
    security: { title: 'أمان الحساب', eyebrow: 'كلمة المرور وMFA والأجهزة' },
    support: { title: 'مركز الدعم', eyebrow: 'مساعدة ومتابعة آمنة' },
    smart_transfer: { title: 'التحويل الذكي', eyebrow: 'من رسالة إلى عملية' },
    internal_transfer: { title: 'تحويل رصيد داخلي', eyebrow: 'بين حسابات الشركة' },
    service_workbench: { title: 'منضدة الخدمة', eyebrow: 'حقول هذه القناة فقط' },
    deposits: { title: 'طلب إيداع', eyebrow: 'تمويل حساب الشركة' },
});

const REPORT_SCOPES = Object.freeze({
    organization: 'تقرير المنشأة',
    customers: 'تقرير العملاء',
    staff: 'تقرير الموظفين',
});

const COMPANY_REPORT_SCOPES = Object.freeze({
    organization: 'تقرير المنشأة',
    staff: 'تقرير الموظفين',
});

module.exports = {
    STATUS_META,
    SERVICE_CATALOG,
    findServiceByToken,
    PAGE_META,
    COMPANY_PAGE_META,
    REPORT_SCOPES,
    COMPANY_REPORT_SCOPES,
};
