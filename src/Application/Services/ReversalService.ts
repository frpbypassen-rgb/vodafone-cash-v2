import mongoose from 'mongoose';
import Transaction from '../../Domain/Entities/Transaction';
import User from '../../Domain/Entities/User';
import Ledger from '../../Domain/Entities/Ledger';
import JournalEvent from '../../Domain/Entities/JournalEvent';
import logger from '../../../utils/logger';
import eventBus from '../../../services/eventBus';

const Counter = require('../../../models/Counter');

type ReversalStatus = 'rejected' | 'cancelled_by_admin';

interface ReversalOptions {
    status?: ReversalStatus;
    cancellationNumber?: string;
}

interface ReversalResult {
    success: boolean;
    message: string;
    cancellationNumber?: string;
}

export class ReversalService {
    private hasLegacyBalance(doc: any): boolean {
        return Number.isFinite(Number(doc?.balance));
    }

    private getWalletBalance(doc: any, currency: string): number {
        if (this.hasLegacyBalance(doc)) {
            return Number(doc.balance);
        }
        const balances = doc?.balances;
        if (!balances) return 0;
        if (typeof balances.get === 'function') {
            return Number(balances.get(currency)) || 0;
        }
        return Number(balances[currency]) || 0;
    }

    private balancePath(doc: any, currency: string): string {
        return this.hasLegacyBalance(doc) ? 'balance' : `balances.${currency}`;
    }

    private async applyRefund(TargetModel: any, targetDoc: any, targetId: any, currency: string, amount: number, session: any): Promise<any> {
        const balanceKey = this.balancePath(targetDoc, currency);
        if (typeof TargetModel.findByIdAndUpdate === 'function') {
            return TargetModel.findByIdAndUpdate(
                targetId,
                { $inc: { [balanceKey]: amount } },
                { new: true, session }
            );
        }

        if (balanceKey === 'balance') {
            targetDoc.balance = this.getWalletBalance(targetDoc, currency) + amount;
        } else if (targetDoc.balances && typeof targetDoc.balances.set === 'function') {
            targetDoc.balances.set(currency, this.getWalletBalance(targetDoc, currency) + amount);
        } else {
            targetDoc.balances = targetDoc.balances || {};
            targetDoc.balances[currency] = this.getWalletBalance(targetDoc, currency) + amount;
        }

        await targetDoc.save({ session });
        return targetDoc;
    }

    private async nextCancellationNumber(session: any): Promise<string> {
        const now = new Date();
        const year = String(now.getFullYear()).slice(-2);
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const counter = await Counter.findOneAndUpdate(
            { name: `cancellation-${year}${month}` },
            { $inc: { value: 1 } },
            { upsert: true, new: true, setDefaultsOnInsert: true, session }
        );

        return `CAN-${year}${month}-${String(counter.value).padStart(5, '0')}`;
    }

