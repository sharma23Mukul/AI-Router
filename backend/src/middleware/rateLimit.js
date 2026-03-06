/**
 * Rate Limit Middleware — Token bucket per-tenant + global
 * 
 * Per-tenant: RPM (requests per minute) from tenant config.
 * Global: max concurrent active requests (backpressure).
 */

const { createLogger } = require('../utils/logger');
const logger = createLogger('rate-limit');

// ────────────────────────────────────────────
// Token Bucket Rate Limiter
// ────────────────────────────────────────────
class TokenBucket {
    constructor(rate, capacity) {
        this.rate = rate;         // tokens per second
        this.capacity = capacity; // max bucket size
        this.tokens = capacity;
        this.lastRefill = Date.now();
    }

    consume(count = 1) {
        this._refill();
        if (this.tokens >= count) {
            this.tokens -= count;
            return true;
        }
        return false;
    }

    _refill() {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
        this.lastRefill = now;
    }

    get remaining() {
        this._refill();
        return Math.floor(this.tokens);
    }
}

// ────────────────────────────────────────────
// Rate Limit Registry
// ────────────────────────────────────────────
const buckets = new Map(); // tenantId → TokenBucket

function getBucket(tenantId, rpmLimit) {
    if (!buckets.has(tenantId)) {
        // Convert RPM to tokens/second
        const rate = rpmLimit / 60;
        buckets.set(tenantId, new TokenBucket(rate, rpmLimit));
    }
    return buckets.get(tenantId);
}

// ────────────────────────────────────────────
// Concurrency Limiter (global backpressure)
// ────────────────────────────────────────────
let activeRequests = 0;
const MAX_CONCURRENT = 100;

function createRateLimitMiddleware() {
    return (req, res, next) => {
        // Global concurrency limit
        if (activeRequests >= MAX_CONCURRENT) {
            logger.warn({ active: activeRequests }, 'Concurrency limit reached');
            return res.status(429).json({
                error: {
                    message: 'Server at capacity. Please retry later.',
                    type: 'rate_limit_error',
                    code: 'concurrency_limit'
                }
            });
        }

        // Per-tenant rate limit
        if (req.tenant) {
            const bucket = getBucket(req.tenant.id, req.tenant.rate_limit_rpm || 60);
            if (!bucket.consume()) {
                return res.status(429).json({
                    error: {
                        message: `Rate limit exceeded. Limit: ${req.tenant.rate_limit_rpm} RPM`,
                        type: 'rate_limit_error',
                        code: 'rpm_exceeded'
                    }
                });
            }

            // Add rate limit headers
            res.setHeader('X-RateLimit-Limit', req.tenant.rate_limit_rpm);
            res.setHeader('X-RateLimit-Remaining', bucket.remaining);
        }

        // Track active requests
        activeRequests++;
        res.on('finish', () => { activeRequests--; });
        res.on('close', () => { activeRequests--; });

        // Prevent double-decrement
        let decremented = false;
        const origFinish = res.emit.bind(res);
        res.emit = function (event, ...args) {
            if ((event === 'finish' || event === 'close') && !decremented) {
                decremented = true;
            }
            return origFinish(event, ...args);
        };

        next();
    };
}

function getActiveRequests() {
    return activeRequests;
}

module.exports = { createRateLimitMiddleware, getActiveRequests, MAX_CONCURRENT };
