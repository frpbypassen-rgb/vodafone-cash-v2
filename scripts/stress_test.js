const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const ExecutorGroup = require('../models/ExecutorGroup');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');

async function runStressTest() {
    console.log('Connecting to DB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected.');

    try {
        console.log('Cleaning old test data...');
        // Clean up previous test data
        await User.deleteMany({ phone: /test_/ });
        await ClientCompany.deleteMany({ name: /TestCompany/ });
        await ClientEmployee.deleteMany({ phone: /test_/ });
        await SubAccount.deleteMany({ name: /TestSubAccount/ });
        await ExecutorGroup.deleteMany({ name: /TestExecutorGroup/ });
        await Employee.deleteMany({ phone: /test_/ });
        await Transaction.deleteMany({ vodafoneNumber: /010000000/ });

        console.log('Creating accounts...');
        // 1. حساب عميل مباشر
        const clientUser = await User.create({
            name: 'Test Client', phone: 'test_client_01', balance: 10000, 
            status: 'active', webUsername: 'test_client', webPassword: '123'
        });

        // 2. حساب شركة
        const clientCompany = await ClientCompany.create({
            name: 'TestCompany', phone: 'test_comp_01', balance: 50000, status: 'active'
        });
        const compEmp = await ClientEmployee.create({
            name: 'Test Comp Emp', phone: 'test_emp_01', role: 'manager', 
            status: 'active', companyId: clientCompany._id, webUsername: 'test_comp_emp', webPassword: '123'
        });

        // 3. حساب عميل جديد تابع لوكالة (نقطة بيع)
        const subAccountUser = await SubAccount.create({
            masterType: 'user', masterId: clientUser._id, name: 'TestSubAccount User',
            phone: 'test_sub_01', balance: 5000, status: 'active', customMargin: 0.1,
            webUsername: 'test_sub_user', webPassword: '123'
        });

        const subAccountComp = await SubAccount.create({
            masterType: 'company', masterId: clientCompany._id, name: 'TestSubAccount Comp',
            phone: 'test_sub_02', balance: 10000, status: 'active', customMargin: 0.1,
            webUsername: 'test_sub_comp', webPassword: '123'
        });

        // 4. حساب منفذ
        const execGroup = await ExecutorGroup.create({
            name: 'TestExecutorGroup', balance: 0, status: 'active', isManagerBot: true, isApiBot: false
        });
        const execEmp = await Employee.create({
            name: 'Test Exec Emp', phone: 'test_exec_01', role: 'manager', 
            status: 'active', groupId: execGroup._id, webUsername: 'test_exec_emp', webPassword: '123'
        });

        // 5. حساب منفذ API
        const apiExecGroup = await ExecutorGroup.create({
            name: 'TestApiExecutorGroup', balance: 0, status: 'active', isManagerBot: true, isApiBot: true
        });

        console.log('Accounts created successfully.');

        console.log('Starting stress test on creating transactions...');
        const startTime = Date.now();
        const NUM_TRANSACTIONS = 500; // Load test with 500 parallel transactions
        
        let successCount = 0;
        let failCount = 0;
        let errors = [];

        // Function to simulate transaction creation
        const createTx = async (i) => {
            try {
                // Determine user context based on i
                let userId = null;
                let companyId = null;
                let subAccountId = null;
                
                if (i % 3 === 0) {
                    userId = clientUser.telegramId || clientUser._id.toString();
                } else if (i % 3 === 1) {
                    companyId = clientCompany._id;
                } else {
                    subAccountId = subAccountComp._id;
                }

                await Transaction.create({
                    customId: `TEST-${Date.now()}-${i}`,
                    userId,
                    companyId: companyId,
                    subAccountId,
                    vodafoneNumber: `010000000${(i % 100).toString().padStart(2, '0')}`,
                    amount: 100,
                    costLYD: 15,
                    status: 'pending',
                    transferType: 'cash',
                });
                successCount++;
            } catch (err) {
                failCount++;
                if (!errors.includes(err.message)) errors.push(err.message);
            }
        };

        const promises = [];
        for (let i = 0; i < NUM_TRANSACTIONS; i++) {
            promises.push(createTx(i));
        }

        await Promise.all(promises);
        const endTime = Date.now();

        console.log('--- STRESS TEST REPORT ---');
        console.log(`Total Requests: ${NUM_TRANSACTIONS}`);
        console.log(`Successful: ${successCount}`);
        console.log(`Failed: ${failCount}`);
        console.log(`Time Taken: ${endTime - startTime} ms`);
        console.log(`Throughput: ${(NUM_TRANSACTIONS / ((endTime - startTime) / 1000)).toFixed(2)} req/sec`);
        console.log(`Errors:`, errors);
        
        process.exit(0);
    } catch (e) {
        console.error('Fatal Error during stress test:', e);
        process.exit(1);
    }
}

runStressTest();
