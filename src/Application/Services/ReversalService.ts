import mongoose from 'mongoose';
import Transaction from '../../Domain/Entities/Transaction';
import User from '../../Domain/Entities/User';
import Ledger from '../../Domain/Entities/Ledger';
import JournalEvent from '../../Domain/Entities/JournalEvent';
import logger from '../../../utils/logger';
import eventBus from '../../../services/eventBus';

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

    /**
     * تنفيذ استرجاع كامل لعملية تحويل (Refund / Rollback)
     */
    public async reverseTransaction(txId: string, reason: string, performedBy: string): Promise<{ success: boolean; message: string }> {
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

            if (!targetDoc) {
                await session.abortTransaction();
                return { success: false, message: 'المستفيد غير موجود بالنظام لإرجاع الرصيد' };
            }

            // تحديث رصيد العملة المقابلة في المحفظة متعددة العملات
            const cost = tx.costLYD; // التكلفة بالـ LYD المسترجعة
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
                    performedBy
                }
            });
            await refundEvent.save({ session });

            // 5. تحديث حالة العملية
            tx.status = 'rejected';
            tx.notes = (tx.notes ? `${tx.notes}\n` : '') + `[تم الاسترجاع بواسطة: ${performedBy} | السبب: ${reason}]`;
            await tx.save({ session });

            await session.commitTransaction();
            session.endSession();

            // نشر الأحداث للمنظومة
            eventBus.publish('transfer:cancelled', { tx, reason });
            logger.info(`Transaction ${tx.customId} successfully reversed by ${performedBy}`);

            return { success: true, message: 'تم إلغاء العملية واسترداد الرصيد بنجاح' };
        } catch (error: any) {
            await session.abortTransaction();
            session.endSession();
            logger.error(`Failed to reverse transaction ${txId}`, { error: error.message });
            return { success: false, message: `فشل الاسترجاع: ${error.message}` };
        }
    }
}

export const reversalService = new ReversalService();
