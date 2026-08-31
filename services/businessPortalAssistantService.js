'use strict';

const Transaction = require('../models/Transaction');
const { ownershipFilter } = require('./businessPortalService');

const sensitiveQuestion = /(?:كود|source|api|token|secret|password|كلمة\s*المرور|رمز\s*(?:Authenticator|المصادقة|الحماية)|قاعدة\s*البيانات|سيرفر|server|الإدارة|المدير|حسابات\s*الأخرى|مفتاح)/iu;
const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 800);
const money = (value) => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });

const response = (answer, options = {}) => ({
    success: true,
    answer,
    safeMode: true,
    suggestions: options.suggestions || [],
    action: options.action || null
});

const deny = () => response(
    'لا أستطيع المساعدة في الأكواد أو كلمات المرور أو رموز الحماية أو بيانات الإدارة والحسابات الأخرى. يمكنني مساعدتك فقط في عمليات وتقارير وإعدادات الحساب المفتوح.',
    { suggestions: ['ما هو رصيدي؟', 'كيف أنشئ عملية تحويل؟', 'ما حالة عملية؟'] }
);

const scopedTransaction = async (workspace, query) => {
    const ownership = await ownershipFilter(workspace);
    return Transaction.findOne({
        $and: [ownership, { customId: new RegExp(`^${String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }]
    }).select('customId status amount costLYD transferType createdAt updatedAt vodafoneNumber accountNumber').lean();
};

const scopedFilter = async (workspace, extra = {}) => ({ $and: [await ownershipFilter(workspace), extra] });

const transactionLabel = (status) => ({
    completed: 'مكتملة', pending: 'قيد المراجعة', processing: 'قيد التنفيذ', accepted: 'مقبولة',
    rejected: 'مرفوضة', cancelled_by_admin: 'ملغاة', deposit: 'إيداع مقبول', deposit_pending: 'إيداع قيد المراجعة', deduction: 'خصم'
})[status] || status;

const answer = async ({ workspace, question }) => {
    const text = normalize(question);
    if (text.length < 2) return response('اكتب سؤالك بوضوح. مثال: ما هو رصيدي؟ أو كيف أنشئ عملية تحويل؟');
    if (sensitiveQuestion.test(text)) return deny();

    if (/(?:رصيد|كم معي|متاح)/iu.test(text) && !/(?:تحويل\s*رصيد|رصيد\s*داخلي|بين\s*الحسابات)/iu.test(text)) {
        if (!workspace.permissions.canViewBalance) return response('لا تملك صلاحية عرض رصيد الشركة أو الوكالة من هذا الحساب.');
        return response(`الرصيد المتاح للحساب المفتوح هو ${money(workspace.entity.balance)} LYD.`, {
            suggestions: ['اعرض تقارير اليوم', 'كيف أحول رصيداً داخلياً؟'],
            action: { label: 'فتح الحركات المالية', href: '/client/finance' }
        });
    }

    const transactionId = text.match(/(?:رقم\s*(?:العملية|الحوالة)?\s*[:#-]?\s*)?([A-Z]{2,12}-[A-Z0-9-]{4,})/i)?.[1];
    if (transactionId) {
        const tx = await scopedTransaction(workspace, transactionId);
        if (!tx) return response('لم أجد عملية بهذا الرقم داخل الحساب المفتوح. راجع رقم العملية أو افتح سجل العمليات.');
        return response(`العملية ${tx.customId} حالتها: ${transactionLabel(tx.status)}. القيمة ${money(tx.amount)}، والتكلفة ${money(tx.costLYD)} LYD.`, {
            action: { label: 'فتح سجل العمليات', href: '/client/transactions' }
        });
    }

    if (/(?:آخر|اخر).*(?:عملية|عمليات|حوال)/iu.test(text)) {
        const rows = await Transaction.find(await scopedFilter(workspace))
            .sort({ createdAt: -1 }).limit(3).select('customId status amount createdAt').lean();
        if (!rows.length) return response('لا توجد عمليات مسجلة في الحساب المفتوح حتى الآن.');
        const list = rows.map((row) => `${row.customId}: ${transactionLabel(row.status)} (${money(row.amount)})`).join('\n');
        return response(`آخر العمليات في الحساب المفتوح:\n${list}`, {
            action: { label: 'فتح سجل العمليات', href: '/client/transactions' }
        });
    }

    if (/(?:إيداع|ايداع|تمويل|خصم)/iu.test(text)) {
        if (!workspace.permissions.canViewBalance) return response('لا تملك صلاحية عرض الإيداعات أو حركة الرصيد من هذا الحساب.');
        const rows = await Transaction.aggregate([
            { $match: await scopedFilter(workspace, { status: { $in: ['deposit', 'deposit_pending', 'deduction'] } }) },
            { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$amount' } } }
        ]);
        const accepted = rows.find((row) => row._id === 'deposit');
        const pendingDeposit = rows.find((row) => row._id === 'deposit_pending');
        const deductions = rows.find((row) => row._id === 'deduction');
        return response(`حركة الرصيد في الحساب المفتوح: إيداعات مقبولة ${money(accepted?.value)} LYD، إيداعات قيد المراجعة ${pendingDeposit?.count || 0}، وخصومات ${money(deductions?.value)} LYD.`, {
            action: { label: 'فتح الحركات المالية', href: '/client/finance' }
        });
    }

    if (/(?:تحويل\s*رصيد|رصيد\s*داخلي|بين\s*الحسابات)/iu.test(text)) {
        if (!workspace.permissions.canTransfer) return response('لا تملك صلاحية تحويل الرصيد من هذا الحساب.');
        return response('لتحويل رصيد داخلي: افتح الخدمات والتحويل، اكتب رقم حساب المستلم والمبلغ والملاحظة في قسم «تحويل رصيد داخلي»، ثم راجع اسم المستلم وأدخل رمز العمليات إن كان مفعلاً. التحويل النهائي يحتاج تأكيدك دائماً.', {
            action: { label: 'فتح تحويل الرصيد', href: '/client/services' }
        });
    }

    if (/(?:تقرير|اليوم|العمليات|احصائ|إحصائ)/iu.test(text)) {
        const ownership = await ownershipFilter(workspace);
        const start = new Date(); start.setHours(0, 0, 0, 0);
        const rows = await Transaction.aggregate([
            { $match: { $and: [ownership, { createdAt: { $gte: start } }] } },
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);
        const total = rows.reduce((sum, row) => sum + row.count, 0);
        const completed = rows.find((row) => row._id === 'completed')?.count || 0;
        const pending = rows.filter((row) => ['pending', 'processing', 'accepted'].includes(row._id)).reduce((sum, row) => sum + row.count, 0);
        return response(`ملخص اليوم للحساب المفتوح: ${total} عملية، منها ${completed} مكتملة و${pending} قيد المتابعة.`, {
            action: { label: 'فتح التقارير', href: '/client/reports' }
        });
    }

    if (/(?:كيف.*(?:تحويل|ارسال|إرسال)|انشئ.*عملية|إنشاء.*عملية)/iu.test(text)) {
        return response('من صفحة الخدمات والتحويل: اختر الخدمة، أدخل رقم المستلم والمبلغ والملاحظة، راجع التكلفة، ثم اضغط «مراجعة وإرسال العملية». إذا كان رمز العمليات مفعلاً فسيُطلب منك للتأكيد.', {
            action: { label: 'فتح الخدمات والتحويل', href: '/client/services' }
        });
    }

    if (/(?:خدم|سعر|صرف|محفظ|بريد|سيفا|بنكك)/iu.test(text)) {
        return response('تجد الخدمات المتاحة وسعر كل خدمة في صفحة الخدمات والتحويل. اختر الخدمة أولاً ثم راجع سعر الصرف والتكلفة التقديرية قبل إرسال العملية؛ السعر المعروض في الصفحة هو المعتمد لحسابك وقت المراجعة.', {
            action: { label: 'فتح الخدمات والأسعار', href: '/client/services' }
        });
    }

    if (/(?:دعم|مشكلة|شكوى|تذكر)/iu.test(text)) {
        return response('يمكنك فتح طلب دعم وكتابة المشكلة مع رقم العملية إن وجد. لا ترسل كلمة المرور أو رموز Authenticator أو رمز العمليات داخل طلب الدعم.', {
            action: { label: 'فتح الدعم الفني', href: '/client/support' }
        });
    }

    if (/(?:إعداد|اعداد|تغيير.*بيانات|تعديل.*بيانات)/iu.test(text)) {
        if (!workspace.permissions.canEditSettings) return response('لا تملك صلاحية تعديل إعدادات الحساب من هذا المستخدم.');
        return response('يمكنك تحديث البيانات التشغيلية المسموح بها من صفحة الإعدادات. لا يمكن للمساعد تغيير كلمة المرور أو رموز الحماية أو الصلاحيات.', {
            action: { label: 'فتح الإعدادات', href: '/client/settings' }
        });
    }

    if (/(?:موظف|فريق|عميل|زبون)/iu.test(text)) {
        const permitted = /(?:موظف|فريق)/iu.test(text) ? workspace.permissions.canManageStaff : workspace.permissions.canManageCustomers;
        if (!permitted) return response('لا تملك صلاحية إدارة هذه البيانات من الحساب المفتوح.');
        return response('يمكنك إدارة البيانات المسموح بها من صفحة الإدارة داخل حسابك. لن أعرض بيانات أي حساب خارج نطاقك.', {
            action: { label: 'فتح الإدارة', href: /(?:موظف|فريق)/iu.test(text) ? '/client/staff' : '/client/customers' }
        });
    }

    return response('أستطيع مساعدتك في الرصيد، حالة عملية برقمها، تقارير اليوم، الإيداعات، التحويلات، الخدمات، الدعم، الموظفين والعملاء ضمن صلاحيات الحساب المفتوح فقط.', {
        suggestions: ['ما هو رصيدي؟', 'آخر العمليات', 'كيف أحول رصيداً داخلياً؟', 'أحتاج إلى دعم فني']
    });
};

module.exports = { answer };
