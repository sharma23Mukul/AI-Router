/**
 * Anthropic Provider
 * 
 * Translates OpenAI-format requests to Anthropic Message API format
 * and translates responses back to OpenAI format for consistent client experience.
 * Handles streaming SSE with chunk boundary buffering.
 */

const BaseProvider = require('./base');
const { Transform } = require('stream');
const { createLogger } = require('../utils/logger');
const logger = createLogger('provider-anthropic');

class AnthropicProvider extends BaseProvider {
    constructor(apiKey) {
        super('anthropic', {
            baseURL: 'https://api.anthropic.com/v1',
            apiKey,
            timeout: 120000
        });
    }

    getAuthHeaders() {
        return {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
        };
    }

    /**
     * Convert OpenAI-format messages to Anthropic format.
     */
    _convertToAnthropicFormat(body) {
        const messages = body.messages || [];
        let system = '';
        const anthropicMessages = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                system += (system ? '\n' : '') + msg.content;
            } else {
                anthropicMessages.push({
                    role: msg.role === 'assistant' ? 'assistant' : 'user',
                    content: msg.content
                });
            }
        }

        const anthropicBody = {
            model: body.model,
            messages: anthropicMessages,
            max_tokens: body.max_tokens || 4096
        };

        if (system) {
            anthropicBody.system = system;
        }
        if (body.temperature !== undefined) {
            anthropicBody.temperature = body.temperature;
        }
        if (body.top_p !== undefined) {
            anthropicBody.top_p = body.top_p;
        }

        return anthropicBody;
    }

    /**
     * Convert Anthropic response to OpenAI format.
     */
    _convertToOpenAIFormat(anthropicResponse, model) {
        const content = anthropicResponse.content
            ?.map(c => c.type === 'text' ? c.text : '')
            .join('') || '';

        return {
            id: `chatcmpl-${anthropicResponse.id || Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content
                },
                finish_reason: anthropicResponse.stop_reason === 'end_turn' ? 'stop' :
                    anthropicResponse.stop_reason === 'max_tokens' ? 'length' : 'stop'
            }],
            usage: {
                prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
                completion_tokens: anthropicResponse.usage?.output_tokens || 0,
                total_tokens: (anthropicResponse.usage?.input_tokens || 0) +
                    (anthropicResponse.usage?.output_tokens || 0)
            }
        };
    }

    /**
     * Non-streaming chat completion.
     */
    async chatCompletion(body) {
        const anthropicBody = this._convertToAnthropicFormat(body);

        const { response, latencyMs, attempt } = await this.request(
            'POST', '/messages', anthropicBody
        );

        const data = this._convertToOpenAIFormat(response.data, body.model);
        return {
            data,
            latencyMs,
            attempt,
            inputTokens: response.data.usage?.input_tokens || 0,
            outputTokens: response.data.usage?.output_tokens || 0,
            status: response.status
        };
    }

    /**
     * Streaming chat completion.
     * Returns a transform stream that converts Anthropic SSE events to OpenAI SSE format.
     */
    async chatCompletionStream(body) {
        const anthropicBody = {
            ...this._convertToAnthropicFormat(body),
            stream: true
        };

        const { response, latencyMs, attempt } = await this.request(
            'POST', '/messages', anthropicBody, {}, { stream: true }
        );

        // Transform Anthropic SSE → OpenAI SSE format
        const model = body.model;
        let inputTokens = 0;
        let outputTokens = 0;
        let buffer = '';

        const transformer = new Transform({
            transform(chunk, encoding, callback) {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                // Keep the last potentially incomplete line in buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const jsonStr = line.slice(6).trim();
                    if (!jsonStr || jsonStr === '[DONE]') continue;

                    try {
                        const event = JSON.parse(jsonStr);

                        if (event.type === 'message_start' && event.message?.usage) {
                            inputTokens = event.message.usage.input_tokens || 0;
                        }

                        if (event.type === 'content_block_delta' && event.delta?.text) {
                            const openaiChunk = {
                                id: `chatcmpl-${Date.now()}`,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model,
                                choices: [{
                                    index: 0,
                                    delta: { content: event.delta.text },
                                    finish_reason: null
                                }]
                            };
                            this.push(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                        }

                        if (event.type === 'message_delta' && event.usage) {
                            outputTokens = event.usage.output_tokens || 0;
                            // Send final chunk with finish_reason
                            const finalChunk = {
                                id: `chatcmpl-${Date.now()}`,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model,
                                choices: [{
                                    index: 0,
                                    delta: {},
                                    finish_reason: 'stop'
                                }],
                                usage: {
                                    prompt_tokens: inputTokens,
                                    completion_tokens: outputTokens,
                                    total_tokens: inputTokens + outputTokens
                                }
                            };
                            this.push(`data: ${JSON.stringify(finalChunk)}\n\n`);
                        }

                        if (event.type === 'message_stop') {
                            this.push('data: [DONE]\n\n');
                        }
                    } catch {
                        // Partial JSON — will be buffered and retried
                        logger.debug('Partial SSE event buffered');
                    }
                }
                callback();
            },
            flush(callback) {
                // Process any remaining buffer
                if (buffer.trim()) {
                    logger.debug('Flushing remaining SSE buffer');
                }
                callback();
            }
        });

        response.data.pipe(transformer);

        return {
            stream: transformer,
            latencyMs,
            attempt,
            status: response.status,
            getUsage: () => ({ inputTokens, outputTokens })
        };
    }
}

module.exports = AnthropicProvider;
