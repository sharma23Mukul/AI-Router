/**
 * OpenAI Provider
 * 
 * Handles: real API calls, streaming SSE passthrough, response parsing.
 */

const BaseProvider = require('./base');
const { createLogger } = require('../utils/logger');
const logger = createLogger('provider-openai');

class OpenAIProvider extends BaseProvider {
    constructor(apiKey) {
        super('openai', {
            baseURL: 'https://api.openai.com/v1',
            apiKey,
            timeout: 120000
        });
    }

    getAuthHeaders() {
        return {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Non-streaming chat completion.
     */
    async chatCompletion(body) {
        const { response, latencyMs, attempt } = await this.request(
            'POST', '/chat/completions',
            { ...body, stream: false }
        );

        const data = response.data;
        return {
            data,
            latencyMs,
            attempt,
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
            status: response.status
        };
    }

    /**
     * Streaming chat completion — returns the raw response stream.
     * Caller is responsible for piping to client.
     */
    async chatCompletionStream(body) {
        const { response, latencyMs, attempt } = await this.request(
            'POST', '/chat/completions',
            { ...body, stream: true, stream_options: { include_usage: true } },
            {},
            { stream: true }
        );

        return {
            stream: response.data,
            latencyMs,
            attempt,
            status: response.status,
            headers: response.headers
        };
    }
}

module.exports = OpenAIProvider;
