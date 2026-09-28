'use strict';

/* global document */

const fs = require('fs');
const path = require('path');

const OUT = process.env.LOGIN_OTP_PREVIEW_DIR || path.join(__dirname, '../design-previews/client-frames');

const shell = (kind) => `<!doctype html>
<html lang="ar">
<head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#eef1f4;font-family:Arial,Helvetica,sans-serif;color:#202124;}
  .banner{background:#f9ab00;color:#202124;font-size:13px;font-weight:700;padding:8px 14px;}
  iframe{width:100%;border:0;background:#fff;display:block;}
</style></head>
<body>
  <div class="banner">Emulated render — not a real inbox capture</div>
  ${kind}
  <iframe id="mail"></iframe>
</body></html>`;

const gmailDesktop = `
  <div style="background:#fff;border-bottom:1px solid #e0e0e0;height:64px;display:flex;align-items:center;padding:0 16px;gap:16px;">
    <div style="font-size:22px;font-weight:500;color:#5f6368;">Gmail</div>
    <div style="flex:1;background:#f1f3f4;border-radius:8px;height:46px;"></div>
  </div>
  <div style="display:flex;min-height:120px;">
    <div style="width:220px;background:#f6f8fc;padding:16px;color:#444;font-size:14px;">Inbox<br>Sent<br>Drafts</div>
    <div style="flex:1;background:#fff;padding:20px 28px 0;direction:rtl;text-align:right;">
      <div style="font-size:22px;font-weight:400;margin-bottom:14px;">رمز التحقق لتسجيل الدخول — أهرام باي</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-size:12px;color:#5f6368;direction:ltr;">10:22</div>
        <div><b>أهرام باي</b> <span style="color:#5f6368;direction:ltr;">&lt;noreply@ahrampay.com&gt;</span></div>
      </div>
    </div>
  </div>`;

const gmailMobile = `
  <div style="background:#fff;border-bottom:1px solid #e0e0e0;height:56px;display:flex;align-items:center;padding:0 12px;font-size:20px;color:#5f6368;">Gmail</div>
  <div style="background:#fff;padding:14px 16px 8px;direction:rtl;text-align:right;">
    <div style="font-size:18px;margin-bottom:10px;">رمز التحقق لتسجيل الدخول — أهرام باي</div>
    <div style="font-size:14px;"><b>أهرام باي</b></div>
    <div style="font-size:12px;color:#5f6368;direction:ltr;text-align:left;">noreply@ahrampay.com</div>
  </div>`;

const outlook = `
  <div style="background:#0f6cbd;color:#fff;height:48px;display:flex;align-items:center;padding:0 16px;font-size:16px;font-weight:600;">Outlook</div>
  <div style="display:flex;">
    <div style="width:200px;background:#f5f5f5;padding:16px;font-size:13px;color:#444;">Inbox<br>Drafts<br>Sent Items</div>
    <div style="flex:1;background:#fff;padding:16px 20px 0;direction:rtl;text-align:right;">
      <div style="font-size:20px;margin-bottom:8px;">رمز التحقق لتسجيل الدخول — أهرام باي</div>
      <div style="font-size:13px;color:#444;margin-bottom:8px;">أهرام باي &lt;noreply@ahrampay.com&gt;</div>
    </div>
  </div>`;

const main = async () => {
    const puppeteer = (await import('puppeteer')).default;
    const { buildLoginOtpHtmlV2 } = require('../services/emailOtpMailer');
    const jpeg = fs.readFileSync(path.join(__dirname, '../public/images/login-otp-logo.jpg'));
    const email = buildLoginOtpHtmlV2({
        otp: '482913',
        accountName: 'عميل تجريبي',
        expiresMinutes: 5,
        year: 2026,
        attemptAt: new Date('2026-09-22T12:22:00.000Z'),
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        loginAccount: 'tizari@ahram.com'
    }).replaceAll('https://ahrampay.com/images/login-otp-logo.jpg', `data:image/jpeg;base64,${jpeg.toString('base64')}`);

    const shots = [
        ['login-otp-gmail-desktop.png', 1280, 900, gmailDesktop],
        ['login-otp-gmail-mobile.png', 390, 844, gmailMobile],
        ['login-otp-outlook.png', 1100, 800, outlook]
    ];
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
        const page = await browser.newPage();
        for (const [name, width, height, chrome] of shots) {
            await page.setViewport({ width, height, deviceScaleFactor: 1 });
            await page.setContent(shell(chrome), { waitUntil: 'load' });
            await page.evaluate((message) => {
                const frame = document.getElementById('mail');
                frame.srcdoc = message;
            }, email);
            await page.waitForFunction(() => {
                const doc = document.getElementById('mail').contentDocument;
                return Boolean(doc && doc.querySelector('a[href^="tel:"]'));
            });
            await page.evaluate(() => {
                const frame = document.getElementById('mail');
                frame.style.height = `${frame.contentDocument.documentElement.scrollHeight + 8}px`;
            });
            const order = await page.evaluate(() => {
                const doc = document.getElementById('mail').contentDocument;
                const phone = doc.querySelector('a[href^="tel:"] bdo');
                const range = doc.createRange();
                range.setStart(phone.firstChild, 0);
                range.setEnd(phone.firstChild, 1);
                const plus = range.getBoundingClientRect().x;
                range.setStart(phone.firstChild, 1);
                range.setEnd(phone.firstChild, 5);
                const digits = range.getBoundingClientRect().x;
                const img = doc.querySelector('img');
                return { phone: phone.textContent, plus, digits, naturalWidth: img.naturalWidth };
            });
            if (order.phone !== '0913731533' || !(order.plus < order.digits) || !(order.naturalWidth > 0)) {
                throw new Error(`${name} bidi/logo check failed ${JSON.stringify(order)}`);
            }
            await page.screenshot({ path: path.join(OUT, name), fullPage: true });
            console.log(name, JSON.stringify(order));
        }
    } finally {
        await browser.close();
    }
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
