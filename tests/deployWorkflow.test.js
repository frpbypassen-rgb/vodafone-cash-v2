'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const workflowPath = path.join(__dirname, '../.github/workflows/deploy.yml');

const loadWorkflow = () => {
    const text = fs.readFileSync(workflowPath, 'utf8');
    const doc = yaml.load(text);
    // js-yaml 3 treated the bare key "on" as boolean true. Keep both shapes.
    const trigger = doc.on || doc.true;
    return { text, doc, trigger };
};

const collectSteps = (doc) => Object.values(doc.jobs || {}).flatMap((job) => job.steps || []);

describe('deploy workflow', () => {
    const { text, doc, trigger } = loadWorkflow();
    const gateJob = doc.jobs['verify-ci'];
    const deployJob = doc.jobs.deploy;
    const gateScript = gateJob.steps.find((step) => step.id === 'gate').with.script;
    const deployScripts = collectSteps({ jobs: { deploy: deployJob } })
        .map((step) => step.run || '')
        .join('\n');

    test('is manual workflow_dispatch only', () => {
        // Match the trigger key only. The CI gate reads workflow_runs from the API.
        expect(text).not.toMatch(/(^|\n)\s*workflow_run\s*:/);
        expect(trigger.workflow_run).toBeUndefined();
        expect(Object.keys(trigger)).toEqual(['workflow_dispatch']);

        const confirmSha = trigger.workflow_dispatch.inputs.confirm_sha;
        expect(confirmSha.required).toBe(true);
        expect(confirmSha.type).toBe('string');
        expect(confirmSha.description).toMatch(/40-character/);

        const applyRepair = trigger.workflow_dispatch.inputs.apply_repair;
        expect(applyRepair.required).toBe(false);
        expect(applyRepair.type).toBe('boolean');
        expect(applyRepair.default).toBe(false);
    });

    test('requires main, the typed SHA, and a successful CI run for that SHA', () => {
        expect(gateJob).toBeTruthy();
        expect(gateScript).toContain("context.ref !== 'refs/heads/main'");
        expect(gateScript).toContain('/^[0-9a-f]{40}$/');
        expect(gateScript).toContain('sha !== String(context.sha || \'\').toLowerCase()');
        expect(gateScript).toContain("workflow_id: 'ci-cd.yml'");
        expect(gateScript).toContain('head_sha: sha');
        expect(gateScript).toContain("run.conclusion === 'success'");
        expect(gateScript).toContain('core.setFailed');
        expect(deployJob.needs).toEqual(['verify-ci']);
        expect(deployJob.if).toBeUndefined();
        expect(gateJob['continue-on-error']).toBeUndefined();
        expect(deployJob['continue-on-error']).toBeUndefined();
        expect(text.includes('continue-on-error')).toBe(false);

        for (const step of collectSteps(doc)) {
            expect(step['continue-on-error']).toBeUndefined();
            if (typeof step.if === 'string') {
                expect(step.if).not.toMatch(/failure\(\)|always\(\)/);
            }
        }
    });

    test('deploys only through the production environment', () => {
        expect(deployJob.environment).toBe('production');
    });

    test('does not run tenant migration from the deploy path', () => {
        const executableLines = text.split('\n').filter((line) => {
            const code = line.replace(/#.*/, '').trim();
            return /migrateTenantIsolation/.test(code);
        });
        expect(executableLines).toEqual([]);
        expect(text.includes('migrateTenantIsolation.js --apply --create-default')).toBe(false);
        expect(text.includes('node scripts/migrateTenantIsolation')).toBe(false);
    });

    test('previews env repair unless apply_repair is explicitly true', () => {
        expect(deployJob.env.APPLY_ENV_REPAIR).toBe("${{ inputs.apply_repair == true && 'true' || 'false' }}");
        expect(deployScripts).toContain('if [ "${APPLY_ENV_REPAIR:-false}" = "true" ]; then');
        expect(deployScripts).toContain('node scripts/repairProductionEnv.js .env --apply');
        expect(deployScripts).toContain('node scripts/repairProductionEnv.js .env\n');

        const repairApplyLines = deployScripts.split('\n').filter((line) => (
            /node\s+scripts\/repairProductionEnv\.js\s+\.env\s+--apply/.test(line)
        ));
        expect(repairApplyLines).toHaveLength(1);
        const applyIndex = deployScripts.indexOf('node scripts/repairProductionEnv.js .env --apply');
        const guardIndex = deployScripts.indexOf('if [ "${APPLY_ENV_REPAIR:-false}" = "true" ]; then');
        const elseIndex = deployScripts.indexOf('else', guardIndex);
        const previewIndex = deployScripts.indexOf('node scripts/repairProductionEnv.js .env\n', elseIndex);
        expect(guardIndex).toBeGreaterThanOrEqual(0);
        expect(applyIndex).toBeGreaterThan(guardIndex);
        expect(applyIndex).toBeLessThan(elseIndex);
        expect(previewIndex).toBeGreaterThan(elseIndex);
    });
});
