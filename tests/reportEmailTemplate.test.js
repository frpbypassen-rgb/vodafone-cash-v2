'use strict';
jest.mock('nodemailer',()=>({createTransport:jest.fn()}));
jest.mock('../services/emailOtpMailer',()=>({getSmtpConfig:()=>({host:'fixture.test',port:465,secure:true,user:'fixture',pass:'fixture',from:'noreply@example.test'}),getMissingSmtpSettings:()=>[]}));
const {codeEmail,statementEmail}=require('../services/reportEmailTemplate');
const nodemailer=require('nodemailer');

test.each(['agent','company'])('%s: verification is escaped, RTL, copyable, and uses a CID logo without exposing the code in its preheader',kind=>{
 const message=codeEmail({kind,code:'012345',accountName:'<script>unsafe</script>'});
 expect(message.html).toContain('dir="rtl"');expect(message.html).toContain('dir="ltr"');expect(message.html).toContain('012345');expect(message.text).toContain('012345');
 expect(message.html).toContain('&lt;script&gt;unsafe&lt;/script&gt;');expect(message.html).not.toContain('<script>');
 expect(message.html).toContain('10 دقائق');expect(message.html).toContain('لا تشارك الرمز');
 expect(message.html.slice(0,message.html.indexOf('<table'))).not.toContain('012345');
 expect(message.html).toContain((kind==='company'?'/client':'/agent-portal')+'/settings#notifications');
 expect(message.html).toContain('src="cid:ahram-report-logo"');expect(message.attachments).toEqual([expect.objectContaining({cid:'ahram-report-logo',content:expect.any(Buffer),contentType:'image/jpeg'})]);
});
test.each(['agent','company'])('%s: daily closing preserves the original PDF and the precise report date',kind=>{
 const pdf=Buffer.from('%PDF-original-admin-report'),message=statementEmail({kind,day:'2026-10-27',pdf,accountName:'Test account'});
 expect(message.subject).toContain('2026-10-27');expect(message.html).toContain('27 / 10 / 2026');expect(message.html).toContain('كامل اليوم بتوقيت ليبيا');
 expect(message.html).toContain('كشف الحساب مرفق');expect(message.attachments[0].content).toBe(pdf);expect(message.attachments[0].filename).toBe('Ahram-statement-2026-10-27.pdf');
 expect(message.html).not.toContain('download=');expect(message.text).toContain('التقارير الشاملة للإدارة');
 expect(statementEmail({kind,day:'2026-10-27',pdf,test:true}).html).toContain('رسالة تجريبية');
});
test('invalid dates/codes are rejected and configured links cannot use an unsafe scheme',()=>{
 expect(()=>codeEmail({code:'<code>'})).toThrow('INVALID_EMAIL_CODE');expect(()=>statementEmail({day:'2026-02-30'})).toThrow('INVALID_REPORT_DAY');
 const previous=process.env.BRAND_WEBSITE;process.env.BRAND_WEBSITE='javascript:alert(1)';
 try{const message=codeEmail({code:'123456'});expect(message.html).toContain('https://ahrampay.com/agent-portal/settings#notifications');expect(message.html).not.toContain('javascript:');}
 finally{if(previous===undefined)delete process.env.BRAND_WEBSITE;else process.env.BRAND_WEBSITE=previous;}
});
test.each(['agent','company'])('%s: the real mailer sends HTML and a plain-text alternative and closes SMTP',async kind=>{
 const sendMail=jest.fn(async()=>({accepted:['recipient@example.test']})),close=jest.fn();nodemailer.createTransport.mockReturnValue({sendMail,close});
 const mailer=require('../services/'+kind+'ReportEmailMailer');
 await mailer.sendCode('recipient@example.test','654321',{accountName:'Demo'});
 await mailer.sendStatement({email:'recipient@example.test',day:'2026-10-27',pdf:Buffer.from('admin PDF'),accountName:'Demo'});
 for(const [message] of sendMail.mock.calls)expect(message).toMatchObject({to:'recipient@example.test',from:'noreply@example.test',html:expect.stringContaining('<!doctype html>'),text:expect.any(String)});
 expect(sendMail.mock.calls[1][0].attachments[0].content.toString()).toBe('admin PDF');expect(close).toHaveBeenCalledTimes(2);
});

test.each(['agent','company'])('%s: Nodemailer builds an actual MIME message with the PDF and inline logo without connecting to SMTP',async kind=>{
 const transport=jest.requireActual('nodemailer').createTransport({streamTransport:true,buffer:true,newline:'unix'});
 const pdf=Buffer.from('%PDF-original-attachment');
 try {
  const info=await transport.sendMail({from:'noreply@example.test',to:'review@example.test',...statementEmail({kind,day:'2026-10-27',pdf})});
  const raw=info.message.toString('utf8');
  expect(raw).toContain('Content-Type: multipart/mixed');
  expect(raw).toContain('Content-Type: multipart/alternative');
  expect(raw).toContain('Content-Type: text/plain');expect(raw).toContain('Content-Type: text/html');
  expect(raw).toContain('Content-ID: <ahram-report-logo>');
  expect(raw).toContain('Content-Disposition: inline');expect(raw).toContain('Content-Type: image/jpeg');
  expect(raw).toContain('Content-Type: application/pdf');expect(raw).toContain('Ahram-statement-2026-10-27.pdf');
  expect(raw).toContain(pdf.toString('base64'));
 } finally {transport.close();}
});
