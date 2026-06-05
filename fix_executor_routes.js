const fs = require('fs');
const path = 'd:\\vodafone-cash-system\\routes\\executorPortal.js';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

// Lines 168-205 (0-indexed: 167-204) are corrupted. Replace them.
const beforeDamage = lines.slice(0, 167); // lines 1-167
const afterDamage = lines.slice(205);     // lines 206+

const fixedSection = `
router.get('/verify', (req, res) => {
    if (!req.session.tempExecutorId) return res.redirect('/executor-portal/login');
    res.render('executor/verify', { error: null });
});

router.post('/verify', async (req, res) => {
    try {
        const { otp } = req.body;
        const account = await Employee.findById(req.session.tempExecutorId).lean();
        
        if (!account || account.otpCode !== otp?.trim() || new Date(account.otpExpires) < new Date()) {
            return res.render('executor/verify', { error: 'الرمز غير صحيح أو انتهت صلاحيته.' });
        }

        const todayStr = getTodayString();
        await Employee.updateOne({ _id: account._id }, { $set: { lastOtpDate: todayStr }, $unset: { otpCode: 1, otpExpires: 1 } }, { strict: false });

        req.session.isExecutorLoggedIn = true; req.session.executorId = account._id; req.session.executorBotId = account.botId;
        req.session.tempExecutorId = null;
        res.redirect('/executor-portal/dashboard');
    } catch (e) { res.redirect('/executor-portal/login'); }
});

router.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/executor-portal/login'); });

// ===============================================
// 🚀 حماية مسارات إثباتات التنفيذ (Images Access)
// ===============================================
router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], requireExecutorAuth, async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('Not found');
        const emp = await Employee.findById(req.session.executorId);
        if (!emp || (tx.executorBotId && tx.executorBotId.toString() !== emp.botId.toString() && (!tx.managerBotId || tx.managerBotId.toString() !== emp.botId.toString()))) {
             return res.status(403).send('Forbidden');
        }
        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        if (tx.proofImages && tx.proofImages.length > index) { photoId = tx.proofImages[index]; }
        else if (tx.proofImage && index === 0) { photoId = tx.proofImage; }
        if (!photoId) return res.status(404).send('No photo');

        let tokensToTry = [process.env.ADMIN_BOT_TOKEN, process.env.CLIENT_BOT_TOKEN];
        if (tx.executorBotId) { const execBot = await ExecutorBot.findById(tx.executorBotId); if (execBot && execBot.token) tokensToTry.push(execBot.token); }
        if (tx.clientBotId) { const clientBot = await ClientBot.findById(tx.clientBotId); if (clientBot && clientBot.token) tokensToTry.push(clientBot.token); }
        let fileLink = null;
        for (const token of tokensToTry) { try { const api = new Telegram(token); fileLink = await api.getFileLink(photoId); if (fileLink) break; } catch(e) {} }
        if (!fileLink) return res.status(404).send('Cannot access photo');
        https.get(fileLink.href, (response) => { res.set('Content-Type', response.headers['content-type']); response.pipe(res); }).on('error', () => { res.status(500).send('Error'); });
    } catch (error) { console.error(error); res.status(500).send('Server error'); }
});

router.get('/dashboard', requireExecutorAuth, async (req, res) => {
    const emp = await Employee.findById(req.session.executorId).populate('botId');
    res.render('executor/dashboard', { emp });
});

// ===============================================
// 👥 إدارة الموظفين (للمدير فقط)
// ===============================================
const requireManager = async (req, res, next) => {
    const emp = await Employee.findById(req.session.executorId);
    if (!emp || emp.role !== 'manager') return res.status(403).json({ success: false, error: 'Forbidden' });
    req.managerEmp = emp;
    next();
};

router.get('/employees', requireExecutorAuth, requireManager, async (req, res) => {
    const emp = await Employee.findById(req.session.executorId).populate('botId');
    res.render('executor/employees', { emp });
});

router.get('/employees/list', requireExecutorAuth, requireManager, async (req, res) => {
    try {
        const employees = await Employee.find({ botId: req.managerEmp.botId }).sort({ role: 1, createdAt: -1 }).lean();
        res.json({ success: true, employees });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/employees/create', requireExecutorAuth, requireManager, async (req, res) => {
    try {
        const { name, phone, role, webUsername, webPassword } = req.body;
        if (!name || !webUsername || !webPassword) return res.json({ success: false, error: 'Missing fields' });
        if (!['operator', 'accountant'].includes(role)) return res.json({ success: false, error: 'Invalid role' });
        const prefix = webUsername.replace(/@ahram\\.com$/i, '').trim();
        if (!/^[a-zA-Z0-9_]+$/.test(prefix)) return res.json({ success: false, error: 'Invalid username' });
        const finalUsername = prefix + '@ahram.com';
        const existing = await Employee.findOne({ webUsername: finalUsername });
        if (existing) return res.json({ success: false, error: 'Username taken' });
        await Employee.create({ name, phone: phone || '', role, status: 'active', botId: req.managerEmp.botId, webUsername: finalUsername, webPassword });
        res.json({ success: true, username: finalUsername });
    } catch (e) { console.error(e); res.json({ success: false, error: e.message }); }
});

router.post('/employees/toggle/:id', requireExecutorAuth, requireManager, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp || emp.botId.toString() !== req.managerEmp.botId.toString()) return res.json({ success: false });
        if (emp.role === 'manager') return res.json({ success: false, error: 'Cannot toggle manager' });
        emp.status = emp.status === 'active' ? 'suspended' : 'active';
        await emp.save();
        res.json({ success: true, newStatus: emp.status });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/employees/reset-password/:id', requireExecutorAuth, requireManager, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp || emp.botId.toString() !== req.managerEmp.botId.toString()) return res.json({ success: false });
        if (emp.role === 'manager') return res.json({ success: false, error: 'Not allowed' });
        emp.webPassword = req.body.newPassword;
        await emp.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/employees/delete/:id', requireExecutorAuth, requireManager, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp || emp.botId.toString() !== req.managerEmp.botId.toString()) return res.json({ success: false });
        if (emp.role === 'manager') return res.json({ success: false, error: 'Cannot delete manager' });
        await Employee.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// ===============================================
// 🔗 توليد رمز تفعيل التليجرام
// ===============================================
router.post('/link-telegram-token', requireExecutorAuth, async (req, res) => {
    try {
        const crypto = require('crypto');
        const token = crypto.randomBytes(16).toString('hex');
        const expires = new Date(Date.now() + 15 * 60 * 1000);
        const emp = await Employee.findById(req.session.executorId).populate('botId');
        if (!emp || !emp.botId) return res.status(404).json({ error: 'Not found' });
        emp.telegramLinkToken = token;
        emp.telegramLinkExpires = expires;
        await emp.save();
        const botUsername = emp.botId.botUsername ? emp.botId.botUsername.replace('@', '') : 'AhramExecBot';
        res.json({ success: true, link: 'https://t.me/' + botUsername + '?start=' + token });
    } catch (e) {
        res.status(500).json({ error: 'Error generating link' });
    }
});`;

const newLines = [...beforeDamage, ...fixedSection.split('\n'), ...afterDamage];
fs.writeFileSync(path, newLines.join('\n'), 'utf8');
console.log('File fixed successfully! Total lines:', newLines.length);
