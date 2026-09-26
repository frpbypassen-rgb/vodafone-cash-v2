'use strict';

const DEFAULT_FROM = 'Ahram Pay <noreply@ahrampay.com>';

const LOGIN_OTP_SUBJECT = 'رمز التحقق لتسجيل الدخول — أهرام باي';
const TRIPOLI_TIME_ZONE = 'Africa/Tripoli';

const COPY = Object.freeze({
    brandAr: 'أهرام باي',
    brandEn: 'Ahram Pay',
    kicker: 'دخول آمن',
    heading: 'رمز الدخول الآمن',
    body: 'استخدم الرمز التالي لإكمال تسجيل الدخول إلى حسابك.',
    otpLabel: 'رمز التحقق',
    ribbon: 'لا تشارك الرمز مع أحد',
    ignore: 'إذا لم تحاول تسجيل الدخول، تجاهل هذه الرسالة.',
    address: 'ليبيا / مصراتة، سوق الاستثمار / أمام المسجد العالي',
    phoneLabel: 'هاتف',
    phone: '+218 940719000',
    phoneHref: 'tel:+218940719000',
    email: 'support@ahrampay.com',
    site: 'https://ahrampay.com',
    signOff: 'مع أطيب التحيات ، فريق أهرام باي',
    footer: '© 2027 شركة الاهرام للاتصالات والتقنية. جميع الحقوق محفوظة.'
});

const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const cleanInline = (value) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();

const formatLoginOtpExpiresAt = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TRIPOLI_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const pick = (type) => {
        const part = parts.find((item) => item.type === type);
        return part ? part.value : '';
    };
    const hour = pick('hour') === '24' ? '00' : pick('hour');
    return `${pick('day')}-${pick('month')}-${pick('year')} ${hour}:${pick('minute')}`;
};

const resolveExpiresDate = ({ expiresAt, expiresMinutes, now = new Date() } = {}) => {
    if (expiresAt) {
        const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
        if (!Number.isNaN(date.getTime())) return date;
    }
    const minutes = Math.max(1, Number(expiresMinutes) || 5);
    const base = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    return new Date(base.getTime() + (minutes * 60 * 1000));
};

const buildLoginOtpContent = ({ otp, expiresMinutes, expiresAt, accountName, now } = {}) => {
    const name = cleanInline(accountName);
    const code = String(otp == null ? '' : otp).replace(/[\r\n]+/g, '');
    const expiresText = formatLoginOtpExpiresAt(resolveExpiresDate({ expiresAt, expiresMinutes, now }));
    return {
        ...COPY,
        greeting: name ? `مرحباً ${name}،` : 'مرحباً،',
        otp: code,
        expiresText,
        expiryLine: `تنتهي صلاحية هذا الرمز في ${expiresText}`
    };
};

const buildLoginOtpText = (input = {}) => {
    const content = buildLoginOtpContent(input);
    return [
        content.brandAr,
        content.brandEn,
        '',
        content.kicker,
        content.heading,
        '',
        content.greeting,
        '',
        content.body,
        '',
        content.otpLabel,
        content.otp,
        '',
        content.expiryLine,
        '',
        content.ribbon,
        content.ignore,
        '',
        content.address,
        `${content.phoneLabel} ${content.phone}`,
        content.email,
        content.site,
        '',
        content.signOff,
        '',
        content.footer
    ].join('\n');
};

const EMAIL_FONT = 'Tahoma,Arial,sans-serif';
const OTP_TILE_LIMIT = 8;

const buildPyramidMark = () => {
    const tiers = [
        [10, '#E0B44A'],
        [22, '#C9A227'],
        [36, '#E0B44A'],
        [52, '#C9A227']
    ];
    const rows = tiers.map(([width, color], index) => {
        const gap = index === 0
            ? ''
            : '<tr><td height="3" style="height:3px;font-size:0;line-height:3px;mso-line-height-rule:exactly;">&nbsp;</td></tr>';
        return `${gap}<tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;"><tr><td width="${width}" height="7" bgcolor="${color}" style="width:${width}px;height:7px;background:${color};font-size:0;line-height:7px;mso-line-height-rule:exactly;">&nbsp;</td></tr></table></td></tr>`;
    }).join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;">${rows}</table>`;
};

