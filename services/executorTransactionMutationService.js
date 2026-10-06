'use strict';

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const ClientCompany = require('../models/ClientCompany');
const User = require('../models/User');
const { withOptionalMongoTransaction } = require('./adminFinancialMutationService');
const { refundBlockedByUnresolvedProvider } = require('./providerDispatchClaimService');
const { calculateTransferCostLYD, isSourceToLydRate } = require('../utils/transferPricing');
const { appendAdminNote } = require('../utils/executorTransactionNotes');
const { ExecutorTransactionError } = require('./executorTransactionError');

const editExecutorAmount = async ({ transactionId, executorId, newAmount, reason }) => {
    const emp = await Employee.findById(executorId);
    if (!emp) throw new ExecutorTransactionError('حساب المنفذ غير متاح', 401);
    const parsedAmount = Number(newAmount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ExecutorTransactionError('مبلغ غير صالح');
    }

    await withOptionalMongoTransaction(async (session) => {
        const query = Transaction.findOne({
            _id: transactionId,
            status: 'accepted',
            operatorId: emp._id.toString()
        });
        const tx = await (session ? query.session(session) : query);
        if (!tx) {
            throw new ExecutorTransactionError('العملية غير صالحة أو لا تملك صلاحية تعديلها', 409);
        }

        const oldAmount = tx.amount || 0;
        const oldCost = tx.costLYD || 0;
        const actualRate = tx.exchangeRate || (oldAmount > 0 && oldCost > 0
            ? (isSourceToLydRate(tx.transferType) ? oldCost / oldAmount : oldAmount / oldCost)
            : 0);
        const newCost = calculateTransferCostLYD({
            serviceKey: tx.transferType,
            amount: parsedAmount,
            exchangeRate: actualRate
        });
        if (!actualRate || !Number.isFinite(newCost)) {
            throw new ExecutorTransactionError('تعذر احتساب سعر الصرف للعملية');
        }
        const diffCost = newCost - oldCost;

        if (tx.companyId) {
            const companyQuery = ClientCompany.findById(tx.companyId);
            const comp = await (session ? companyQuery.session(session) : companyQuery);
            if (!comp) throw new ExecutorTransactionError('حساب العميل غير موجود', 409);
            if (diffCost > 0) {
                const updated = await ClientCompany.findOneAndUpdate(
                    { _id: tx.companyId, balance: { $gte: diffCost - (comp.creditLimit || 0) } },
                    { $inc: { balance: -diffCost } },
                    { returnDocument: 'after', session }
                );
                if (!updated) throw new ExecutorTransactionError('رصيد العميل لا يكفي لتغطية الزيادة', 409);
            } else if (diffCost < 0) {
                const refunded = await ClientCompany.findByIdAndUpdate(
                    tx.companyId, { $inc: { balance: Math.abs(diffCost) } }, { session }
                );
                if (!refunded) throw new ExecutorTransactionError('تعذر إعادة رصيد العميل', 409);
            }
        } else if (tx.userId) {
            const userQuery = User.findOne({ $or: [{ phone: tx.userId }, { webUsername: tx.userId }] });
            const user = await (session ? userQuery.session(session) : userQuery);
            if (!user) throw new ExecutorTransactionError('حساب العميل غير موجود', 409);
            if (diffCost > 0) {
                const updated = await User.findOneAndUpdate(
                    { _id: user._id, balance: { $gte: diffCost - (user.creditLimit || 0) } },
                    { $inc: { balance: -diffCost } },
                    { returnDocument: 'after', session }
                );
                if (!updated) throw new ExecutorTransactionError('رصيد العميل لا يكفي لتغطية الزيادة', 409);
            } else if (diffCost < 0) {
                const refunded = await User.updateOne(
                    { _id: user._id }, { $inc: { balance: Math.abs(diffCost) } }, { session }
                );
                if (!refunded.matchedCount) throw new ExecutorTransactionError('تعذر إعادة رصيد العميل', 409);
            }
        } else if (diffCost !== 0) {
            throw new ExecutorTransactionError('مالك رصيد العملية غير معروف', 409);
        }

        tx.amount = parsedAmount;
        tx.costLYD = newCost;
        appendAdminNote(tx, `[تعديل المبلغ من ${oldAmount} إلى ${parsedAmount} | السبب: ${reason}]`);
        tx.$where = { status: 'accepted', operatorId: String(emp._id), amount: oldAmount, costLYD: oldCost };
        await tx.save({ session });
    });
    return parsedAmount;
};

