/**
 * Groq Provider
 * 
 * Groq API using the OpenAI-compatible endpoint.
 * Ultra-fast inference on open-source models (LLaMA, Mixtral, Gemma).
 */

const BaseProvider = require('./base');
const { createLogger } = require('../utils/logger');
const logger = createLogger('provider-groq');

class GroqProvider extends BaseProvider {
    constructor(apiKey) {
        super('groq', {
            baseURL: 'https://api.groq.com/openai/v1',
            apiKey,
            timeout: 60000
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
     * Streaming chat completion.
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

module.exports = GroqProvider;
