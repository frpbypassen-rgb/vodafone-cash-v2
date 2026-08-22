import logger from '../../../utils/logger';
import crypto from 'crypto';

export interface IDeviceSignature {
    ip: string;
    userAgent: string;
    fingerprint?: string;
}

export class DeviceTrustEngine {
    private trustedDevices: Map<string, { fingerprint: string; expiresAt: number }> = new Map();
    private readonly trustTtlMs = Math.max(60 * 60 * 1000, Number(process.env.MFA_TRUST_TTL_SECONDS || 86400) * 1000);

    /**
     * حساب بصمة الجهاز الفريدة
     */
    public calculateFingerprint(sig: IDeviceSignature): string {
        const payload = `${sig.ip}|${sig.userAgent}|${sig.fingerprint || ''}`;
        return crypto.createHash('sha256').update(payload).digest('hex');
    }

    /**
     * تسجيل جهاز كجهاز موثوق للمستخدم
     */
    public registerDevice(userId: string, sig: IDeviceSignature): void {
        const fingerprint = this.calculateFingerprint(sig);
        this.trustedDevices.set(userId, { fingerprint, expiresAt: Date.now() + this.trustTtlMs });
        logger.info(`Registered trusted device fingerprint for user ${userId}`, { fingerprint });
    }

    /**
     * التحقق مما إذا كان الجهاز موثوقاً
     */
    public isDeviceTrusted(userId: string, sig: IDeviceSignature): boolean {
        const fingerprint = this.calculateFingerprint(sig);
        const record = this.trustedDevices.get(userId);
        if (!record || record.expiresAt <= Date.now()) {
            this.trustedDevices.delete(userId);
            return false;
        }
        const trusted = record.fingerprint === fingerprint;

        if (!trusted) {
            logger.warn(`Suspicious access attempt: Untrusted device fingerprint detected for user ${userId}`, { fingerprint });
        }

        return trusted;
    }
}

export const deviceTrustEngine = new DeviceTrustEngine();
