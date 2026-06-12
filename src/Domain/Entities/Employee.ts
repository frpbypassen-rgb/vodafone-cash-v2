import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IEmployee extends Document {
    name: string;
    phone?: string;
    role: 'operator' | 'manager';
    status: 'pending' | 'active' | 'suspended' | 'banned';
    groupId: mongoose.Types.ObjectId;
    webUsername: string;
    webPassword: string;
    refreshToken?: string;
    otpCode?: string;
    otpExpires?: Date;
    lastOtpDate?: string;
    telegramId?: string;
    canViewAllReports: boolean;
    tenantId?: mongoose.Types.ObjectId;
}

const employeeSchema = new Schema<IEmployee>({
    name: { type: String, required: true },
    phone: { type: String },
    role: { type: String, enum: ['operator', 'manager'], default: 'operator' },
    status: { type: String, enum: ['pending', 'active', 'suspended', 'banned'], default: 'pending' },
    groupId: { type: Schema.Types.ObjectId, ref: 'ExecutorGroup', required: true },
    webUsername: { type: String, unique: true, required: true },
    webPassword: { type: String, required: true },
    refreshToken: { type: String },
    otpCode: { type: String },
    otpExpires: { type: Date },
    lastOtpDate: { type: String },
    telegramId: { type: String },
    canViewAllReports: { type: Boolean, default: false },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

employeeSchema.index({ webUsername: 1, groupId: 1 }, { unique: true });
employeeSchema.index({ tenantId: 1 });

employeeSchema.pre('save', async function (this: any, next: any) {
    if (!this.isModified('webPassword') || !this.webPassword) return next();
    if (this.webPassword.startsWith('$2')) return next();
    try {
        this.webPassword = await bcrypt.hash(this.webPassword, 12);
        next();
    } catch (err: any) {
        next(err);
    }
});

export default (mongoose.models.Employee as mongoose.Model<IEmployee>) || mongoose.model<IEmployee>('Employee', employeeSchema);
