const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const User = require('../models/User');
const ExecutorBot = require('../models/ExecutorGroup');
const ClientBot = require('../models/ClientBot');
const { requireAuth } = require('../middlewares/auth');

router.get('/employees', requireAuth, async (req, res) => {
    const [rawExecutorEmployees, rawClientEmployees, rawAgentEmployees, executors, clients, agents] = await Promise.all([
        Employee.find({ archivedAt: null }).lean(),
        ClientEmployee.find({ status: { $ne: 'deleted' } }).lean(),
        AgentEmployee.find({ status: { $ne: 'deleted' } }).lean(),
        ExecutorBot.find({ status: { $ne: 'archived' } }).select('name').lean(),
        ClientBot.find({ status: { $ne: 'deleted' } }).select('name').lean(),
        User.find({ role: 'agent', status: { $ne: 'deleted' } }).select('name').lean()
    ]);

    const executorBotsMap = {};
    executors.forEach((executor) => { executorBotsMap[String(executor._id)] = executor.name; });
    const clientBotsMap = {};
    clients.forEach((client) => { clientBotsMap[String(client._id)] = client.name; });
    agents.forEach((agent) => { clientBotsMap[String(agent._id)] = agent.name; });

    const execEmployees = rawExecutorEmployees.map((employee) => ({
        ...employee,
        botId: employee.groupId,
        editType: 'executor-employee',
        accountTypeLabel: 'موظف منفذ'
    }));
    const clientEmployees = [
        ...rawClientEmployees.map((employee) => ({
            ...employee,
            clientBotId: employee.companyId,
            editType: 'client-employee',
            accountTypeLabel: 'موظف شركة'
        })),
        ...rawAgentEmployees.map((employee) => ({
            ...employee,
            clientBotId: employee.agentId,
            editType: 'agent-employee',
            accountTypeLabel: 'موظف وكيل'
        }))
    ];

    res.render('employees', {
        execEmployees,
        clientEmployees,
        executorBotsMap,
        clientBotsMap,
        activeEmployeeSection: req.query.section === 'clients' ? 'clients' : 'executors',
        isMaster: req.session.adminRole === 'master',
        query: req.query || {}
    });
});

router.post('/employees/executor/:id/toggle', requireAuth, async (req, res) => {
    const emp = await Employee.findById(req.params.id); emp.status = emp.status === 'active' ? 'banned' : 'active'; await emp.save(); res.redirect('/employees');
});

router.post('/employees/client/:id/toggle', requireAuth, async (req, res) => {
    const emp = await ClientEmployee.findById(req.params.id); emp.status = emp.status === 'active' ? 'banned' : 'active'; await emp.save(); res.redirect('/employees');
});

router.post('/employees/agent/:id/toggle', requireAuth, async (req, res) => {
    const emp = await AgentEmployee.findById(req.params.id); emp.status = emp.status === 'active' ? 'banned' : 'active'; await emp.save(); res.redirect('/employees?section=clients');
});

module.exports = router;