const buildOtpDigits = (otp) => {
    const chars = Array.from(String(otp || ''));
    const tileStyle = `background:#FFFDF8;border:1px solid #C9A227;color:#1A1510;font-family:${EMAIL_FONT};font-size:26px;font-weight:700;line-height:54px;mso-line-height-rule:exactly;text-align:center;`;
    if (chars.length > 0 && chars.length <= OTP_TILE_LIMIT) {
        const cells = chars.map((ch, index) => {
            const spacer = index === 0
                ? ''
                : '<td width="8" style="width:8px;font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td>';
            return `${spacer}<td width="44" height="54" align="center" valign="middle" bgcolor="#FFFDF8" style="width:44px;height:54px;${tileStyle}">${escapeHtml(ch)}</td>`;
        }).join('');
        return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" dir="ltr" style="border-collapse:separate;border-spacing:0;mso-table-lspace:0;mso-table-rspace:0;"><tr>${cells}</tr></table>`;
    }
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" dir="ltr" style="border-collapse:separate;mso-table-lspace:0;mso-table-rspace:0;"><tr><td align="center" bgcolor="#FFFDF8" style="background:#FFFDF8;border:2px solid #C9A227;padding:14px 28px;color:#1A1510;font-family:${EMAIL_FONT};font-size:28px;font-weight:700;letter-spacing:4px;line-height:1.2;text-align:center;">${escapeHtml(otp)}</td></tr></table>`;
};

const buildLoginOtpHtml = (input = {}) => {
    const content = buildLoginOtpContent(input);
    const font = EMAIL_FONT;
    const greeting = escapeHtml(content.greeting);
    const expiresLine = escapeHtml(content.expiryLine);
    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(LOGIN_OTP_SUBJECT)}</title>
