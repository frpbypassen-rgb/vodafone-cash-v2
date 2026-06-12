import mongoose, { Schema, Document } from 'mongoose';

export interface ICountryConfig extends Document {
    country: string;
    currency: string;
    language: string;
    timezone: string;
    regulations: {
        maxTransactionLimit: number;
        dailyLimit: number;
        amlThreshold: number;
    };
    tenantId?: mongoose.Types.ObjectId;
}

const countryConfigSchema = new Schema<ICountryConfig>({
    country: { type: String, required: true, unique: true },
    currency: { type: String, required: true },
    language: { type: String, default: 'ar' },
    timezone: { type: String, required: true },
    regulations: {
        maxTransactionLimit: { type: Number, default: 50000 },
        dailyLimit: { type: Number, default: 100000 },
        amlThreshold: { type: Number, default: 250000 }
    },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

countryConfigSchema.index({ country: 1 });
countryConfigSchema.index({ tenantId: 1 });

export default (mongoose.models.CountryConfig as mongoose.Model<ICountryConfig>) || mongoose.model<ICountryConfig>('CountryConfig', countryConfigSchema);
