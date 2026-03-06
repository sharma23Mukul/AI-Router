/**
 * Gemini Provider
 * 
 * Google Gemini API using the OpenAI-compatible endpoint.
 * Translates responses to OpenAI format for consistent client experience.
 */

const BaseProvider = require('./base');
const { createLogger } = require('../utils/logger');
const logger = createLogger('provider-gemini');

class GeminiProvider extends BaseProvider {
    constructor(apiKey) {
        super('gemini', {
            baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
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
     * Gemini's OpenAI-compatible endpoint returns OpenAI format natively.
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
     * Gemini's OpenAI-compatible endpoint supports SSE streaming natively.
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

module.exports = GeminiProvider;
