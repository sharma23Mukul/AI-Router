/**
 * Base Provider — Shared HTTP client logic
 * 
 * Handles: retry with jitter, timeout, connection pooling, response parsing.
 */

const axios = require('axios');
const { createLogger } = require('../utils/logger');
const logger = createLogger('provider-base');

class BaseProvider {
    constructor(name, config = {}) {
        this.name = name;
        this.baseURL = config.baseURL || '';
        this.apiKey = config.apiKey || '';
        this.timeout = config.timeout || 60000; // 60s default
        this.maxRetries = config.maxRetries || 2;

        // Connection pool via axios defaults
        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: this.timeout,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            httpAgent: new (require('http').Agent)({ keepAlive: true, maxSockets: 50 }),
            httpsAgent: new (require('https').Agent)({ keepAlive: true, maxSockets: 50 })
        });
    }

    /**
     * Make a request with retry + exponential backoff + jitter.
     */
    async request(method, url, data, headers = {}, options = {}) {
        const maxRetries = options.maxRetries ?? this.maxRetries;
        let lastError;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const startTime = Date.now();
                const response = await this.client.request({
                    method,
                    url,
                    data,
                    headers: {
                        ...headers,
                        ...(this.getAuthHeaders())
                    },
                    responseType: options.stream ? 'stream' : 'json',
                    timeout: options.timeout || this.timeout
                });

                const latencyMs = Date.now() - startTime;
                return { response, latencyMs, attempt };
            } catch (err) {
                lastError = err;
                const status = err.response?.status;

                // Don't retry on 4xx (except 429)
                if (status && status >= 400 && status < 500 && status !== 429) {
                    throw this._wrapError(err, attempt);
                }

                // Retry on 429, 5xx, network errors
                if (attempt < maxRetries) {
                    const backoff = Math.min(1000 * Math.pow(2, attempt), 10000);
                    const jitter = Math.random() * backoff * 0.5;
                    const delay = backoff + jitter;
                    logger.warn({ provider: this.name, attempt, status, delay: Math.round(delay) },
                        'Request failed, retrying');
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }

        throw this._wrapError(lastError, maxRetries);
    }

    /**
     * Override in subclasses to provide auth headers.
     */
    getAuthHeaders() {
        return {};
    }

    /**
     * Wrap axios errors into a standardized format.
     */
    _wrapError(err, attempt) {
        const status = err.response?.status || 0;
        // Handle both OpenAI format ({error: {message}}) and
        // Gemini format ([{error: {message}}]) error responses
        const data = err.response?.data;
        let message;
        if (Array.isArray(data)) {
            message = data[0]?.error?.message;
        } else {
            message = data?.error?.message;
        }
        message = message || err.message;

        const timedOut = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';

        const error = new Error(`[${this.name}] ${message}`);
        error.provider = this.name;
        error.status = status;
        error.timedOut = timedOut;
        error.attempt = attempt;
        error.originalError = err;
        return error;
    }
}

module.exports = BaseProvider;
