// services/queueService.js
const fs = require('fs');
const path = require('path');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const Admin = require('../models/Admin');
const Employee = require('../models/Employee');
const { executeTransferViaApi, generateCustomReceipt } = require('./externalApiService');
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
                    let exactRefNumber = apiResult.sender_number || apiResult.external_transaction_id || '';
                    if (apiResult.processLog && !exactRefNumber) { 
                        const refMatch = apiResult.processLog.match(/"RefTransactionNumber"\s*:\s*"([^"]+)"/); 
                        if (refMatch && refMatch[1]) exactRefNumber = refMatch[1]; 
                    }
                    const hasAsterisk = exactRefNumber.includes('*');

                    if (hasAsterisk) {
                        tx.status = 'completed'; 
                        tx.executorName = 'تنفيذ آلي (API)';
                        tx.executorSenderPhone = exactRefNumber;
                        appendCustomerReference(tx, 'الرقم المرجعي', exactRefNumber);
                        appendAdminNote(tx, `[نجاح آلي | المرجع: ${exactRefNumber}]`);
                        if (detailedLog) appendAdminNote(tx, detailedLog);

                        await updateBalanceWithLedger('ExecutorGroup', executorGroup._id, -tx.amount, 'TRANSFER', tx.customId, 'تنفيذ API آلي');

                        // 🟢 1. توليد الصورة من الـ API وحفظها في الهارد ديسك فقط
                        const receiptBuffer = await generateCustomReceipt(tx, apiResult);
                        let localImagePath = null;

                        if (receiptBuffer) {
                            try {
                                const uploadDir = path.join(process.cwd(), 'uploads', 'proofs');
                                if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                                const fileName = `api_proof_${tx._id}_${Date.now()}.jpg`;
                                const fullLocalPath = path.join(uploadDir, fileName);
                                
                                fs.writeFileSync(fullLocalPath, receiptBuffer);
                                localImagePath = `/uploads/proofs/${fileName}`;
                                
                                tx.proofImage = localImagePath;
                                tx.proofImages = [localImagePath];
                                tx.set('localProofImage', localImagePath, { strict: false });
                            } catch (fileErr) {
                                logger.error('[API File Save Error]:', fileErr.message);
                            }
                        }

                        await tx.save(); 
                        logger.info('API Execution Successful', { txId: tx.customId, exactRefNumber });
                    } else {
                        tx.status = 'pending'; 
                        tx.executorGroupId = executorGroup._id; 
                        tx.executorName = 'في انتظار تحديث (API)';
                        appendCustomerReference(tx, 'الرقم المرجعي', exactRefNumber);
                        appendAdminNote(tx, `[في الانتظار - بانتظار رقم مرجعي مشفر من الـ API | المرجع الحالي: ${exactRefNumber}]`);
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
