/** Server-side Resala API client. PINs and message contents are sensitive. */
const BASE_URL = 'https://dev.resala.ly/api/v1/';
const PROVIDER_ERROR_TYPES = [
    'AccountExpired', 'InsufficientCredit', 'BadRequest', 'Unauthorized',
    'TokenExpired', 'Forbidden', 'NotFound', 'InputValidation',
] as const;

export type ResalaErrorType = typeof PROVIDER_ERROR_TYPES[number]
    | 'ConfigurationError' | 'TransportError' | 'UnexpectedResponse';

export class ResalaError extends Error {
    constructor(
        public readonly type: ResalaErrorType,
        public readonly status: number | null,
        public readonly errors?: Readonly<Record<string, readonly string[]>>,
        public readonly requestId?: string,
    ) {
        super(status === null ? 'Resala: ' + type : 'Resala: ' + type + ' (HTTP ' + status + ')');
        this.name = 'ResalaError';
    }
}

interface SendOptions {
    sender?: string;
    test?: boolean;
}

export interface ResalaPinOptions extends SendOptions {
    service_name?: string;
    len?: 4 | 5 | 6;
    /** Android app signature. */
    autofill?: string;
}

export interface ResalaPinResult {
    id: string;
    pin: string;
    code: string;
    region: string;
    number: string;
    content: string;
    hit_count: number;
    created_at: string;
    updated_at: string;
    sender_name: string;
}

export interface ResalaTemplateRecord {
    phone: string;
    scheduled_at?: string;
    [placeholder: `$${number}`]: string | undefined;
}

export interface ResalaTemplateOptions extends SendOptions {
    /** Libya local time (YYYY-MM-DD HH:MM) or RFC 3339. */
    scheduled_at?: string;
}

export interface ResalaTemplateSendResult {
    queued?: false;
    is_prod: boolean;
    total_messages: number;
    total_free_messages: number;
    total_sent_free_messages: number;
    total_cost: number;
    succeeded: number;
    failed: number;
    failed_numbers: string[];
    invalid_numbers: string[];
    sender_names: Partial<Record<'libyana' | 'almadar' | 'international', string>>;
    sms_template_version: {
        id: string;
        version_number: number;
        body: string;
        status: string;
    };
}

export type ResalaTemplateResult = ResalaTemplateSendResult | {
    queued: true;
    batch_id: string;
    scheduled_at?: string | null;
};

export interface ResalaSentOptions {
    filters?: string;
    q?: string;
    sorts?: string;
    page?: number;
    paginate?: number;
}

export interface ResalaSentMessage {
    id: string;
    code: string;
    region: string;
    number: string;
    content: string;
    source: string;
    status: string;
    pages: number;
    env: string;
    created_at: string;
    updated_at: string;
    sender_name?: string;
}

export interface ResalaSentPage {
    data: ResalaSentMessage[];
    meta: { total: number; per_page: number; current_page: number; last_page: number };
}

type JsonObject = Record<string, unknown>;
type Query = Record<string, string | number | undefined>;

const isObject = (value: unknown): value is JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every(item => typeof item === 'string');
const hasStrings = (value: JsonObject, keys: string[]) =>
    keys.every(key => typeof value[key] === 'string');
const hasNumbers = (value: JsonObject, keys: string[]) =>
    keys.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));

function normalizeLibyanMobile(phone: string): string | undefined {
    const value = phone.trim();
    if (!/^(?:0|218)9[1-4][0-9]{7}$/.test(value)) return undefined;
    return value.startsWith('0') ? '218' + value.slice(1) : value;
}

function providerError(status: number, payload: unknown): ResalaError {
    if (!isObject(payload)) return new ResalaError('UnexpectedResponse', status);
    const type = PROVIDER_ERROR_TYPES.find(candidate => candidate === payload.type) ?? 'UnexpectedResponse';
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : undefined;
    const errors = type === 'InputValidation' && isObject(payload.errors)
        ? Object.fromEntries(Object.entries(payload.errors).flatMap(([field, value]) => {
            if (typeof value === 'string') return [[field, [value]]];
            return isStringArray(value) ? [[field, value]] : [];
        }))
        : undefined;
    return new ResalaError(type, status, errors, requestId);
}

