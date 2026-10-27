'use strict';
// Reads account-directory metadata only. Never imports application services or changes API credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const csvCell = (value) => {
    const text = String(value ?? '').replace(/\0/g, '');
    const safe =
        /^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)
            ? "'" + text
            : text;
    return '"' + safe.replace(/"/g, '""') + '"';
};
const buildChecklist = (rows, publicOrigin = '') => {
    const columns = [
        'account_type',
        'account_reference',
        'account_name',
        'expected_base_url',
        'verified_client_base_url',
        'reviewed_by',
        'reviewed_at',
        'notes',
    ];
    const expected = publicOrigin ? publicOrigin + '/api/v1/merchant' : '';
    const lines = [columns.map(csvCell).join(',')];
    for (const row of rows)
        lines.push(
            [
                row.accountType,
                row.accountCode || row.agentCode || String(row._id || ''),
                row.name || '',
                expected,
                '',
                '',
                '',
                '',
            ]
                .map(csvCell)
                .join(','),
        );
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
};
const loadAccounts = async (db, limit = 500) => {
    const rows = [];
    let truncated = false;
    // Include legacy credentials even when the current admin gate is off. Existence is queried, never its value.
    const filter = { status: 'active' };
    for (const [collection, accountType, extra] of [
        ['clientcompanies', 'company', {}],
        ['users', 'agent', { role: 'agent' }],
    ]) {
        const legacyField = accountType === 'company' ? 'token' : 'apiToken';
        const found = await db
            .collection(collection)
            .find(
                {
                    ...filter,
                    ...extra,
                    $or: [
                        { 'integrationAccess.apiEnabled': true },
                        { merchantApiKeyHash: { $type: 'string', $ne: '' } },
                        { [legacyField]: { $type: 'string', $ne: '' } },
                    ],
                },
                {
                    projection: {
                        _id: 1,
                        name: 1,
                        accountCode: 1,
                        agentCode: 1,
                    },
                },
            )
            .limit(limit + 1)
            .maxTimeMS(1500)
            .toArray();
        if (found.length > limit) truncated = true;
        rows.push(
            ...found.slice(0, limit).map((row) => ({
                accountType,
                _id: row._id,
                name: row.name,
                accountCode: row.accountCode,
                agentCode: row.agentCode,
            })),
        );
    }
    return { rows, truncated };
};
const safeConfiguredOrigin = (env) => {
    try {
        const url = new URL(String(env.PUBLIC_APP_URL || env.APP_URL || ''));
        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== '/'
        )
            return '';
        return url.origin;
    } catch {
        return '';
    }
};

const createPrivateReviewDirectory = (root) => {
    root = fs.realpathSync(root);
    const parent = path.join(root, 'runtime-routing-review');
    if (fs.existsSync(parent) && fs.realpathSync(parent) !== parent)
        throw new Error('UNSAFE_CHECKLIST_PATH');
    fs.mkdirSync(parent, { recursive: true });
    const folder = path.join(parent, crypto.randomBytes(12).toString('hex'));
    fs.mkdirSync(folder, { mode: 0o700 });
    if (process.platform === 'win32') {
        // Protect a new empty directory before writing account metadata; chmod alone does not restrict Windows DACLs.
        const script = String.raw`
$ErrorActionPreference = 'Stop'
$folder = $env:AHRAM_CHECKLIST_DIRECTORY
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
$acl = [Security.AccessControl.DirectorySecurity]::new()
$sddl = 'D:P(A;OICI;FA;;;' + $owner + ')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$acl.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::Access)
[IO.Directory]::SetAccessControl($folder, $acl)
$actual = [IO.Directory]::GetAccessControl($folder)
if (-not $actual.AreAccessRulesProtected) { exit 31 }
$rules = $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
foreach ($rule in $rules) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin $allowed) { exit 32 }
    if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { exit 33 }
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    if (($rule.InheritanceFlags -band $inherit) -ne $inherit) { exit 35 }
}
foreach ($sid in $allowed) {
    $found = $false
    foreach ($rule in $rules) { if ($rule.IdentityReference.Value -eq $sid) { $found = $true } }
    if (-not $found) { exit 34 }
}
[Console]::WriteLine('ACL_OK')
`;
        try {
            const result = execFileSync(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', script],
                {
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 10000,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, AHRAM_CHECKLIST_DIRECTORY: folder },
                },
            );
            if (result.trim() !== 'ACL_OK')
                throw new Error('CHECKLIST_ACL_FAILED');
        } catch {
            throw new Error('CHECKLIST_ACL_FAILED');
        }
    } else fs.chmodSync(folder, 0o700);
    if (fs.realpathSync(folder) !== folder)
        throw new Error('UNSAFE_CHECKLIST_PATH');
    return folder;
};

