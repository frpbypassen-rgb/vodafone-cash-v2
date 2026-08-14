'use strict';

// Local regression check for the atomic executor task claim flow.
const baseUrl = process.env.MOBILE_TEST_BASE_URL || 'http://127.0.0.1:3010/api/mobile';
const taskId = 'DEMO-EXEC-MOBILE-001';

async function login(username, password) {
    const response = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
    return response.json();
}

async function request(path, token, method = 'GET', body) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json() };
}

async function main() {
    const manager = await login('local_exec_manager@ahram.com', 'DemoManager2026!');
    const operator = await login('local_exec_operator@ahram.com', 'DemoOperator2026!');
    const initial = await request('/executor/live-tasks', manager.token);
    const task = (initial.data.data || []).find((item) => item.txId === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const accepted = await request(`/executor/accept-task/${task.id}`, manager.token, 'POST');
    const managerTasks = await request('/executor/live-tasks', manager.token);
    const managerTask = (managerTasks.data.data || []).find((item) => item.id === task.id);
    const operatorTasks = await request('/executor/live-tasks', operator.token);
    const takenTask = (operatorTasks.data.data || []).find((item) => item.id === task.id);
    const secondAccept = await request(`/executor/accept-task/${task.id}`, operator.token, 'POST');
    const secondCancel = await request(
        `/executor/cancel-task/${task.id}`,
        operator.token,
        'POST',
        { reason: 'invalid' }
    );

    console.log(JSON.stringify({
        managerAccept: accepted.status,
        seenByManager: {
            status: managerTask?.status,
            acceptedByName: managerTask?.acceptedByName,
            isOwnedByCurrentExecutor: managerTask?.isOwnedByCurrentExecutor
        },
        seenByOtherExecutor: {
            status: takenTask?.status,
            acceptedByName: takenTask?.acceptedByName,
            operatorIdPresent: Boolean(takenTask?.operatorId),
            isOwnedByCurrentExecutor: takenTask?.isOwnedByCurrentExecutor
        },
        secondAccept: { status: secondAccept.status, code: secondAccept.data.code },
        secondCancel: { status: secondCancel.status, code: secondCancel.data.code }
    }, null, 2));
}

main().catch((error) => {
    console.error(error.stack);
    process.exit(1);
});