function isPinResult(value: unknown): value is ResalaPinResult {
    return isObject(value)
        && typeof value.pin === 'string' && /^[0-9]{4,6}$/.test(value.pin)
        && hasStrings(value, ['id', 'code', 'region', 'number', 'content', 'created_at', 'updated_at', 'sender_name'])
        && hasNumbers(value, ['hit_count']);
}

function isTemplateResult(value: unknown): value is ResalaTemplateResult {
    if (!isObject(value)) return false;
    if (value.queued === true) {
        return typeof value.batch_id === 'string'
            && (value.scheduled_at == null || typeof value.scheduled_at === 'string');
    }
    const version = value.sms_template_version;
    const senders = value.sender_names;
    return (value.queued === undefined || value.queued === false)
        && typeof value.is_prod === 'boolean'
        && hasNumbers(value, ['total_messages', 'total_free_messages', 'total_sent_free_messages', 'total_cost', 'succeeded', 'failed'])
        && isStringArray(value.failed_numbers) && isStringArray(value.invalid_numbers)
        && isObject(senders)
        && ['libyana', 'almadar', 'international'].every(network => senders[network] === undefined || typeof senders[network] === 'string')
        && isObject(version) && hasStrings(version, ['id', 'body', 'status']) && hasNumbers(version, ['version_number']);
}

function isSentPage(value: unknown): value is ResalaSentPage {
    return isObject(value) && Array.isArray(value.data)
        && value.data.every(item => isObject(item)
            && hasStrings(item, ['id', 'code', 'region', 'number', 'content', 'source', 'status', 'env', 'created_at', 'updated_at'])
            && hasNumbers(item, ['pages'])
            && (item.sender_name === undefined || typeof item.sender_name === 'string'))
        && isObject(value.meta) && hasNumbers(value.meta, ['total', 'per_page', 'current_page', 'last_page']);
}

async function request<T>(
    path: string,
    query: Query,
    statuses: readonly number[],
    validate: (value: unknown) => value is T,
    body?: object,
): Promise<T> {
    const key = process.env.RESALA_API_KEY?.trim();
    if (!key || !/^rsl_[\x21-\x7e]+$/.test(key)) throw new ResalaError('ConfigurationError', null);
    const url = new URL(path, BASE_URL);
    url.search = Object.entries(query)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => encodeURIComponent(name) + '=' + encodeURIComponent(String(value)))
        .join('&');

    const headers: Record<string, string> = { Accept: 'application/json', Authorization: 'Bearer ' + key };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
        response = await fetch(url, {
            method: body === undefined ? 'GET' : 'POST',
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
        });
    } catch {
        // A transport failure can occur after a send was accepted. Never retry here.
        throw new ResalaError('TransportError', null);
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw providerError(response.status, payload);
    if (!statuses.includes(response.status) || !validate(payload)) {
        throw new ResalaError('UnexpectedResponse', response.status);
    }
    return payload;
}

/** Generates a PIN for server-side verification and sends it by SMS. */
export async function sendResalaPin(phone: string, options: ResalaPinOptions = {}): Promise<ResalaPinResult> {
    const normalized = normalizeLibyanMobile(phone);
    if (!normalized) {
        throw new ResalaError('InputValidation', 422, { phone: ['Enter a Libyan mobile number.'] });
    }
    const { service_name, test, len, autofill, sender } = options;
    return request('pins', { service_name, test: test ? '' : undefined, len, autofill, sender }, [201], isPinResult, {
        phone: normalized,
    });
}

/** Keeps invalid rows in the batch so Resala reports them in invalid_numbers. */
export async function sendResalaTemplate(
    smsTemplateId: string,
    records: readonly ResalaTemplateRecord[],
    options: ResalaTemplateOptions = {},
): Promise<ResalaTemplateResult> {
    const { test, sender, scheduled_at } = options;
    return request('messages/send-template', {
        sms_template_id: smsTemplateId, test: test ? '' : undefined, sender, scheduled_at,
    }, [201, 202], isTemplateResult, { records });
}

export async function listResalaSent(options: ResalaSentOptions = {}): Promise<ResalaSentPage> {
    const { filters, q, sorts, page, paginate } = options;
    return request('sent-view', { filters, q, sorts, page, paginate }, [200], isSentPage);
}
