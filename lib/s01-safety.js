/** S01: temporary fail-closed mutation boundary. NOT a replacement for S02-S04. */
export class SafetyError extends Error {
    constructor(code, message, status = 409) {
        super(message);
        this.name = 'SafetyError';
        this.code = code;
        this.status = status;
    }
}

export const S01_BLOCKED_MUTATION_ROUTES = Object.freeze([
    { method: 'POST', pattern: /^\/chunks\/insert\/?$/ },
    { method: 'PATCH', pattern: /^\/chunks\/[^/]+\/(?:text|metadata)\/?$/ },
    { method: 'POST', pattern: /^\/chunks\/(?:delete|purge)\/?$/ },
    { method: 'POST', pattern: /^\/purge-all\/?$/ },
]);

export function denyUnsafeBackendMutation(backend, operation) {
    throw new SafetyError('S01_MUTATION_BLOCKED',
        `${backend} ${operation} is disabled pending S02-S04 identity, authorization and verified mutation contracts.`);
}

export function s01MutationGuard(req, res, next) {
    const method = String(req.method || '').toUpperCase();
    const routePath = String(req.path || req.url?.split('?')[0] || '');
    if (!S01_BLOCKED_MUTATION_ROUTES.some(r => r.method === method && r.pattern.test(routePath))) {
        return next();
    }
    return res.status(409).json({
        success: false,
        code: 'S01_MUTATION_BLOCKED',
        error: 'Legacy mutation route disabled pending safe identity, authorization and readback contracts.',
        retryable: false,
        checkpoint: 'S01',
    });
}
