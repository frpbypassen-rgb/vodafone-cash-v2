import mongoose, { Schema, Document } from 'mongoose';

export interface ILedger extends Document {
    entityId: mongoose.Types.ObjectId;
    entityModel: 'User' | 'ClientCompany' | 'ClientBot' | 'SubAccount' | 'ExecutorBot';
    transactionId: string;
    type: 'DEPOSIT' | 'DEDUCTION' | 'TRANSFER' | 'COMMISSION' | 'REFUND';
    amount: number; // Signed amount
    debitAccount?: string;
    creditAccount?: string;
    balanceBefore: number;
    balanceAfter: number;
    description?: string;
    tenantId?: mongoose.Types.ObjectId;
}

const ledgerSchema = new Schema<ILedger>({
    entityId: { type: Schema.Types.ObjectId, required: true },
    entityModel: { type: String, required: true, enum: ['User', 'ClientCompany', 'ClientBot', 'SubAccount', 'ExecutorBot'] },
    transactionId: { type: String, required: true },
    type: { type: String, required: true, enum: ['DEPOSIT', 'DEDUCTION', 'TRANSFER', 'COMMISSION', 'REFUND'] },
    amount: { type: Number, required: true },
    debitAccount: { type: String },
    creditAccount: { type: String },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    description: { type: String },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

ledgerSchema.index({ entityId: 1, createdAt: -1 });
ledgerSchema.index({ transactionId: 1 });
ledgerSchema.index({ entityId: 1, type: 1, createdAt: -1 });
ledgerSchema.index({ type: 1, createdAt: -1 });
ledgerSchema.index({ tenantId: 1 });

export default (mongoose.models.Ledger as mongoose.Model<ILedger>) || mongoose.model<ILedger>('Ledger', ledgerSchema);
