import mongoose from 'mongoose';
import crypto from 'crypto';
import User from '../../Domain/Entities/User';
import Employee from '../../Domain/Entities/Employee';
import Transaction from '../../Domain/Entities/Transaction';
import Ledger from '../../Domain/Entities/Ledger';
import JournalEvent from '../../Domain/Entities/JournalEvent';
import { fraudDetectionEngine } from './FraudDetectionEngine';
import { amlSanctionsService } from './AmlSanctionsService';

// استيراد النماذج القديمة بالـ CommonJS بشكل مؤقت
const ClientEmployee = require('../../../models/ClientEmployee');
const ClientCompany = require('../../../models/ClientCompany');
const Counter = require('../../../models/Counter');
const Settings = require('../../../models/Settings');
const { logAction } = require('../../../services/auditService');
const { getRateForTier } = require('../../../utils/rateHelper');
const { acquireLock, releaseLock } = require('../../../services/lockService');
const eventBus = require('../../../services/eventBus');
import logger from '../../../utils/logger';

export interface ITransferInput {
    transferType: 'vodafone' | 'post_account' | 'post_card';
    amount: number;
    number: string;
    name?: string;
    notes?: string;
    currency?: 'EGP' | 'USD' | 'EUR' | 'LYD' | 'SAR';
    idCardImage?: string;
    oldReceiptImage?: string;
}

export class TransferService {
    private buildTransferFingerprint(userId: string, accountType: string, input: ITransferInput): string {
        const payload = {
            userId: String(userId),
            accountType,
            transferType: input.transferType,
            amount: Number(Number(input.amount).toFixed(3)),
            number: input.number?.trim() || null,
            name: input.name?.trim() || null,
            notes: input.notes?.trim() || null
        };
        return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    }

    private hasCurrencyBalance(doc: any, currency: string): boolean {
        if (Number.isFinite(Number(doc?.balance))) return false;
        const balances = doc?.balances;
        if (!balances) return false;
        if (typeof balances.get === 'function') {
            return Number.isFinite(Number(balances.get(currency)));
        }
        return Object.prototype.hasOwnProperty.call(balances, currency)
            && Number.isFinite(Number(balances[currency]));
    }

    private getWalletBalance(doc: any, currency: string): number {
        if (Number.isFinite(Number(doc?.balance))) {
            return Number(doc.balance);
        }
        if (this.hasCurrencyBalance(doc, currency)) {
            const balances = doc.balances;
            const value = typeof balances.get === 'function' ? balances.get(currency) : balances[currency];
            return Number(value) || 0;
        }
        return Number(doc?.balance) || 0;
    }

    private balancePath(doc: any, currency: string): string {
        return this.hasCurrencyBalance(doc, currency) ? `balances.${currency}` : 'balance';
    }

    private toReplayResponse(tx: any) {
        if (tx.idempotencyResponse) {
            return {
                success: true,
                statusCode: 200,
                ...tx.idempotencyResponse,
                code: 'DUPLICATE_REPLAYED',
                message: 'تم استرجاع نتيجة طلب سابق بنفس مفتاح منع التكرار'
            };
        }
        return {
            success: true,
            statusCode: 200,
            code: 'DUPLICATE_REPLAYED',
            message: 'تم استرجاع نتيجة طلب سابق بنفس مفتاح منع التكرار',
            txId: tx.customId,
            status: tx.status || 'pending',
            costLYD: tx.costLYD,
            exchangeRate: tx.exchangeRate,
            newBalance: null,
            serverTime: new Date().toISOString()
        };
    }