const cancelExecutorTask = async ({ transactionId, executorId, reason }) => {
    const cleanReason = String(reason || '').trim();
    if (!cleanReason) throw new ExecutorTransactionError('سبب الإلغاء مطلوب.');
    const emp = await Employee.findById(executorId);
    if (!emp) throw new ExecutorTransactionError('حساب المنفذ غير متاح', 401);
    const cancelledAt = new Date();
    const tx = await withOptionalMongoTransaction(async (session) => {
        const query = Transaction.findById(transactionId);
        const current = await (session ? query.session(session) : query);
        if (!current || current.status !== 'accepted' || current.operatorId !== String(emp._id)) return null;
        const blocked = refundBlockedByUnresolvedProvider(current);
        if (blocked) throw new ExecutorTransactionError(blocked.message, 409, blocked.code);
        const note = `[تم الإلغاء | المنفذ: ${emp.name} | السبب: ${cleanReason}]`;
        const cancelled = await Transaction.findOneAndUpdate(
            { _id: current._id, status: 'accepted', operatorId: String(emp._id) },
            { $set: {
                status: 'rejected',
                cancellationReason: cleanReason,
                cancelledBy: emp.name || 'المنفذ',
                cancelledAt,
                adminNotes: [current.adminNotes, note].filter(Boolean).join('\n')
            } },
            { returnDocument: 'after', session }
        );
        if (!cancelled) return null;
        let refunded = null;
        if (cancelled.companyId) {
            refunded = await ClientCompany.findByIdAndUpdate(
                cancelled.companyId, { $inc: { balance: cancelled.costLYD } }, { session }
            );
        } else if (cancelled.userId) {
            refunded = await User.findOneAndUpdate(
                { $or: [{ phone: cancelled.userId }, { webUsername: cancelled.userId }] },
                { $inc: { balance: cancelled.costLYD } },
                { session }
            );
        }
        if (!refunded && cancelled.costLYD) throw new ExecutorTransactionError('تعذر إعادة رصيد العميل', 409);
        return cancelled;
    });
    return tx ? { tx, emp, reason: cleanReason, cancelledAt } : null;
};

const returnExecutorTask = async ({ transactionId, executorId, reason }) => {
    const tx = await Transaction.findById(transactionId);
    const blocked = refundBlockedByUnresolvedProvider(tx);
    if (blocked) throw new ExecutorTransactionError(blocked.message, 409, blocked.code);
    const emp = await Employee.findById(executorId);
    if (!tx || !emp || tx.status !== 'accepted' || tx.operatorId !== emp._id.toString()) return false;
    const returned = await Transaction.findOneAndUpdate(
        { _id: tx._id, status: 'accepted', operatorId: String(emp._id) },
        {
            $set: {
                status: 'pending',
                broadcastMessages: [],
                adminNotes: [tx.adminNotes, `[إرجاع للإدارة | السبب: ${reason}]`].filter(Boolean).join('\n')
            },
            $unset: {
                executorGroupId: 1, managerGroupId: 1, executorName: 1, operatorId: 1,
                assignedExecutorId: 1, assignedExecutorName: 1, assignedExecutorAt: 1
            }
        }
    );
    return Boolean(returned);
};

module.exports = { editExecutorAmount, cancelExecutorTask, returnExecutorTask };