</head>
<body style="margin:0;padding:0;background:#F7F1E8;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#F7F1E8;">${escapeHtml(content.heading)} — ${escapeHtml(content.brandAr)}. ${escapeHtml(content.ribbon)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" bgcolor="#F7F1E8" style="background:#F7F1E8;border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;">
<tr>
<td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" dir="rtl" bgcolor="#C9A227" style="width:600px;max-width:600px;background:#C9A227;border-collapse:separate;mso-table-lspace:0;mso-table-rspace:0;">
<tr>
<td style="padding:1px;background:#C9A227;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" bgcolor="#FFFDF8" style="width:100%;background:#FFFDF8;border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;">
<tr>
<td height="3" bgcolor="#C9A227" style="height:3px;background:#C9A227;font-size:0;line-height:3px;mso-line-height-rule:exactly;">&nbsp;</td>
</tr>
<tr>
<td align="center" style="padding:28px 32px 0;">
${buildPyramidMark()}
</td>
</tr>
<tr>
<td align="center" style="padding:10px 32px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:separate;mso-table-lspace:0;mso-table-rspace:0;">
<tr>
<td width="48" height="48" align="center" valign="middle" bgcolor="#FFFDF8" style="width:48px;height:48px;background:#FFFDF8;border:1px solid #C9A227;color:#C9A227;font-family:${font};font-size:24px;font-weight:700;line-height:48px;mso-line-height-rule:exactly;text-align:center;">أ</td>
</tr>
</table>
</td>
</tr>
<tr>
<td align="center" dir="rtl" style="padding:14px 32px 0;color:#1A1510;font-family:${font};font-size:22px;font-weight:700;line-height:1.4;text-align:center;">${escapeHtml(content.brandAr)}</td>
</tr>
<tr>
<td align="center" dir="ltr" style="padding:2px 32px 0;color:#C9A227;font-family:${font};font-size:12px;letter-spacing:1px;line-height:1.4;text-align:center;">${escapeHtml(content.brandEn)}</td>
</tr>
<tr>
<td style="padding:16px 80px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;">
<tr>
<td height="1" bgcolor="#E0B44A" style="height:1px;background:#E0B44A;font-size:0;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td>
</tr>
</table>
</td>
</tr>
<tr>
<td align="center" dir="rtl" style="padding:18px 36px 0;color:#C9A227;font-family:${font};font-size:12px;line-height:1.6;text-align:center;">${escapeHtml(content.kicker)}</td>
</tr>
<tr>
<td align="center" dir="rtl" style="padding:6px 36px 0;color:#1A1510;font-family:${font};font-size:28px;font-weight:700;line-height:1.45;text-align:center;">${escapeHtml(content.heading)}</td>
</tr>
<tr>
<td align="center" dir="rtl" style="padding:14px 36px 0;color:#1A1510;font-family:${font};font-size:16px;font-weight:700;line-height:1.6;text-align:center;">${greeting}</td>
</tr>
<tr>
<td align="center" dir="rtl" style="padding:6px 40px 0;color:#6B5E4E;font-family:${font};font-size:14px;line-height:1.8;text-align:center;">${escapeHtml(content.body)}</td>
</tr>
<tr>
<td align="center" dir="rtl" style="padding:22px 24px 0;color:#8A7340;font-family:${font};font-size:13px;font-weight:700;line-height:1.5;text-align:center;">${escapeHtml(content.otpLabel)}</td>
</tr>
<tr>
<td align="center" dir="ltr" style="padding:10px 12px 0;">
${buildOtpDigits(content.otp)}
</td>
</tr>
<tr>
<td align="center" dir="rtl" style="padding:14px 32px 0;color:#6B5E4E;font-family:${font};font-size:13px;line-height:1.7;text-align:center;">${expiresLine}</td>
</tr>
<tr>
<td bgcolor="#FFFDF8" style="padding:18px 0 0;background:#FFFDF8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" bgcolor="#F8E8C4" style="background:#F8E8C4;border-top:1px solid #E0B44A;border-bottom:1px solid #E0B44A;border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;">
<tr>
<td align="center" dir="rtl" style="padding:12px 16px;color:#6B5420;font-family:${font};font-size:15px;font-weight:700;line-height:1.6;text-align:center;">${escapeHtml(content.ribbon)}</td>
</tr>
</table>
</td>
</tr>
<tr>
<td align="center" dir="rtl" style="padding:14px 36px 0;color:#6B5E4E;font-family:${font};font-size:13px;line-height:1.7;text-align:center;">${escapeHtml(content.ignore)}</td>
</tr>
<tr>
<td align="center" dir="rtl" style="padding:18px 36px 0;color:#1A1510;font-family:${font};font-size:14px;line-height:1.7;text-align:center;">${escapeHtml(content.signOff)}</td>
</tr>
<tr>
<td bgcolor="#F7F1E8" style="padding:20px 28px 8px;background:#F7F1E8;border-top:1px solid #E4D3B0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" style="border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;">
<tr>
<td align="center" dir="rtl" style="color:#6B5E4E;font-family:${font};font-size:13px;line-height:1.9;text-align:center;">
${escapeHtml(content.address)}<br>
${escapeHtml(content.phoneLabel)} <a href="${content.phoneHref}" dir="ltr" style="color:#8A6420;text-decoration:underline;">${escapeHtml(content.phone)}</a><br>
<a href="mailto:${content.email}" dir="ltr" style="color:#8A6420;text-decoration:underline;">${escapeHtml(content.email)}</a><br>
<a href="${content.site}" dir="ltr" style="color:#8A6420;text-decoration:underline;">${escapeHtml(content.site)}</a>
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td align="center" bgcolor="#F7F1E8" dir="rtl" style="background:#F7F1E8;padding:4px 24px 18px;color:#8A7B68;font-family:${font};font-size:11px;line-height:1.6;text-align:center;">${escapeHtml(content.footer)}</td>
</tr>
</table>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
};


module.exports = {
    DEFAULT_FROM,
    LOGIN_OTP_SUBJECT,
    buildLoginOtpHtml,
    buildLoginOtpText,
    formatLoginOtpExpiresAt
};
