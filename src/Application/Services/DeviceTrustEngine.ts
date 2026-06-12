import logger from '../../../utils/logger';
import crypto from 'crypto';

export interface IDeviceSignature {
    ip: string;
    userAgent: string;
    fingerprint?: string;
}

export class DeviceTrustEngine {
    private trustedDevices: Map<string, Set<string>> = new Map(); // mapping userId -> Set of Device Fingerprints

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
        if (!this.trustedDevices.has(userId)) {
            this.trustedDevices.set(userId, new Set());
        }
        this.trustedDevices.get(userId)!.add(fingerprint);
        logger.info(`Registered trusted device fingerprint for user ${userId}`, { fingerprint });
    }

    /**
     * التحقق مما إذا كان الجهاز موثوقاً
     */
    public isDeviceTrusted(userId: string, sig: IDeviceSignature): boolean {
        // إذا كان المستخدم لا يملك أجهزة مسجلة، نعتمد الجهاز الحالي كأول جهاز موثوق
        if (!this.trustedDevices.has(userId) || this.trustedDevices.get(userId)!.size === 0) {
            this.registerDevice(userId, sig);
            return true;
        }

        const fingerprint = this.calculateFingerprint(sig);
        const userDevices = this.trustedDevices.get(userId)!;
        const trusted = userDevices.has(fingerprint);

        if (!trusted) {
            logger.warn(`Suspicious access attempt: Untrusted device fingerprint detected for user ${userId}`, { fingerprint });
        }

        return trusted;
    }
}

export const deviceTrustEngine = new DeviceTrustEngine();
