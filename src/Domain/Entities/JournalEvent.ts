import mongoose, { Schema, Document } from 'mongoose';

export interface IJournalEvent extends Document {
    eventType: 'MoneyDeposited' | 'MoneyWithdrawn' | 'TransferCompleted' | 'TransferReversed';
    entityId: mongoose.Types.ObjectId;
    entityModel: 'User' | 'ClientCompany' | 'ClientBot' | 'SubAccount' | 'ExecutorBot';
    amount: number;
    currency: string;
    sequenceNumber: number;
    metadata?: any;
    tenantId?: mongoose.Types.ObjectId;
    createdAt: Date;
}

const journalEventSchema = new Schema<IJournalEvent>({
    eventType: { 
        type: String, 
        required: true, 
        enum: ['MoneyDeposited', 'MoneyWithdrawn', 'TransferCompleted', 'TransferReversed'] 
    },
    entityId: { type: Schema.Types.ObjectId, required: true },
    entityModel: { type: String, required: true, enum: ['User', 'ClientCompany', 'ClientBot', 'SubAccount', 'ExecutorBot'] },
    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'EGP' },
    sequenceNumber: { type: Number, required: true },
    metadata: { type: Schema.Types.Mixed },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: { createdAt: true, updatedAt: false } });

journalEventSchema.index({ entityId: 1, sequenceNumber: 1 }, { unique: true });
journalEventSchema.index({ eventType: 1, createdAt: -1 });
journalEventSchema.index({ tenantId: 1 });

export default (mongoose.models.JournalEvent as mongoose.Model<IJournalEvent>) || mongoose.model<IJournalEvent>('JournalEvent', journalEventSchema);
