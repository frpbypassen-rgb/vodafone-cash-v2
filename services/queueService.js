// services/queueService.js
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const Admin = require('../models/Admin');
const Employee = require('../models/Employee');
const { executeTransferViaApi, saveApiReceiptProof } = require('./externalApiService');
const { updateBalanceWithLedger } = require('./walletService');
const logger = require('../utils/logger');

const appendNoteText = (current, note) => {
    const cleanNote = String(note || '').trim();
    if (!cleanNote) return current || '';
    return current ? `${current}\n${cleanNote}` : cleanNote;
};

const appendAdminNote = (tx, note) => {
    tx.adminNotes = appendNoteText(tx.adminNotes, note);
};

const appendCustomerReference = (tx, label, value) => {
    const cleanValue = String(value || '').trim();
    if (!cleanValue) return;
    const line = `[${label}: ${cleanValue}]`;
    if (!String(tx.notes || '').includes(line)) {
        tx.notes = appendNoteText(tx.notes, line);
    }
};

class ApiTransferQueue {
    constructor() { this.queue = []; this.isProcessing = false; }

    async addJob(txId, apiGroupId) {
        this.queue.push({ txId, apiGroupId });
        this.processQueue();
    }

    async processSingleJob(txId, apiGroupId) {
        try {
            const tx = await Transaction.findById(txId);
            const executorGroup = await ExecutorGroup.findById(apiGroupId);

            if (tx && executorGroup && tx.status === 'processing') {
                const apiResult = await executeTransferViaApi(tx, executorGroup);
                const detailedLog = apiResult.processLog ? `--- سجل الـ API ---\n${apiResult.processLog}` : '';

                if (apiResult.success === true) {
                    let exactRefNumber = apiResult.reference_number || apiResult.sender_number || apiResult.external_transaction_id || '';
                    if (apiResult.processLog && !exactRefNumber) { 
                        const refMatch = apiResult.processLog.match(/"RefTransactionNumber"\s*:\s*"([^"]+)"/); 
                        if (refMatch && refMatch[1]) exactRefNumber = refMatch[1]; 
                    }
                    exactRefNumber = String(exactRefNumber || '').trim();

                    if (exactRefNumber) {
                        tx.status = 'completed'; 
                        tx.executorName = 'تنفيذ آلي (API)';
                        tx.executorSenderPhone = exactRefNumber;
                        appendCustomerReference(tx, 'الرقم المرجعي', exactRefNumber);
                        if (apiResult.external_transaction_id && apiResult.external_transaction_id !== exactRefNumber) {
                            appendCustomerReference(tx, 'رقم عملية المزود', apiResult.external_transaction_id);
                        }
                        appendAdminNote(tx, `[نجاح آلي | الرقم المرجعي: ${exactRefNumber} | رقم عملية المزود: ${apiResult.external_transaction_id || '---'}]`);
                        if (detailedLog) appendAdminNote(tx, detailedLog);

                        await updateBalanceWithLedger('ExecutorGroup', executorGroup._id, -tx.amount, 'TRANSFER', tx.customId, 'تنفيذ API آلي');

                        try {
                            const receiptProof = await saveApiReceiptProof(tx, apiResult);
                            if (receiptProof) {
                                tx.proofImage = receiptProof;
                                tx.proofImages = [receiptProof];
                                tx.set('localProofImage', receiptProof, { strict: false });
                            } else {
                                appendAdminNote(tx, '[تنبيه: تم تنفيذ API بنجاح لكن تعذر توليد صورة الإيصال]');
                            }
                        } catch (fileErr) {
                            logger.error('[API File Save Error]:', fileErr.message);
                            appendAdminNote(tx, `[تعذر توليد إيصال API: ${fileErr.message}]`);
                        }

                        await tx.save(); 
                        logger.info('API Execution Successful', { txId: tx.customId, exactRefNumber });
                    } else {
                        tx.status = 'pending'; 
                        tx.executorGroupId = executorGroup._id; 
                        tx.executorName = 'في انتظار رقم مرجعي (API)';
                        appendCustomerReference(tx, 'الرقم المرجعي', exactRefNumber);
                        appendAdminNote(tx, '[في الانتظار - تم تنفيذ طلب API بدون رقم مرجعي واضح]');
                        if (detailedLog) appendAdminNote(tx, detailedLog);
                        tx.set('isApiReview', undefined, { strict: false }); 
                        tx.set('apiResultData', undefined, { strict: false }); 
                        tx.set('originalApiGroupId', undefined, { strict: false });
                        await tx.save();
                        
                        logger.info('API Execution Pending Verification', { txId: tx.customId });

                        // Send WhatsApp Alert!
                        try {
                            const { sendWhatsAppAlert } = require('./whatsappService');
                            await sendWhatsAppAlert(tx, apiResult);
                        } catch (waErr) {
                            logger.error('[API WhatsApp Alert Error]:', waErr.message);
                        }
                    }
                } else if (apiResult.success === 'pending') {
                    tx.status = 'pending';
                    appendCustomerReference(tx, 'الرقم المرجعي', apiResult.external_transaction_id);
                    appendAdminNote(tx, `[العملية معلقة بانتظار شبكة المحمول | المرجع: ${apiResult.external_transaction_id}]`);
                    if (detailedLog) appendAdminNote(tx, detailedLog);
                    tx.executorGroupId = executorGroup._id; tx.executorName = executorGroup.name; await tx.save();
                    
                    logger.info('API Execution Network Pending', { txId: tx.customId });
                } else {
                    tx.status = 'pending';
                    appendAdminNote(tx, `[فشل التنفيذ الآلي: ${apiResult.message}]`);
                    if (detailedLog) appendAdminNote(tx, detailedLog);
                    tx.executorGroupId = undefined; tx.executorName = undefined; await tx.save();
                    
                    logger.error('API Execution Failed', { txId: tx.customId, error: apiResult.message });
                }
            }
        } catch (error) {
            try {
                const tx = await Transaction.findById(txId);
                if (tx) {
                    tx.status = 'pending'; tx.executorGroupId = undefined; tx.executorName = undefined;
                    appendAdminNote(tx, `[خطأ داخلي في السيرفر أثناء المعالجة: ${error.message}]`);
                    await tx.save();
                    logger.error('API Queue Processing Error', { txId: tx.customId, error: error.message });
                }
            } catch(e) {}
        }
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;
        const job = this.queue.shift();

        await this.processSingleJob(job.txId, job.apiGroupId);

        this.isProcessing = false;
        setTimeout(() => this.processQueue(), 2000); 
    }
}
module.exports = new ApiTransferQueue();
