import logger from '../../../utils/logger';

export interface IKycDocumentInput {
    documentType: 'id_card' | 'passport' | 'selfie';
    fileUrl: string;
    documentNumber?: string;
    fullName: string;
    expiryDate?: Date;
}

export interface IKycStatusResult {
    status: 'pending' | 'verified' | 'rejected';
    verificationDate?: Date;
    reason?: string;
}

export class KycService {
    private kycRecords: Map<string, IKycDocumentInput[]> = new Map();
    private kycStatuses: Map<string, IKycStatusResult> = new Map();

    /**
     * تقديم مستند جديد للتحقق من هوية العميل (KYC)
     */
    public async submitDocument(userId: string, input: IKycDocumentInput): Promise<{ success: boolean; message: string }> {
        if (!input.fullName || !input.fileUrl) {
            return { success: false, message: 'بيانات المستند غير مكتملة' };
        }

        if (!this.kycRecords.has(userId)) {
            this.kycRecords.set(userId, []);
        }

        this.kycRecords.get(userId)!.push(input);
        this.kycStatuses.set(userId, { status: 'pending' });

        logger.info(`KYC document submitted for user ${userId}. Status: PENDING`, {
            documentType: input.documentType,
            fullName: input.fullName
        });

        return { success: true, message: 'تم تقديم مستند الهوية بنجاح وهو قيد المراجعة' };
    }

    /**
     * الحصول على حالة التحقق الحالية للعميل
     */
    public async getKycStatus(userId: string): Promise<IKycStatusResult> {
        if (!this.kycStatuses.has(userId)) {
            return { status: 'pending' }; // إذا لم يقدم مستندات، يعتبر قيد الانتظار أو غير مكتمل
        }
        return this.kycStatuses.get(userId)!;
    }

    /**
     * تدقيق وتعديل حالة التحقق من هوية العميل يدوياً (للمشرفين)
     */
    public async updateKycStatus(userId: string, status: 'verified' | 'rejected', reason?: string): Promise<void> {
        this.kycStatuses.set(userId, {
            status,
            verificationDate: new Date(),
            reason
        });
        logger.info(`KYC Status updated for user ${userId} to ${status.toUpperCase()}`, { reason });
    }
}

export const kycService = new KycService();
