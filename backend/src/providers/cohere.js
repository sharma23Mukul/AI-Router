/**
 * Cohere Provider
 * 
 * Cohere API using the OpenAI-compatible chat endpoint.
 * Specializes in RAG, search, and enterprise NLP tasks.
 */

const BaseProvider = require('./base');
const { createLogger } = require('../utils/logger');
const logger = createLogger('provider-cohere');

class CohereProvider extends BaseProvider {
    constructor(apiKey) {
        super('cohere', {
            baseURL: 'https://api.cohere.com/compatibility/v1',
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
     * Streaming chat completion.
     */
    async chatCompletionStream(body) {
        const { response, latencyMs, attempt } = await this.request(
            'POST', '/chat/completions',
            { ...body, stream: true },
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

module.exports = CohereProvider;
