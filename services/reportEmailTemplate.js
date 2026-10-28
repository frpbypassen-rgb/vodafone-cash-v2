'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const {getBrandContact} = require('../utils/brandContact');
const render = ejs.compile(fs.readFileSync(path.join(__dirname, '../views/emails/report-email.ejs'), 'utf8'));
const logo = fs.readFileSync(path.join(__dirname, '../public/images/login-otp-logo.jpg'));
const logoAttachment = () => ({filename:'ahram-pay.jpg',content:logo,contentType:'image/jpeg',cid:'ahram-report-logo',contentDisposition:'inline'});
const context = (kind, accountName) => {
    const brand = getBrandContact();
    let origin = 'https://ahrampay.com';
    try { const url = new URL(brand.website); if(url.protocol === 'https:' && !url.username && !url.password) origin = url.origin; } catch (_) { /* Use the official secure origin. */ }
    return {brand,accountName:String(accountName || '').slice(0,160),accountLabel:kind === 'company'?'الشركة':'الوكالة',settingsUrl:origin+(kind === 'company'?'/client':'/agent-portal')+'/settings#notifications'};
};
const codeEmail = ({code,kind='agent',accountName=''}) => {
    if(!/^\d{6}$/.test(String(code)))throw new Error('INVALID_EMAIL_CODE');
    const data={...context(kind,accountName),mode:'code',code:String(code),day:'',displayDay:'',filename:'',test:false};
    return {
        subject:'تأكيد بريد كشف الحساب — '+data.brand.name,
        text:`${data.brand.name}\nتأكيد بريد كشف الحساب${accountName?' — '+data.accountName:''}\n\nرمز التفعيل: ${code}\nصالح لمدة 10 دقائق. لا تشارك الرمز مع أحد.\nأدخل الرمز في الإعدادات ← الإشعارات لتفعيل كشف الحساب اليومي.\nهذا الرمز لا يغيّر بيانات تسجيل الدخول. إذا لم تطلبه، تجاهل الرسالة.\nإعدادات البريد: ${data.settingsUrl}`,
        html:render(data),attachments:[logoAttachment()],
    };
};
const statementEmail = ({day,pdf,test=false,kind='agent',accountName=''}) => {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || !Number.isFinite(Date.parse(day+'T00:00:00Z')) || new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw new Error('INVALID_REPORT_DAY');
    const data={...context(kind,accountName),mode:'statement',code:'',day,displayDay:day.split('-').reverse().join(' / '),filename:`Ahram-statement-${day}.pdf`,test:Boolean(test)};
    return {
        subject:`${test?'كشف تجريبي':'كشف الحساب اليومي'} — ${day} — ${data.brand.name}`,
        text:`${data.brand.name}\n${test?'كشف حساب تجريبي':'التقفيل اليومي — كشف الحساب'}${accountName?' — '+data.accountName:''}\n\nتاريخ الكشف: ${day}\nالفترة: كامل اليوم بتوقيت ليبيا.\nمرفق كشف حساب ${data.accountLabel} من التقارير الشاملة للإدارة. افتح مرفق PDF باسم ${data.filename} لعرض الحركات والأرصدة.\nيمكنك إيقاف الكشوف أو تغيير البريد من الإعدادات ← الإشعارات.\nإدارة الكشوف: ${data.settingsUrl}`,
        html:render(data),attachments:[{filename:data.filename,content:pdf,contentType:'application/pdf'},logoAttachment()],
    };
};
// The login mailer supplies its existing normalized code, expiry and masked attempt rows.
const loginEmail = view => {
    if(!/^\d{6}$/.test(String(view.otp)))throw new Error('INVALID_EMAIL_CODE');
    return {html:render({...context('agent',view.accountName),mode:'login',code:view.otp,expiresPhrase:view.expiresPhrase,attemptRows:view.attemptRows||[],day:'',displayDay:'',filename:'',test:false}),attachments:[logoAttachment()]};
};
const enrollmentEmail = ({code,kind='agent',accountName=''}) => {
    if(!/^\d{6}$/.test(String(code)))throw new Error('INVALID_EMAIL_CODE');
    return {
        subject:'تفعيل التحقق بالبريد لتسجيل الدخول — '+getBrandContact().name,
        text:`تفعيل التحقق بالبريد لتسجيل الدخول\nرمز التأكيد: ${code}\nصالح لمدة 5 دقائق. أدخله في أمان الحساب ← التحقق بالبريد. بعد التفعيل سيُطلب كود عند كل تسجيل دخول. لا تشارك الرمز. إذا لم تطلب التفعيل، غيّر كلمة مرورك وراجع الجلسات.`,
        html:render({...context(kind,accountName),mode:'enrollment',code:String(code),expiresPhrase:'5 دقائق',attemptRows:[],day:'',displayDay:'',filename:'',test:false}),
        attachments:[logoAttachment()],
    };
};
module.exports={codeEmail,statementEmail,loginEmail,enrollmentEmail};
