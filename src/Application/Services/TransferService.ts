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
const AgentEmployee = require('../../../models/AgentEmployee');
const Counter = require('../../../models/Counter');
const Settings = require('../../../models/Settings');
const SubAccount = require('../../../models/SubAccount');
const { logAction } = require('../../../services/auditService');
const { getRateForTier, getServiceRatesForTier, getCompanyServiceRates } = require('../../../utils/rateHelper');
const { calculateAgencyPricing } = require('../../../utils/agencyPricing');
const { recordTransferReservation } = require('../../../services/agencyJournalService');
const { getTransferServiceDefinition } = require('../../../utils/mobileTransferServiceCatalog');
const { acquireLock, releaseLock } = require('../../../services/lockService');
const { resolveAutoRouteExecutor, applyAutoRouteFields, enqueueAutoRouteIfNeeded } = require('../../../services/autoRouteService');
const eventBus = require('../../../services/eventBus');
import logger from '../../../utils/logger';

export interface ITransferInput {
    transferType: 'vodafone' | 'post_account' | 'post_card' | 'bank_account' | 'sefa_niger' | 'bankak_sudan';
    amount: number;
    number: string;
    name?: string;
    notes?: string;
    currency?: 'EGP' | 'USD' | 'EUR' | 'LYD' | 'SAR';
    idCardImage?: string;
    oldReceiptImage?: string;
    serviceSubtype?: 'nita' | 'nita_account';
    city?: string;
}

export class TransferService {
    private appendAdminNoteText(current: any, note: string): string {
        const cleanCurrent = String(current || '').trim();
        const cleanNote = String(note || '').trim();
        if (!cleanNote) return cleanCurrent;
        return cleanCurrent ? `${cleanCurrent}\n${cleanNote}` : cleanNote;
    }