    /**
     * تنفيذ استرجاع كامل لعملية تحويل (Refund / Rollback)
     */
    public async reverseTransaction(txId: string, reason: string, performedBy: string, options: ReversalOptions = {}): Promise<ReversalResult> {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            // 1. البحث عن العملية
            const tx = await Transaction.findById(txId).session(session);
            if (!tx) {
                await session.abortTransaction();
                return { success: false, message: 'العملية غير موجودة' };
            }

            if (tx.status !== 'completed' && tx.status !== 'accepted' && tx.status !== 'processing' && tx.status !== 'pending') {
                await session.abortTransaction();
                return { success: false, message: 'حالة العملية لا تسمح بالإلغاء والاسترجاع' };
            }

            // 2. البحث عن المستخدم أو الشركة وإرجاع الرصيد
            const cancellationNumber = options.cancellationNumber || tx.cancellationNumber || await this.nextCancellationNumber(session);
            const cancelledAt = new Date();
            const targetStatus = options.status || 'cancelled_by_admin';

            let targetId: any;
            let TargetModel: any;
            let targetDoc: any;
            const currency = 'EGP'; // العملة الافتراضية للعميل

            if (tx.companyId) {
                try {
                    TargetModel = mongoose.model('ClientCompany');
                } catch (_) {
                    TargetModel = require('../../../models/ClientCompany');
                }
                targetDoc = await TargetModel.findById(tx.companyId).session(session);
                if (targetDoc) targetId = targetDoc._id;
            } else if (tx.userId) {
                TargetModel = User;
                targetDoc = await User.findOne({ phone: tx.userId }).session(session);
                if (targetDoc) targetId = targetDoc._id;
            }

            const cost = tx.costLYD;
            if (tx.isSubAccountTx) {
                const SubAccount = require('../../../models/SubAccount');
                const subDoc = await SubAccount.findById(tx.subAccountId).session(session);
                if (!subDoc) {
                    await session.abortTransaction();
                    return { success: false, message: 'الحساب التابع غير موجود لإرجاع الرصيد' };
                }

                // 1. استرجاع رصيد الحساب التابع (subAccountCostLYD)
                const subBalanceBefore = subDoc.balance || 0;
                const updatedSub = await SubAccount.findByIdAndUpdate(
                    tx.subAccountId,
                    { $inc: { balance: tx.subAccountCostLYD } },
                    { new: true, session }
                );
                if (!updatedSub) {
                    await session.abortTransaction();
                    return { success: false, message: 'فشل استرجاع رصيد الحساب التابع' };
                }
                const subBalanceAfter = updatedSub.balance || 0;

                // Ledger لنقاط البيع التابعة
                const ledgerSub = new Ledger({
                    entityId: tx.subAccountId,
                    entityModel: 'SubAccount',
                    transactionId: tx.customId,
                    type: 'REFUND',
                    amount: tx.subAccountCostLYD,
                    debitAccount: 'Assets:VodafoneCash',
                    creditAccount: 'Liabilities:ClientDeposits',
                    balanceBefore: subBalanceBefore,
                    balanceAfter: subBalanceAfter,
                    description: `استرجاع تكلفة حوالة ملغاة رقم ${tx.customId} (السبب: ${reason})`
                });
                await ledgerSub.save({ session });

                // Event Sourcing لنقطة البيع
                const lastSubEvent = await JournalEvent.findOne({ entityId: tx.subAccountId }).sort({ sequenceNumber: -1 }).session(session);
                const subSeqNum = lastSubEvent ? lastSubEvent.sequenceNumber + 1 : 1;
                const subEvent = new JournalEvent({
                    eventType: 'TransferReversed',
                    entityId: tx.subAccountId,
                    entityModel: 'SubAccount',
                    amount: tx.subAccountCostLYD,
                    currency,
                    sequenceNumber: subSeqNum,
                    metadata: {
                        transactionId: tx.customId,
                        reason,
                        performedBy,
                        cancellationNumber
                    }
                });
                await subEvent.save({ session });

                // 2. استرجاع رصيد الوكيل الرئيسي (costLYD)
                if (!targetDoc) {
                    await session.abortTransaction();
                    return { success: false, message: 'المستفيد الرئيسي غير موجود بالنظام لإرجاع الرصيد' };
                }
                const masterBalanceBefore = this.getWalletBalance(targetDoc, currency);
                const updatedMaster = await this.applyRefund(TargetModel, targetDoc, targetId, currency, cost, session);
                if (!updatedMaster) {
                    await session.abortTransaction();
                    session.endSession();
                    return { success: false, message: 'المستفيد الرئيسي غير موجود بالنظام لإرجاع الرصيد' };
                }
                const masterBalanceAfter = this.getWalletBalance(updatedMaster, currency);

                // Ledger للوكيل الرئيسي
                const ledgerMaster = new Ledger({
                    entityId: targetId,
                    entityModel: TargetModel.modelName,
                    transactionId: tx.customId,
                    type: 'REFUND',
                    amount: cost,
                    debitAccount: 'Assets:VodafoneCash',
                    creditAccount: 'Liabilities:ClientDeposits',
                    balanceBefore: masterBalanceBefore,
                    balanceAfter: masterBalanceAfter,
                    description: `استرجاع تكلفة حوالة ملغاة من نقطة بيع (${tx.subAccountName}) رقم ${tx.customId} (السبب: ${reason})`
                });
                await ledgerMaster.save({ session });

                // Event Sourcing للرئيسي
                const lastMasterEvent = await JournalEvent.findOne({ entityId: targetId }).sort({ sequenceNumber: -1 }).session(session);
                const masterSeqNum = lastMasterEvent ? lastMasterEvent.sequenceNumber + 1 : 1;
                const masterEvent = new JournalEvent({
                    eventType: 'TransferReversed',
                    entityId: targetId,
                    entityModel: TargetModel.modelName,
                    amount: cost,
                    currency,
                    sequenceNumber: masterSeqNum,
                    metadata: {
                        transactionId: tx.customId,
                        reason,
                        performedBy,
                        cancellationNumber
                    }
                });
                await masterEvent.save({ session });

            } else {
                if (!targetDoc) {
                    await session.abortTransaction();
                    return { success: false, message: 'المستفيد غير موجود بالنظام لإرجاع الرصيد' };
                }

                // تحديث رصيد العملة المقابلة في المحفظة متعددة العملات
                const balanceBefore = this.getWalletBalance(targetDoc, currency);
                const updatedTarget = await this.applyRefund(TargetModel, targetDoc, targetId, currency, cost, session);

                if (!updatedTarget) {
                    await session.abortTransaction();
                    session.endSession();
                    return { success: false, message: 'المستفيد غير موجود بالنظام لإرجاع الرصيد' };
                }

                const balanceAfter = this.getWalletBalance(updatedTarget, currency);

                // 3. كتابة قيد عكسي في دفتر الأستاذ (Double-Entry Debit/Credit)
                const ledgerEntry = new Ledger({
                    entityId: targetId,
                    entityModel: tx.companyId ? 'ClientCompany' : 'User',
                    transactionId: tx.customId,
                    type: 'REFUND',
                    amount: cost,
                    debitAccount: 'Assets:VodafoneCash',
                    creditAccount: 'Liabilities:ClientDeposits',
                    balanceBefore,
                    balanceAfter,
                    description: `استرجاع تكلفة الحوالة رقم ${tx.customId} (السبب: ${reason})`
                });
                await ledgerEntry.save({ session });

                // 4. حفظ الحدث (Event Sourcing)
                const lastEvent = await JournalEvent.findOne({ entityId: targetId }).sort({ sequenceNumber: -1 }).session(session);
                const sequenceNumber = lastEvent ? lastEvent.sequenceNumber + 1 : 1;

                const refundEvent = new JournalEvent({
                    eventType: 'TransferReversed',
                    entityId: targetId,
                    entityModel: tx.companyId ? 'ClientCompany' : 'User',
                    amount: cost,
                    currency,
                    sequenceNumber,
                    metadata: {
                        transactionId: tx.customId,
                        reason,
                        performedBy,
                        cancellationNumber
                    }
                });
                await refundEvent.save({ session });
            }

            // 5. تحديث حالة العملية
            tx.status = targetStatus;
            tx.cancellationNumber = cancellationNumber;
            tx.cancellationReason = reason;
            tx.cancelledBy = performedBy;
            tx.cancelledAt = cancelledAt;
            tx.notes = (tx.notes ? `${tx.notes}\n` : '') + `[تم الاسترجاع بواسطة: ${performedBy} | السبب: ${reason}]`;
            tx.notes = (tx.notes ? `${tx.notes}\n` : '') + `[رقم الإلغاء: ${cancellationNumber} | تاريخ الإلغاء: ${cancelledAt.toISOString()}]`;
            await tx.save({ session });

            await session.commitTransaction();
            session.endSession();

            // نشر الأحداث للمنظومة
            eventBus.publish('transfer:cancelled', { tx, reason, cancellationNumber });
            logger.info(`Transaction ${tx.customId} reversed by ${performedBy} with cancellation ${cancellationNumber}`);
            return { success: true, message: 'تم إلغاء العملية واسترداد الرصيد بنجاح', cancellationNumber };
        } catch (error: any) {
            await session.abortTransaction();
            session.endSession();
            logger.error(`Failed to reverse transaction ${txId}`, { error: error.message });
            return { success: false, message: `فشل الاسترجاع: ${error.message}` };
        }
    }
}

export const reversalService = new ReversalService();
