import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
    name?: string;
    phone?: string;
    balances: {
        EGP: number;
        USD: number;
        EUR: number;
        LYD: number;
        SAR: number;
    };
    tier: number;
    status: string;
    creditLimit: number;
    webUsername: string;
    webPassword: string;
    role: string;
    refreshToken?: string;
    otpCode?: string;
    otpExpires?: Date;
    lastOtpDate?: string;
    totpSecret?: string;
    mfaEnabled?: boolean;
    mfaType?: 'none' | 'totp' | 'sms' | 'email';
    tenantId?: mongoose.Types.ObjectId;
}

const userSchema = new Schema<IUser>({
    name: { type: String },
    phone: { type: String, unique: true, sparse: true },
    balances: {
        EGP: { type: Number, default: 0 },
        USD: { type: Number, default: 0 },
        EUR: { type: Number, default: 0 },
        LYD: { type: Number, default: 0 },
        SAR: { type: Number, default: 0 }
    },
    tier: { type: Number, default: 3 },
    status: { type: String, default: 'active' }, 
    creditLimit: { type: Number, default: 0 },
    webUsername: { type: String, unique: true, required: true },
    webPassword: { type: String, required: true },
    role: { type: String, default: 'user' },
    refreshToken: { type: String },
    otpCode: { type: String },
    otpExpires: { type: Date },
    totpSecret: { type: String },
    mfaEnabled: { type: Boolean, default: false },
    mfaType: { type: String, enum: ['none', 'totp', 'sms', 'email'], default: 'none' },
    lastOtpDate: { type: String },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

userSchema.pre('save', async function (this: any, next: any) {
    if (!this.isModified('webPassword') || !this.webPassword) return next();
    if (this.webPassword.startsWith('$2')) return next();
    try {
        this.webPassword = await bcrypt.hash(this.webPassword, 12);
        next();
    } catch (err: any) {
        next(err);
    }
});

userSchema.index({ status: 1 });
userSchema.index({ tenantId: 1 });

export default (mongoose.models.User as mongoose.Model<IUser>) || mongoose.model<IUser>('User', userSchema);