const scanStaticOrigins = (source) => {
    const directory = path.join(source, 'flutter');
    const result = {
        available: fs.existsSync(directory),
        scannedFiles: 0,
        truncated: false,
        hints: [],
    };
    if (!result.available) return result;
    let bytes = 0,
        directories = 0;
    const seen = new Set();
    const walk = (folder, depth = 0) => {
        if (
            ++directories > 256 ||
            depth > 8 ||
            result.scannedFiles >= 200 ||
            bytes > 5 * 1024 * 1024
        ) {
            result.truncated = true;
            return;
        }
        if (
            fs.lstatSync(folder).isSymbolicLink() ||
            fs.realpathSync(folder) !== folder
        )
            return;
        for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
            if (
                item.isSymbolicLink() ||
                item.name.startsWith('.') ||
                ['build', 'test', 'tests', 'Pods', 'node_modules'].includes(
                    item.name,
                )
            )
                continue;
            const file = path.join(folder, item.name);
            if (item.isDirectory()) {
                walk(file, depth + 1);
                continue;
            }
            if (!item.isFile() || !item.name.endsWith('.dart')) continue;
            const size = fs.statSync(file).size;
            if (
                size > 128 * 1024 ||
                result.scannedFiles >= 200 ||
                bytes + size > 5 * 1024 * 1024
            ) {
                result.truncated = true;
                continue;
            }
            const text = fs.readFileSync(file, 'utf8');
            bytes += size;
            result.scannedFiles++;
            for (const match of text.matchAll(/https?:\/\/[^\s"'<>`]+/g)) {
                try {
                    const url = new URL(match[0]);
                    if (
                        url.port !== '3000' &&
                        ![
                            'ahrampay.com',
                            'www.ahrampay.com',
                            '102.213.183.6',
                        ].includes(url.hostname.toLowerCase())
                    )
                        continue;
                    const key = url.origin + '\0' + path.relative(source, file);
                    if (seen.has(key) || result.hints.length >= 30) continue;
                    seen.add(key);
                    result.hints.push({
                        origin: url.origin,
                        file: path.relative(source, file),
                        sourceCodeOnly: true,
                    });
                } catch {
                    /* Dynamic URLs and unrelated source literals require manual verification. */
                }
            }
        }
    };
    walk(directory);
    return result;
};
const main = async () => {
    const index = process.argv.indexOf('--candidate');
    if (index < 0 || !process.argv[index + 1])
        throw new Error('CANDIDATE_ARGUMENT_REQUIRED');
    const root = fs.realpathSync(process.argv[index + 1]);
    const sourceIndex = process.argv.indexOf('--source');
    const originHints =
        sourceIndex >= 0 && process.argv[sourceIndex + 1]
            ? scanStaticOrigins(fs.realpathSync(process.argv[sourceIndex + 1]))
            : { available: false, hints: [] };
    const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (revision !== 'f587e44c84f9ca3583b4a11c537f2f8ef0ebedd3')
        throw new Error('UNEXPECTED_CANDIDATE_REVISION');
    const load = createRequire(path.join(root, 'package.json'));
    const env = {
        ...load('dotenv').parse(fs.readFileSync(path.join(root, '.env'))),
        ...process.env,
    };
    if (!/^mongodb(?:\+srv)?:\/\//.test(env.MONGO_URI || ''))
        throw new Error('DATABASE_NOT_CONFIGURED');
    const reviewRoot = path.join(root, 'runtime-routing-review');
    if (fs.existsSync(reviewRoot) && fs.realpathSync(reviewRoot) !== reviewRoot)
        throw new Error('UNSAFE_CHECKLIST_PATH');
    const { MongoClient } = load('mongodb');
    const client = new MongoClient(env.MONGO_URI, {
        maxPoolSize: 1,
        minPoolSize: 0,
        retryReads: false,
        retryWrites: false,
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        socketTimeoutMS: 5000,
    });
    let result;
    try {
        await client.connect();
        result = await loadAccounts(client.db());
    } finally {
        await client.close();
    }
    const directory = createPrivateReviewDirectory(root);
    const outputPath = path.join(
        directory,
        `api-routing-checklist-${crypto.randomBytes(8).toString('hex')}.csv`,
    );
    fs.writeFileSync(
        outputPath,
        buildChecklist(result.rows, safeConfiguredOrigin(env)),
        { flag: 'wx', mode: 0o600 },
    );
    process.stdout.write(
        JSON.stringify(
            {
                readOnlyDatabase: true,
                applicationStarted: false,
                accountSettingsChanged: false,
                outputPath,
                privateDirectoryProtection:
                    process.platform === 'win32'
                        ? 'verified-windows-dacl'
                        : 'posix-0700',
                companies: result.rows.filter(
                    (row) => row.accountType === 'company',
                ).length,
                agents: result.rows.filter((row) => row.accountType === 'agent')
                    .length,
                truncated: result.truncated,
                allClientUrlsVerified: false,
                staticOriginHints: originHints,
                scope: 'Company and agent directory only; mobile/executor configurations need separate confirmation. Static source URLs do not prove the URLs used by distributed apps.',
                note: 'Configured public URL is a recommendation, not proof of a client endpoint. Fill actual client Base URLs locally; do not include API tokens.',
            },
            null,
            2,
        ) + '\n',
    );
};
module.exports = {
    csvCell,
    buildChecklist,
    loadAccounts,
    scanStaticOrigins,
    createPrivateReviewDirectory,
};
if (require.main === module)
    main().catch((error) => {
        const code = [
            'CANDIDATE_ARGUMENT_REQUIRED',
            'UNEXPECTED_CANDIDATE_REVISION',
            'DATABASE_NOT_CONFIGURED',
            'UNSAFE_CHECKLIST_PATH',
            'CHECKLIST_ACL_FAILED',
        ].includes(error.message)
            ? error.message
            : 'ROUTING_CHECKLIST_EXPORT_FAILED';
        process.stderr.write(
            JSON.stringify({ code, accountSettingsChanged: false }) + '\n',
        );
        process.exitCode = 1;
    });
