/**
 * Auth Middleware — API key authentication
 * 
 * Extracts API key from Authorization header (Bearer token) or x-api-key header.
 * In local dev mode (no tenants), passes through with no auth.
 * For tenant requests, validates against hashed keys in DB.
 */

const { createLogger } = require('../utils/logger');
const logger = createLogger('auth');

function createAuthMiddleware(tenantManager) {
    return (req, res, next) => {
        // Extract API key
        let apiKey = null;

        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            apiKey = authHeader.slice(7).trim();
        }

        if (!apiKey && req.headers['x-api-key']) {
            apiKey = req.headers['x-api-key'].trim();
        }

        // If no API key, allow in pass-through mode (local dev)
        if (!apiKey) {
            req.tenant = null;
            req.tenantId = null;
            return next();
        }

        // Skip auth for internal keys (e.g., OPENAI_API_KEY being passed through)
        if (apiKey.startsWith('sk-') || apiKey.startsWith('ant-')) {
            req.tenant = null;
            req.tenantId = null;
            return next();
        }

        // Validate tenant API key
        if (apiKey.startsWith('fra_')) {
            const tenant = tenantManager.authenticate(apiKey);
            if (!tenant) {
                return res.status(401).json({
                    error: {
                        message: 'Invalid API key',
                        type: 'authentication_error',
                        code: 'invalid_api_key'
                    }
                });
            }

            // Check budget
            if (!tenantManager.isWithinBudget(tenant)) {
                return res.status(429).json({
                    error: {
                        message: 'Monthly budget limit exceeded',
                        type: 'quota_exceeded',
                        code: 'budget_exceeded'
                    }
                });
            }

            req.tenant = tenant;
            req.tenantId = tenant.id;
            return next();
        }

        // Unknown key format — pass through
        req.tenant = null;
        req.tenantId = null;
        next();
    };
}

module.exports = { createAuthMiddleware };
