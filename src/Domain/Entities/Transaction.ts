import mongoose, { Schema, Document } from 'mongoose';

export interface ITransaction extends Document {
    customId: string;
    idempotencyKey?: string;
    idempotencyFingerprint?: string;
    idempotencyResponse?: any;
    editIdempotencyKey?: string;
    editIdempotencyFingerprint?: string;
    editIdempotencyResponse?: any;
    zaynpayIdempotencyKey?: string;
    zaynpayIdempotencyFingerprint?: string;
    zaynpayIdempotencyResponse?: any;
    userId?: string;
    companyId?: mongoose.Types.ObjectId;
    subAccountId?: mongoose.Types.ObjectId;
    companyName?: string;
    employeeName?: string;
    subAccountName?: string;
    isSubAccountTx: boolean;
    transferType: string;
    vodafoneNumber?: string;
    accountNumber?: string;
    accountName?: string;
    amount: number;
    costLYD: number;
    subAccountCostLYD: number;
    commission: number;
    masterProfit: number;
    exchangeRate: number;
    subClientRate: number;
    agencyPricing?: any;
    settlementDetails?: any;
    status: 'pending' | 'processing' | 'accepted' | 'completed' | 'rejected' | 'deposit_pending' | 'deposit' | 'deduction' | 'cancelled_by_admin';
    executorGroupId?: mongoose.Types.ObjectId;
    managerGroupId?: mongoose.Types.ObjectId;
    executorReceivedAt?: Date;
    executorGroupName?: string;
    operatorId?: string;
    executorName: string;
    executorSenderPhone?: string;
    isApiReview?: boolean;
    apiResultData?: any;
    originalApiGroupId?: mongoose.Types.ObjectId;
    notes?: string;
    adminNotes?: string;
    complaintText?: string;
    emergencyAlert?: string;
    executorWebAlert?: any;
    cancellationNumber?: string;
    cancellationReason?: string;
    cancelledBy?: string;
    cancelledAt?: Date;
    proofImage?: string;
    proofImages: string[];
    idCardImage?: string;
    resolutionImage?: string;
    tenantId?: mongoose.Types.ObjectId;
}

const transactionSchema = new Schema<ITransaction>({
    customId: { type: String, unique: true, required: true },
    idempotencyKey: { type: String, unique: true, sparse: true }, 
    idempotencyFingerprint: { type: String },
    idempotencyResponse: { type: Object },
    editIdempotencyKey: { type: String, unique: true, sparse: true }, 
    editIdempotencyFingerprint: { type: String },
    editIdempotencyResponse: { type: Object },
    zaynpayIdempotencyKey: { type: String, unique: true, sparse: true }, 
    zaynpayIdempotencyFingerprint: { type: String },
    zaynpayIdempotencyResponse: { type: Object },
    userId: { type: String },
    companyId: { type: Schema.Types.ObjectId, ref: 'ClientCompany' }, 
    subAccountId: { type: Schema.Types.ObjectId, ref: 'SubAccount' }, 
    companyName: { type: String },
    employeeName: { type: String },
    subAccountName: { type: String },
    isSubAccountTx: { type: Boolean, default: false },
    transferType: { type: String, default: 'vodafone' },
    vodafoneNumber: { type: String },
    accountNumber: { type: String },
    accountName: { type: String }, 
    amount: { type: Number, required: true, min: 0 },
    costLYD: { type: Number, default: 0, min: 0 },
    subAccountCostLYD: { type: Number, default: 0 },
    commission: { type: Number, default: 0 },
    masterProfit: { type: Number, default: 0 }, 
    exchangeRate: { type: Number, default: 0 }, 
    subClientRate: { type: Number, default: 0 },
    agencyPricing: {
        serviceKey: { type: String, trim: true },
        pricingVersion: { type: Number },
        amountEGP: { type: Number },
        agentRate: { type: Number },
        customerRate: { type: Number },
        marginPiasters: { type: Number },
        rateDelta: { type: Number },
        agentCostLYD: { type: Number },
        customerChargeLYD: { type: Number },
        profitLYD: { type: Number }
    },
    settlementDetails: {
        category: { type: String, trim: true },
        paymentMethod: { type: String, trim: true },
        externalReference: { type: String, trim: true },
        statement: { type: String, trim: true },
        settledBy: { type: String, trim: true }
    },
    status: { 
        type: String, 
        enum: [
            'pending',           
            'processing',        
            'accepted',          
            'completed',         
            'rejected',          
            'deposit_pending',   
            'deposit',           
            'deduction',         
            'cancelled_by_admin' 
        ], 
        default: 'pending' 
    },
    executorGroupId: { type: Schema.Types.ObjectId, ref: 'ExecutorGroup' },
    managerGroupId: { type: Schema.Types.ObjectId, ref: 'ExecutorGroup' },
    executorReceivedAt: { type: Date },
    executorGroupName: { type: String },
    operatorId: { type: String }, 
    executorName: { type: String, default: '---' },
    executorSenderPhone: { type: String },
    isApiReview: { type: Boolean }, 
    apiResultData: { type: Object }, 
    originalApiGroupId: { type: Schema.Types.ObjectId, ref: 'ExecutorGroup' }, 
    notes: { type: String },
    adminNotes: { type: String },
    complaintText: { type: String },
    emergencyAlert: { type: String }, 
    executorWebAlert: { type: Object }, 
    cancellationNumber: { type: String, unique: true, sparse: true },
    cancellationReason: { type: String },
    cancelledBy: { type: String },
    cancelledAt: { type: Date },
    proofImage: { type: String }, 
    proofImages: [{ type: String }], 
    idCardImage: { type: String }, 
    resolutionImage: { type: String },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' }
}, { 
    timestamps: true 
});

transactionSchema.index({ status: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ companyId: 1, createdAt: -1 });
transactionSchema.index({ executorGroupId: 1, status: 1 });
transactionSchema.index({ status: 1, updatedAt: -1 });
transactionSchema.index({ executorGroupId: 1, createdAt: -1 });
transactionSchema.index({ executorGroupId: 1, executorReceivedAt: 1 });
transactionSchema.index({ managerGroupId: 1, status: 1 });
transactionSchema.index({ executorGroupId: 1, status: 1, executorReceivedAt: 1 });
transactionSchema.index({ managerGroupId: 1, status: 1, executorReceivedAt: 1 });
transactionSchema.index({ executorGroupId: 1, status: 1, updatedAt: -1 });
transactionSchema.index({ managerGroupId: 1, status: 1, updatedAt: -1 });
transactionSchema.index({ tenantId: 1, createdAt: -1 });

export default (mongoose.models.Transaction as mongoose.Model<ITransaction>) || mongoose.model<ITransaction>('Transaction', transactionSchema);
