import crypto from 'crypto';
import logger from '../../../utils/logger';

export class MfaService {
    // أبجدية Base32 المعتمدة في Google Authenticator
    private static BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /**
     * توليد سر عشوائي للـ TOTP متوافق مع Google Authenticator
     */
    public generateTotpSecret(length: number = 16): string {
        let secret = '';
        for (let i = 0; i < length; i++) {
            const index = crypto.randomInt(0, MfaService.BASE32_CHARS.length);
            secret += MfaService.BASE32_CHARS[index];
        }
        return secret;
    }

    /**
     * توليد رابط QR Code لتهيئته في تطبيق Google Authenticator
     */
    public getQrCodeUrl(secret: string, username: string, issuer: string = 'Al-Ahram Pay'): string {
        return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
    }

    /**
     * التحقق من كود TOTP المدخل
     */
    public verifyTotp(secret: string, token: string, window: number = 1): boolean {
        try {
            const cleanToken = token.trim();
            if (cleanToken.length !== 6 || isNaN(Number(cleanToken))) return false;

            const key = this.base32Decode(secret);
            const timeStep = 30;
            const currentCounter = Math.floor(Date.now() / 1000 / timeStep);

            // فحص كود TOTP مع مراعاة فارق الوقت (Window) لمنع مشاكل تزامن ساعات الأجهزة
            for (let i = -window; i <= window; i++) {
                const counter = currentCounter + i;
                const expectedToken = this.generateHotp(key, counter);
                if (expectedToken === cleanToken) {
                    return true;
                }
            }
        } catch (e: any) {
            logger.error('TOTP verification failed with error', { error: e.message });
        }
        return false;
    }

    /**
     * توليد رموز OTP مؤقتة وتخزينها في الكاش أو إرسالها (SMS / Email)
     */
    public generateSmsOtp(): string {
        return crypto.randomInt(100000, 999999).toString();
    }

    // ─── دالات مساعدة داخلية لتطبيق خوارزميات التشفير القياسية RFC 4226 / RFC 6238 ───

    private base32Decode(base32: string): Buffer {
        const cleanStr = base32.toUpperCase().replace(/=+$/, '');
        const bytes = [];
        let buffer = 0;
        let bitsLeft = 0;

        for (let i = 0; i < cleanStr.length; i++) {
            const val = MfaService.BASE32_CHARS.indexOf(cleanStr[i]);
            if (val === -1) throw new Error('Invalid base32 character');

            buffer = (buffer << 5) | val;
            bitsLeft += 5;

            if (bitsLeft >= 8) {
                bytes.push((buffer >> (bitsLeft - 8)) & 0xff);
                bitsLeft -= 8;
            }
        }
        return Buffer.from(bytes);
    }

    private generateHotp(key: Buffer, counter: number): string {
        // تحويل العداد لـ 8-byte Buffer
        const counterBuffer = Buffer.alloc(8);
        let temp = counter;
        for (let i = 7; i >= 0; i--) {
            counterBuffer[i] = temp & 0xff;
            temp = temp >> 8;
        }

        // حساب HMAC-SHA1
        const hmac = crypto.createHmac('sha1', key);
        hmac.update(counterBuffer);
        const hmacResult = hmac.digest();

        // التصفية الديناميكية (Dynamic Truncation)
        const offset = hmacResult[hmacResult.length - 1] & 0xf;
        const code = ((hmacResult[offset] & 0x7f) << 24) |
                     ((hmacResult[offset + 1] & 0xff) << 16) |
                     ((hmacResult[offset + 2] & 0xff) << 8) |
                     (hmacResult[offset + 3] & 0xff);

        const otp = code % 1000000;
        return otp.toString().padStart(6, '0');
    }
}

export const mfaService = new MfaService();