    /**
     * إنشاء تحويل جديد ممتثل للضوابط المالية والأمنية الدولية
     */
    public async createTransfer(params: {
        userId: string;
        accountType: string;
        transferData: ITransferInput;
        req: any;
    }): Promise<any> {
        const { userId, accountType, transferData, req } = params;

        if (accountType === 'executor') {
            return { success: false, statusCode: 403, code: 'FORBIDDEN', message: 'صلاحيات غير كافية' };
        }

        const idempotencyKey = req && req.headers ? req.headers['idempotency-key'] : null;
        const lockKey = idempotencyKey ? `idemp:${idempotencyKey}` : `user:${userId}`;
        let lock: any;

        try {
            lock = await acquireLock(lockKey, 10000);
        } catch (_lockError) {
            return { success: false, statusCode: 429, code: 'LOCK_TIMEOUT', message: 'الرجاء الانتظار، هناك عملية جارية حالياً على حسابك' };
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const transferType = transferData.transferType;
            const amount = Number(transferData.amount);
            const number = transferData.number?.trim();
            const name = transferData.name?.trim();
            const notes = transferData.notes?.trim();
            const currency = transferData.currency || 'EGP';

            const idempotencyFingerprint = this.buildTransferFingerprint(userId, accountType, transferData);

            // 1. التحقق من منع التكرار (Idempotency)
            if (idempotencyKey) {
                const existingTx = await Transaction.findOne({ idempotencyKey }).session(session);
                if (existingTx) {
                    if (existingTx.idempotencyFingerprint === idempotencyFingerprint) {
                        await session.abortTransaction();
                        session.endSession();
                        return this.toReplayResponse(existingTx);
                    }
                    await session.abortTransaction();
                    session.endSession();
                    return {
                        success: false,
                        statusCode: 409,
                        code: 'IDEMPOTENCY_CONFLICT',
                        message: 'مفتاح منع التكرار مستخدم لطلب مختلف'
                    };
                }
            }

            const settings = await Settings.findOne({}).session(session);
            if (settings && settings.isManualClosed) {
                await session.abortTransaction();
                session.endSession();
                return { success: false, statusCode: 403, code: 'SYSTEM_CLOSED', message: 'المنظومة مغلقة حالياً' };
            }

            // 2. فحص الهوية والعميل
            const clientInfo = await this.resolveClient(userId, accountType, settings, session, req);
            if (!clientInfo) {
                await session.abortTransaction();
                session.endSession();
                return { success: false, statusCode: 404, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' };
            }

            const { clientDoc, currentRate, companyName, employeeName, TargetModel, targetId, creditLimit, userIdForTx, companyIdForTx } = clientInfo;

            // 3. محرك الاحتيال وفحص موثوقية الجهاز (Fraud & Device Trust)
            const isTrustedDevice = req.isDeviceTrusted !== undefined ? req.isDeviceTrusted : true;
            const fraudResult = await fraudDetectionEngine.evaluateTransaction(userId, amount, isTrustedDevice);
            if (fraudResult.isFraudulent) {
                await session.abortTransaction();
                session.endSession();
                return {
                    success: false,
                    statusCode: 400,
                    code: 'FRAUD_DETECTED',
                    message: `تم تعليق طلبك لحماية حسابك: ${fraudResult.reason}`
                };
            }

            // 4. الامتثال ومكافحة غسل الأموال وقوائم العقوبات (AML & Sanctions)
            const fullName = clientDoc.name || 'Unknown Name';
            const country = req.headers['x-country-code'] || 'Egypt';
            const sanctionsResult = await amlSanctionsService.screenSanctions(fullName, country);
            if (!sanctionsResult.passed) {
                await session.abortTransaction();
                session.endSession();
                return {
                    success: false,
                    statusCode: 400,
                    code: 'SANCTIONS_HIT',
                    message: 'تم حظر العملية مؤقتاً لمراجعة إدارة الامتثال والتحقق من الهوية'
                };
            }

            const amlResult = await amlSanctionsService.checkAmlRules(amount, currency, 0);
            if (!amlResult.passed) {
                await session.abortTransaction();
                session.endSession();
                return {
                    success: false,
                    statusCode: 400,
                    code: 'AML_ALERT',
                    message: `فشل التحقق من لوائح مكافحة غسيل الأموال: ${amlResult.reason}`
                };
            }

            // 5. حساب الرسوم والأسعار
            let finalRate = currentRate;
            if (transferType === 'post_account') finalRate = currentRate - 0.05;
            else if (transferType === 'post_card') finalRate = currentRate - 0.15;

            const costLYD = parseFloat((amount / finalRate).toFixed(3));
            const minRequiredBalance = costLYD - creditLimit;

            // 6. التحقق من الرصيد والخصم (Multi-Currency Wallet)
            const balanceKey = this.balancePath(clientDoc, currency);
            const currentBalance = this.getWalletBalance(clientDoc, currency);

            if (currentBalance < minRequiredBalance) {
                await session.abortTransaction();
                session.endSession();
                return { success: false, statusCode: 400, code: 'INSUFFICIENT_BALANCE', message: 'رصيد المحفظة غير كافٍ لإتمام العملية بالعملة المطلوبة' };
            }

            // خصم الرصيد
            const updatedClient = await TargetModel.findOneAndUpdate(
                { _id: targetId, [balanceKey]: { $gte: minRequiredBalance } },
                { $inc: { [balanceKey]: -costLYD } },
                { new: true, session }
            );

            if (!updatedClient) {
                await session.abortTransaction();
                session.endSession();
                return { success: false, statusCode: 400, code: 'INSUFFICIENT_BALANCE', message: 'رصيد غير كافٍ أو تغير أثناء العملية' };
            }

            // 7. توليد رقم العملية (ATT Invoice ID)
            const counter = await Counter.findOneAndUpdate(
                { name: 'transaction' }, { $inc: { value: 1 } }, { upsert: true, new: true, session }
            );
            const now = new Date();
            const yy = now.getFullYear().toString().slice(-2);
            const mm = (now.getMonth() + 1).toString().padStart(2, '0');
            const customId = `ATT-${yy}${mm}-${counter.value.toString().padStart(4, '0')}`;

            // 8. إنشاء العملية وحفظها
            const { saveProofImage } = require('../../../services/proofStorageService');
            let savedIdCardPath = undefined;
            let savedOldReceiptPath = undefined;

            if (transferData.idCardImage) {
                savedIdCardPath = saveProofImage(transferData.idCardImage, `idcard_${customId}`);
            }
            if (transferData.oldReceiptImage) {
                savedOldReceiptPath = saveProofImage(transferData.oldReceiptImage, `oldreceipt_${customId}`);
            }

            const newTx = new Transaction({
                userId: userIdForTx, companyId: companyIdForTx, amount, exchangeRate: finalRate,
                costLYD, transferType, vodafoneNumber: number, accountName: name, notes,
                status: 'pending', customId, companyName, employeeName,
                idempotencyKey,
                idempotencyFingerprint,
                idCardImage: savedIdCardPath,
                oldReceiptImage: savedOldReceiptPath,
                executorGroupId: (settings && settings.autoRouteEnabled && settings.autoRouteBotId) ? settings.autoRouteBotId : undefined,
                tenantId: (req && req.tenant) ? req.tenant._id : undefined
            });

            // 9. القيد المزدوج في دفتر الأستاذ (Double-Entry Ledger)
            const ledgerEntry = new Ledger({
                entityId: targetId, entityModel: TargetModel.modelName, transactionId: customId,
                type: 'TRANSFER', amount: -costLYD,
                debitAccount: 'Liabilities:ClientDeposits',
                creditAccount: 'Assets:Receivables',
                balanceBefore: currentBalance, balanceAfter: this.getWalletBalance(updatedClient, currency),
                description: `تحويل حوالة مالية بقيمة ${amount} EGP - رقم العملية ${customId}`
            });
            await ledgerEntry.save({ session });

            // 10. حفظ الحدث (Event Sourcing)
            const lastEvent = await JournalEvent.findOne({ entityId: targetId }).sort({ sequenceNumber: -1 }).session(session);
            const sequenceNumber = lastEvent ? lastEvent.sequenceNumber + 1 : 1;
            const journalEvent = new JournalEvent({
                eventType: 'MoneyWithdrawn',
                entityId: targetId,
                entityModel: TargetModel.modelName,
                amount: costLYD,
                currency: 'LYD',
                sequenceNumber,
                metadata: {
                    transactionId: customId,
                    action: 'TRANSFER_CREATED'
                }
            });
            await journalEvent.save({ session });

            const successBody = {
                code: 'SUCCESS',
                message: 'تم إرسال طلبك بنجاح',
                txId: customId,
                status: 'pending',
                costLYD,
                exchangeRate: finalRate,
                newBalance: this.getWalletBalance(updatedClient, currency),
                serverTime: new Date().toISOString()
            };
            newTx.idempotencyResponse = successBody;
            await newTx.save({ session });

            await session.commitTransaction();
            session.endSession();

            // نشر الأحداث
            eventBus.publish('transfer:created', { tx: newTx, companyName, employeeName });

            await logAction({
                action: 'TRANSFER_CREATED',
                req,
                performedById: userId,
                performedByModel: accountType === 'client_company' ? 'ClientEmployee' : 'User',
                performedByName: employeeName,
                targetId: newTx._id,
                targetModel: 'Transaction',
                newData: { customId, amount, transferType, costLYD, exchangeRate: finalRate },
                metadata: { companyName, balance: this.getWalletBalance(updatedClient, currency) }
            });

            (logger as any).financial('Transfer created successfully', {
                customId, amount, costLYD, transferType, accountType
            });

            return {
                success: true,
                statusCode: 200,
                ...successBody
            };
        } catch (error: any) {
            try { await session.abortTransaction(); session.endSession(); } catch (_) {}
            logger.error('Transfer creation failed', { error: error.message, accountType });
            return { success: false, statusCode: 500, code: 'SERVER_ERROR', message: 'حدث خطأ داخلي أثناء معالجة طلب التحويل' };
        } finally {
            await releaseLock(lock);
        }
    }

    /**
     * إلغاء مهمة وإرجاع الرصيد مع قيود دفتر الأستاذ والأحداث
     */
    public async cancelTransfer(params: {
        taskId: string;
        userId: string;
        reason: string;
        req?: any;
    }): Promise<any> {
        const { taskId, userId, reason, req } = params;
        const lockKey = `tx:${taskId}`;
        let lock: any;

        try {
            lock = await acquireLock(lockKey, 10000);
        } catch (_lockError) {
            return { success: false, statusCode: 429, code: 'LOCK_TIMEOUT', message: 'الرجاء الانتظار، العملية قيد المعالجة حالياً' };
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            let tx: any;
            if (req && req.tenant) {
                tx = await Transaction.findOne({ _id: taskId, tenantId: req.tenant._id }).session(session);
            } else {
                tx = await Transaction.findById(taskId).session(session);
            }

            const empQuery: any = { webUsername: userId };
            if (req && req.tenant) empQuery.tenantId = req.tenant._id;
            const emp = await Employee.findOne(empQuery).session(session);

            if (!emp) throw new Error('EMPLOYEE_NOT_FOUND');
            if (!tx || tx.status !== 'accepted' || tx.operatorId !== emp._id.toString()) {
                throw new Error('INVALID_STATE');
            }

            // تحديد المحفظة ونوع العملة لإعادة شحنها
            let targetId: any;
            let TargetModel: any;
            let targetDoc: any = null;
            const currency = 'EGP'; // العملة الافتراضية للعميل

            if (tx.companyId) {
                TargetModel = ClientCompany;
                targetId = tx.companyId;
                targetDoc = { balance: 0 };
            } else if (tx.userId) {
                TargetModel = User;
                const u = await User.findOne({ phone: tx.userId }).session(session);
                if (u) {
                    targetId = u._id;
                    targetDoc = u;
                }
            }

            if (!targetId || !TargetModel) throw new Error('CLIENT_NOT_FOUND');

            // إرجاع الرصيد
            const balanceKey = this.balancePath(targetDoc, currency);
            const updatedClient = await TargetModel.findByIdAndUpdate(
                targetId, { $inc: { [balanceKey]: tx.costLYD } }, { new: true, session }
            );
            if (!updatedClient) throw new Error('CLIENT_NOT_FOUND');
            const refundedBalance = this.getWalletBalance(updatedClient, currency);

            // تسجيل المرتجع في دفتر الأستاذ
            const ledgerEntry = new Ledger({
                entityId: targetId, entityModel: TargetModel.modelName, transactionId: tx.customId,
                type: 'REFUND', amount: tx.costLYD,
                debitAccount: 'Assets:Receivables',
                creditAccount: 'Liabilities:ClientDeposits',
                balanceBefore: refundedBalance - tx.costLYD, balanceAfter: refundedBalance,
                description: `استرجاع تكلفة حوالة ملغاة رقم ${tx.customId} (السبب: ${reason})`
            });
            await ledgerEntry.save({ session });

            // حفظ حدث الإلغاء (Event Sourcing)
            const lastEvent = await JournalEvent.findOne({ entityId: targetId }).sort({ sequenceNumber: -1 }).session(session);
            const sequenceNumber = lastEvent ? lastEvent.sequenceNumber + 1 : 1;
            const journalEvent = new JournalEvent({
                eventType: 'TransferReversed',
                entityId: targetId,
                entityModel: TargetModel.modelName,
                amount: tx.costLYD,
                currency: 'LYD',
                sequenceNumber,
                metadata: {
                    transactionId: tx.customId,
                    reason,
                    performedBy: emp.name
                }
            });
            await journalEvent.save({ session });

            tx.status = 'rejected';
            tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم الإلغاء | المنفذ: ${emp.name} | السبب: ${reason}]`;
            await tx.save({ session });

            await session.commitTransaction();
            session.endSession();

            eventBus.publish('transfer:cancelled', { tx, emp, reason });

            await logAction({
                action: 'TRANSFER_CANCELLED',
                req,
                performedById: emp._id,
                performedByModel: 'Employee',
                performedByName: emp.name,
                targetId: tx._id,
                targetModel: 'Transaction',
                oldData: { status: 'accepted', costLYD: tx.costLYD },
                newData: { status: 'rejected', reason },
                metadata: { customId: tx.customId, refundAmount: tx.costLYD }
            });

            (logger as any).financial('Transfer cancelled and refunded', {
                customId: tx.customId, executor: emp.name, reason, refund: tx.costLYD
            });

            return { success: true, statusCode: 200, message: 'تم الإلغاء وإرجاع الرصيد بنجاح' };
        } catch (e: any) {
            try { await session.abortTransaction(); session.endSession(); } catch (_) {}
            const code = e.message === 'INVALID_STATE' ? 'INVALID_STATE' : 'SERVER_ERROR';
            return { success: false, statusCode: 500, code, message: `فشل الإلغاء: ${e.message}` };
        } finally {
            await releaseLock(lock);
        }
    }

    private async resolveClient(userId: string, accountType: string, settings: any, session: any, req: any) {
        let clientDoc: any, currentRate = 0, companyName = 'عميل فردي', employeeName = 'غير محدد';
        let TargetModel: any, targetId: any, creditLimit = 0;
        let userIdForTx = null, companyIdForTx = null;

        if (accountType === 'client_user') {
            if (req && req.tenant) {
                clientDoc = await User.findOne({ _id: userId, tenantId: req.tenant._id }).session(session);
            } else {
                clientDoc = await User.findById(userId).session(session);
            }
            if (clientDoc) {
                const tier = clientDoc.tier || 1;
                currentRate = getRateForTier(tier, settings);
                employeeName = clientDoc.name;
                creditLimit = clientDoc.creditLimit || 0;
                TargetModel = User;
                targetId = clientDoc._id;
                userIdForTx = clientDoc.phone || clientDoc.webUsername;
            }
        } else {
            const emp = await ClientEmployee.findById(userId).session(session);
            if (emp) {
                employeeName = emp.name;
                clientDoc = await ClientCompany.findById(emp.companyId).session(session);
                if (clientDoc) {
                    companyName = clientDoc.name;
                    const tier = clientDoc.tier || 1;
                    currentRate = getRateForTier(tier, settings);
                    creditLimit = clientDoc.creditLimit || 0;
                    TargetModel = ClientCompany;
                    targetId = clientDoc._id;
                    companyIdForTx = clientDoc._id;
                }
            }
        }

        if (!clientDoc) return null;

        return {
            clientDoc, currentRate, companyName, employeeName,
            TargetModel, targetId, creditLimit,
            userIdForTx, companyIdForTx
        };
    }
}

export const transferService = new TransferService();
