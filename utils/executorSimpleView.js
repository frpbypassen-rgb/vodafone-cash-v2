'use strict';

const isSimpleExecutor = (employee) => Boolean(
    employee?.simpleTaskViewEnabled
    && ['operator', 'external'].includes(employee.role)
    && employee.groupId
    && employee.groupId.isApiBot !== true
    && employee.groupId.isApiGroup !== true
    && employee.groupId.isManagerBot !== true
);

const parseSimpleCompletionInput = ({ body = {}, proofCount = 0 } = {}) => {
    if (Array.isArray(body.senderEntries) && body.senderEntries.length) {
        throw new Error('تقسيم العملية غير متاح في واجهة التنفيذ المبسطة.');
    }
    const value = body.executionNumber ?? body.senderPhone ?? '';
    const executionNumber = String(value).trim();
    if (executionNumber && !/^\d{3,11}$/.test(executionNumber)) {
        throw new Error('رقم المنفذ يجب أن يتكون من 3 إلى 11 رقمًا.');
    }
    if (!executionNumber && proofCount < 1) {
        throw new Error('أرفق صورة التنفيذ أو أدخل رقم المنفذ.');
    }
    return executionNumber;
};

module.exports = { isSimpleExecutor, parseSimpleCompletionInput };