    private buildTransferFingerprint(userId: string, accountType: string, input: ITransferInput): string {
        const payload = {
            userId: String(userId),
            accountType,
            transferType: input.transferType,
            amount: Number(Number(input.amount).toFixed(3)),
            number: input.number?.trim() || null,
            name: input.name?.trim() || null,
            notes: input.notes?.trim() || null,
            serviceSubtype: input.serviceSubtype?.trim() || null,
            city: input.city?.trim() || null
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
            const serviceDefinition = getTransferServiceDefinition(transferType);
            if (!serviceDefinition || !serviceDefinition.mobileEnabled) {
                await session.abortTransaction();
                session.endSession();
                return {
                    success: false,
                    statusCode: 400,
                    code: 'UNSUPPORTED_TRANSFER_TYPE',
                    message: 'نوع التحويل غير مدعوم في تطبيق الموبايل'
                };
            }
            const amount = Number(transferData.amount);
            const number = transferData.number?.trim();
            const name = transferData.name?.trim();
            const notes = transferData.notes?.trim();
            const serviceSubtype = transferData.serviceSubtype?.trim();
            const city = transferData.city?.trim();
            const currency = transferData.currency || 'EGP';
            const storedNotes = [
                notes,
                serviceSubtype ? `serviceSubtype=${serviceSubtype}` : null,
                city ? `city=${city}` : null
            ].filter(Boolean).join(' | ');

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
            const autoRouteExecutor = await resolveAutoRouteExecutor(settings, transferType, session);
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
            let isSubAccountTx = !!clientInfo.isSubAccount;
            const serviceRates = clientInfo.companyForRates
                ? getCompanyServiceRates(clientInfo.companyForRates, settings)
                : getServiceRatesForTier(clientInfo.tier || 1, settings);
            let finalRate = serviceRates[transferType] || currentRate;

            let masterRate = 0;
            let actualSubRate = 0;
            let subCostLYD = 0;
            let masterCostLYD = 0;
            let commission = 0;
            let agencyPricing: any = undefined;

            if (isSubAccountTx) {
                const masterObj = clientInfo.masterObj;
                const clientTier = masterObj.tier || 1;
                const masterServiceRates = clientInfo.masterType === 'company'
                    ? getCompanyServiceRates(masterObj, settings)
                    : getServiceRatesForTier(clientTier, settings);
                masterRate = masterServiceRates[transferType]
                    || masterServiceRates.vodafone
                    || getRateForTier(clientTier, settings);

                agencyPricing = calculateAgencyPricing({
                    amountEGP: amount,
                    masterRates: masterServiceRates,
                    serviceKey: transferType,
                    subAccount: clientInfo.subAccount
                });
                masterRate = agencyPricing.agentRate;
                actualSubRate = agencyPricing.customerRate;
                subCostLYD = agencyPricing.customerChargeLYD;
                masterCostLYD = agencyPricing.agentCostLYD;
                commission = agencyPricing.profitLYD;
            }

            const costLYD = isSubAccountTx ? masterCostLYD : parseFloat((amount / finalRate).toFixed(3));
            const minRequiredBalance = costLYD - creditLimit;

            // 6. التحقق من الرصيد والخصم (Multi-Currency Wallet)
            let updatedClient: any;
            let updatedMaster: any;
            const balanceKey = this.balancePath(clientDoc, currency);
            const currentBalance = this.getWalletBalance(clientDoc, currency);

            if (isSubAccountTx) {
                const subAccount = clientInfo.subAccount;
                const masterObj = clientInfo.masterObj;
                const MasterModel = clientInfo.MasterModel;

                const minSubBalance = subCostLYD - (subAccount.creditLimit || 0);
                const minMasterBalance = masterCostLYD - (masterObj.creditLimit || 0);

                // 🟢 الخصم الذري لنقطة البيع
                const updatedSub = await SubAccount.findOneAndUpdate(
                    { _id: subAccount._id, balance: { $gte: minSubBalance } },
                    { $inc: { balance: -subCostLYD } },
                    { new: true, session }
                );
                if (!updatedSub) {
                    await session.abortTransaction();
                    session.endSession();
                    return { success: false, statusCode: 400, code: 'INSUFFICIENT_BALANCE', message: 'رصيد الحساب التابع غير كافٍ لإتمام العملية' };
                }

                // 🟢 الخصم الذري للرئيسي
                updatedMaster = await MasterModel.findOneAndUpdate(
                    { _id: masterObj._id, balance: { $gte: minMasterBalance } },
                    { $inc: { balance: -masterCostLYD } },
                    { new: true, session }
                );
                if (!updatedMaster) {
                    await session.abortTransaction();
                    session.endSession();
                    return { success: false, statusCode: 400, code: 'INSUFFICIENT_BALANCE', message: 'رصيد الحساب الرئيسي غير كافٍ لإتمام العملية' };
                }

                updatedClient = updatedSub;
            } else {
                if (currentBalance < minRequiredBalance) {
                    await session.abortTransaction();
                    session.endSession();
                    return { success: false, statusCode: 400, code: 'INSUFFICIENT_BALANCE', message: 'رصيد المحفظة غير كافٍ لإتمام العملية بالعملة المطلوبة' };
                }

                // خصم الرصيد
                updatedClient = await TargetModel.findOneAndUpdate(
                    { _id: targetId, [balanceKey]: { $gte: minRequiredBalance } },
                    { $inc: { [balanceKey]: -costLYD } },
                    { new: true, session }
                );

                if (!updatedClient) {
                    await session.abortTransaction();
                    session.endSession();
                    return { success: false, statusCode: 400, code: 'INSUFFICIENT_BALANCE', message: 'رصيد غير كافٍ أو تغير أثناء العملية' };
                }
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
                customId,
                userId: userIdForTx,
                companyId: companyIdForTx,
                subAccountId: isSubAccountTx ? clientInfo.subAccount._id : undefined,
                subAccountName: isSubAccountTx ? clientInfo.subAccount.name : undefined,
                companyName: isSubAccountTx ? clientInfo.masterObj.name : companyName,
                employeeName: employeeName,
                vodafoneNumber: number,
                transferType,
                accountName: name,
                accountNumber: number,
                amount,
                costLYD: isSubAccountTx ? masterCostLYD : costLYD,
                subAccountCostLYD: isSubAccountTx ? subCostLYD : 0,
                commission: isSubAccountTx ? commission : 0,
                exchangeRate: isSubAccountTx ? masterRate : finalRate,
                subClientRate: isSubAccountTx ? actualSubRate : 0,
                agencyPricing: isSubAccountTx ? agencyPricing : undefined,
                notes: storedNotes,
                customerNotes: notes || '',
                status: 'pending',
                isSubAccountTx,
                masterProfit: isSubAccountTx ? commission : 0,
                idempotencyKey,
                idempotencyFingerprint,
                idCardImage: savedIdCardPath,
                oldReceiptImage: savedOldReceiptPath,
                executorGroupId: undefined,
                tenantId: (req && req.tenant) ? req.tenant._id : undefined
            });
            if (autoRouteExecutor) applyAutoRouteFields(newTx, autoRouteExecutor);

            if (isSubAccountTx) {
                await recordTransferReservation({
                    transaction: newTx,
                    subAccount: clientInfo.subAccount,
                    ownerId: clientInfo.masterObj._id,
                    actor: {
                        _id: clientDoc._id,
                        model: 'SubAccount',
                        name: clientDoc.name
                    }
                }, session);
            }

            // 9. القيد المزدوج في دفتر الأستاذ (Double-Entry Ledger)
            if (isSubAccountTx) {
                // Ledger لنقطة البيع
                const ledgerSub = new Ledger({
                    entityId: clientInfo.subAccount._id,
                    entityModel: 'SubAccount',
                    transactionId: customId,
                    type: 'TRANSFER',
                    amount: -subCostLYD,
                    debitAccount: 'Liabilities:ClientDeposits',
                    creditAccount: 'Assets:Receivables',
                    balanceBefore: clientInfo.subAccount.balance,
                    balanceAfter: updatedClient.balance,
                    description: `تحويل حوالة مالية بقيمة ${amount} EGP إلى ${number}`
                });
                await ledgerSub.save({ session });

                // Ledger للرئيسي
                const ledgerMaster = new Ledger({
                    entityId: clientInfo.masterObj._id,
                    entityModel: clientInfo.MasterModel.modelName,
                    transactionId: customId,
                    type: 'TRANSFER',
                    amount: -masterCostLYD,
                    debitAccount: 'Liabilities:ClientDeposits',
                    creditAccount: 'Assets:Receivables',
                    balanceBefore: clientInfo.masterObj.balance,
                    balanceAfter: updatedMaster.balance,
                    description: `تحويل من نقطة بيع (${clientInfo.subAccount.name}): ${amount} EGP إلى ${number}`
                });
                await ledgerMaster.save({ session });
            } else {
                const ledgerEntry = new Ledger({
                    entityId: targetId, entityModel: TargetModel.modelName, transactionId: customId,
                    type: 'TRANSFER', amount: -costLYD,
                    debitAccount: 'Liabilities:ClientDeposits',
                    creditAccount: 'Assets:Receivables',
                    balanceBefore: currentBalance, balanceAfter: this.getWalletBalance(updatedClient, currency),
                    description: `تحويل حوالة مالية بقيمة ${amount} EGP - رقم العملية ${customId}`
                });
                await ledgerEntry.save({ session });
            }

            // 10. حفظ الحدث (Event Sourcing)
            const lastEvent = await JournalEvent.findOne({ entityId: targetId }).sort({ sequenceNumber: -1 }).session(session);
            const sequenceNumber = lastEvent ? lastEvent.sequenceNumber + 1 : 1;
            const journalEvent = new JournalEvent({
                eventType: 'MoneyWithdrawn',
                entityId: targetId,
                entityModel: TargetModel.modelName,
                amount: isSubAccountTx ? subCostLYD : costLYD,
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
                status: newTx.status || 'pending',
                transferType,
                transferTypeLabel: serviceDefinition.label,
                costLYD: isSubAccountTx ? subCostLYD : costLYD,
                exchangeRate: isSubAccountTx ? actualSubRate : finalRate,
                newBalance: isSubAccountTx ? updatedClient.balance : this.getWalletBalance(updatedClient, currency),
                serverTime: new Date().toISOString()
            };
            newTx.idempotencyResponse = successBody;
            await newTx.save({ session });

            await session.commitTransaction();
            session.endSession();

            if (autoRouteExecutor) {
                enqueueAutoRouteIfNeeded(newTx, autoRouteExecutor).catch((err: any) => {
                    logger.error('Auto-route enqueue failed', {
                        txId: newTx.customId,
                        error: err.message
                    });
                });
            }

            // نشر الأحداث
            eventBus.publish('transfer:created', { tx: newTx, companyName, employeeName });

            await logAction({
                action: 'TRANSFER_CREATED',
                req,
                performedById: userId,
                performedByModel: accountType === 'client_company' ? 'ClientEmployee' : (accountType === 'agent_staff' ? 'AgentEmployee' : 'User'),
                performedByName: employeeName,
                targetId: newTx._id,
                targetModel: 'Transaction',
                newData: { customId, amount, transferType, costLYD, exchangeRate: isSubAccountTx ? actualSubRate : finalRate },
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

            if (tx.isSubAccountTx) {
                const sub = await SubAccount.findById(tx.subAccountId).session(session);
                if (!sub) throw new Error('SUB_ACCOUNT_NOT_FOUND');

                // 1. استرجاع رصيد الحساب التابع (subAccountCostLYD)
                const updatedSub = await SubAccount.findByIdAndUpdate(
                    tx.subAccountId,
                    { $inc: { balance: tx.subAccountCostLYD } },
                    { new: true, session }
                );
                if (!updatedSub) throw new Error('SUB_ACCOUNT_NOT_FOUND');

                // Ledger لنقاط البيع التابعة
                const ledgerSub = new Ledger({
                    entityId: tx.subAccountId,
                    entityModel: 'SubAccount',
                    transactionId: tx.customId,
                    type: 'REFUND',
                    amount: tx.subAccountCostLYD,
                    debitAccount: 'Assets:Receivables',
                    creditAccount: 'Liabilities:ClientDeposits',
                    balanceBefore: updatedSub.balance - tx.subAccountCostLYD,
                    balanceAfter: updatedSub.balance,
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
                        performedBy: emp.name
                    }
                });
                await subEvent.save({ session });

                // 2. استرجاع رصيد الوكيل الرئيسي (costLYD)
                if (!targetId || !TargetModel) throw new Error('CLIENT_NOT_FOUND');
                const balanceKey = this.balancePath(targetDoc, currency);
                const updatedMaster = await TargetModel.findByIdAndUpdate(
                    targetId,
                    { $inc: { [balanceKey]: tx.costLYD } },
                    { new: true, session }
                );
                if (!updatedMaster) throw new Error('CLIENT_NOT_FOUND');
                const masterRefundedBalance = this.getWalletBalance(updatedMaster, currency);

                // Ledger للوكيل الرئيسي
                const ledgerMaster = new Ledger({
                    entityId: targetId,
                    entityModel: TargetModel.modelName,
                    transactionId: tx.customId,
                    type: 'REFUND',
                    amount: tx.costLYD,
                    debitAccount: 'Assets:Receivables',
                    creditAccount: 'Liabilities:ClientDeposits',
                    balanceBefore: masterRefundedBalance - tx.costLYD,
                    balanceAfter: masterRefundedBalance,
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
                    amount: tx.costLYD,
                    currency,
                    sequenceNumber: masterSeqNum,
                    metadata: {
                        transactionId: tx.customId,
                        reason,
                        performedBy: emp.name
                    }
                });
                await masterEvent.save({ session });

            } else {
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
            }

            tx.status = 'rejected';
            tx.adminNotes = this.appendAdminNoteText(tx.adminNotes, `[تم الإلغاء | المنفذ: ${emp.name} | السبب: ${reason}]`);
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
        let TargetModel: any, targetId: any, creditLimit = 0, tier = 1;
        let userIdForTx = null, companyIdForTx = null;
        let companyForRates: any = null;

        if (accountType === 'client_user') {
            if (req && req.tenant) {
                clientDoc = await User.findOne({ _id: userId, tenantId: req.tenant._id }).session(session);
            } else {
                clientDoc = await User.findById(userId).session(session);
            }
            if (clientDoc) {
                tier = clientDoc.tier || 1;
                currentRate = getRateForTier(tier, settings);
                employeeName = clientDoc.name;
                creditLimit = clientDoc.creditLimit || 0;
                TargetModel = User;
                targetId = clientDoc._id;
                userIdForTx = clientDoc.phone || clientDoc.webUsername;
            }
        } else if (accountType === 'sub_client') {
            clientDoc = await SubAccount.findById(userId).session(session);
            if (clientDoc) {
                if (clientDoc.status !== 'active') return null;
                let masterObj: any;
                let MasterModel: any;
                if (clientDoc.masterType === 'user') {
                    masterObj = await User.findById(clientDoc.masterId).session(session);
                    MasterModel = User;
                } else {
                    masterObj = await ClientCompany.findById(clientDoc.masterId).session(session);
                    MasterModel = ClientCompany;
                }
                if (masterObj) {
                    if (masterObj.status && masterObj.status !== 'active') return null;
                    employeeName = clientDoc.name;
                    companyName = masterObj.name;
                    tier = masterObj.tier || 1;
                    companyForRates = clientDoc.masterType === 'company' ? masterObj : null;
                    currentRate = companyForRates
                        ? getCompanyServiceRates(companyForRates, settings).vodafone
                        : getRateForTier(tier, settings);
                    creditLimit = clientDoc.creditLimit || 0;
                    TargetModel = SubAccount;
                    targetId = clientDoc._id;
                    userIdForTx = clientDoc.masterType === 'user' ? (masterObj.telegramId || masterObj.phone || masterObj.webUsername) : null;
                    companyIdForTx = clientDoc.masterType === 'company' ? masterObj._id : null;

                    return {
                        clientDoc, currentRate, companyName, employeeName,
                        TargetModel, targetId, creditLimit,
                        userIdForTx, companyIdForTx,
                        tier,
                        isSubAccount: true,
                        subAccount: clientDoc,
                        masterObj,
                        MasterModel,
                        masterType: clientDoc.masterType,
                        companyForRates,
                        customMargin: clientDoc.customMargin || 0
                    };
                }
            }
        } else if (accountType === 'agent_staff') {
            const emp = await AgentEmployee.findById(userId).session(session);
            if (emp && emp.status === 'active' && emp.role !== 'accountant') {
                const agent = await User.findById(emp.agentId).session(session);
                if (agent && agent.status === 'active' && agent.role === 'agent') {
                    employeeName = emp.name || emp.webUsername || 'موظف وكيل';
                    clientDoc = agent;
                    companyName = agent.name || agent.webUsername || 'وكيل';
                    tier = agent.tier || 1;
                    currentRate = getRateForTier(tier, settings);
                    creditLimit = agent.creditLimit || 0;
                    TargetModel = User;
                    targetId = agent._id;
                    userIdForTx = agent.phone || agent.webUsername;
                }
            }
        } else {
            const emp = await ClientEmployee.findById(userId).session(session);
            if (emp) {
                employeeName = emp.name;
                clientDoc = await ClientCompany.findById(emp.companyId).session(session);
                if (clientDoc) {
                    companyName = clientDoc.name;
                    tier = clientDoc.tier || 1;
                    companyForRates = clientDoc;
                    currentRate = getCompanyServiceRates(companyForRates, settings).vodafone;
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
            userIdForTx, companyIdForTx,
            tier,
            companyForRates
        };
    }
}

export const transferService = new TransferService();
