import mongoose, { Schema, Document } from 'mongoose';

export interface ITenant extends Document {
    name: string;
    slug: string;
    status: 'active' | 'suspended' | 'trial' | 'inactive';
    branding: {
        logo?: string;
        primaryColor: string;
        secondaryColor: string;
        displayName?: string;
    };
    rates: {
        level1: number;
        level2: number;
        level3: number;
    };
    features: {
        enableMobileAPI: boolean;
        enableTelegramBots: boolean;
        enableExternalAPI: boolean;
        enableSubAccounts: boolean;
        enableWebPortal: boolean;
    };
    limits: {
        maxTransferAmount: number;
        dailyTransferLimit: number;
        maxUsers: number;
        maxExecutors: number;
        maxConcurrentTransfers: number;
    };
    contact?: {
        email?: string;
        phone?: string;
        address?: string;
    };
    subscription: {
        plan: 'trial' | 'standard' | 'premium' | 'enterprise';
        startDate?: Date;
        endDate?: Date;
        commissionRate: number;
    };
    apiKey?: string;
    apiSecret?: string;
    createdBy?: mongoose.Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const tenantSchema = new Schema<ITenant>({
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    status: {
        type: String,
        default: 'active',
        enum: ['active', 'suspended', 'trial', 'inactive']
    },
    branding: {
        logo: { type: String },
        primaryColor: { type: String, default: '#1a73e8' },
        secondaryColor: { type: String, default: '#0d47a1' },
        displayName: { type: String }
    },
    rates: {
        level1: { type: Number, default: 6.40 },
        level2: { type: Number, default: 6.45 },
        level3: { type: Number, default: 6.50 }
    },
    features: {
        enableMobileAPI: { type: Boolean, default: true },
        enableTelegramBots: { type: Boolean, default: false },
        enableExternalAPI: { type: Boolean, default: false },
        enableSubAccounts: { type: Boolean, default: false },
        enableWebPortal: { type: Boolean, default: true }
    },
    limits: {
        maxTransferAmount: { type: Number, default: 100000 },
        dailyTransferLimit: { type: Number, default: 500000 },
        maxUsers: { type: Number, default: 100 },
        maxExecutors: { type: Number, default: 20 },
        maxConcurrentTransfers: { type: Number, default: 50 }
    },
    contact: {
        email: { type: String },
        phone: { type: String },
        address: { type: String }
    },
    subscription: {
        plan: { type: String, default: 'standard', enum: ['trial', 'standard', 'premium', 'enterprise'] },
        startDate: { type: Date },
        endDate: { type: Date },
        commissionRate: { type: Number, default: 0 }
    },
    apiKey: { type: String, unique: true, sparse: true },
    apiSecret: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

tenantSchema.index({ slug: 1 }, { unique: true });
tenantSchema.index({ status: 1 });
tenantSchema.index({ apiKey: 1 }, { sparse: true });

export default mongoose.models.Tenant as mongoose.Model<ITenant> || mongoose.model<ITenant>('Tenant', tenantSchema);
