import mongoose, { Schema, Document } from 'mongoose';

export interface IFxRate extends Document {
    pair: string; // e.g. "USD_EGP"
    fromCurrency: string;
    toCurrency: string;
    rate: number;
    tenantId?: mongoose.Types.ObjectId;
}

const fxRateSchema = new Schema<IFxRate>({
    pair: { type: String, required: true, unique: true },
    fromCurrency: { type: String, required: true },
    toCurrency: { type: String, required: true },
    rate: { type: Number, required: true, min: 0.0001 },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

fxRateSchema.index({ pair: 1 });
fxRateSchema.index({ tenantId: 1 });

export default (mongoose.models.FxRate as mongoose.Model<IFxRate>) || mongoose.model<IFxRate>('FxRate', fxRateSchema);
