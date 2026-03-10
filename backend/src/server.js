/**
 * Frugal AI Router — ML-Powered Real Proxy Server
 * 
 * Production-grade AI routing proxy with:
 * - Real HTTP proxying to OpenAI/Anthropic
 * - GPU-accelerated ML complexity classification (ONNX)
 * - Multi-factor weighted routing with 6 signals
 * - Thompson Sampling RL with offline batch recompute
 * - Gated semantic cache (exact-match → embedding similarity)
 * - Per-provider circuit breakers (3-state machine)
 * - Multi-tenant API key auth with budgets & quotas
 * - Streaming SSE passthrough with format translation
 * - Passive benchmarking from real traffic
 * - Structured logging with request tracing
 */

require('dotenv').config();
const { validateEnv } = require('./config/env');
validateEnv();

const express = require('express');
const cors = require('cors');
const { createLogger } = require('./utils/logger');

// ────────────────────────────────────────────
// Core services
// ────────────────────────────────────────────
const { db, statements } = require('./db/database');
const { classify, loadOnnxModel, isOnnxReady } = require('./services/classifier');
const { routeRequest } = require('./services/router');
const { getBreaker, getAllBreakerMetrics, initializeBreakers } = require('./services/circuitBreaker');
const SemanticCache = require('./services/cache');
const RLEngine = require('./services/rlEngine');
const TenantManager = require('./services/tenantManager');
const Benchmarker = require('./services/benchmarker');
const { toCSV } = require('./services/csvExport');

// Providers
const OpenAIProvider = require('./providers/openai');
const AnthropicProvider = require('./providers/anthropic');
const GeminiProvider = require('./providers/gemini');
const GroqProvider = require('./providers/groq');
const CohereProvider = require('./providers/cohere');

// Middleware
const { tracingMiddleware } = require('./middleware/tracing');
const { createAuthMiddleware } = require('./middleware/auth');
const { createRateLimitMiddleware, getActiveRequests, MAX_CONCURRENT } = require('./middleware/rateLimit');

// Models config
const modelsConfig = require('./models/models.json');

// ────────────────────────────────────────────
// Logger
// ────────────────────────────────────────────
const logger = createLogger('frugal-router');

// ────────────────────────────────────────────
// Initialize services
// ────────────────────────────────────────────
const cache = new SemanticCache({ maxSize: 10000, ttlMs: 3600000 });
const rlEngine = new RLEngine(Object.keys(modelsConfig));
const tenantManager = new TenantManager({ db, statements });
const benchmarker = new Benchmarker({ db, statements });

// Providers (initialized with API keys)
const providers = {};
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key') {
    providers.openai = new OpenAIProvider(process.env.OPENAI_API_KEY);
    logger.info('OpenAI provider initialized');
}
if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key') {
    providers.anthropic = new AnthropicProvider(process.env.ANTHROPIC_API_KEY);
    logger.info('Anthropic provider initialized');
}
if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key') {
    providers.gemini = new GeminiProvider(process.env.GEMINI_API_KEY);
    logger.info('Gemini provider initialized');
}
if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key') {
    providers.groq = new GroqProvider(process.env.GROQ_API_KEY);
    logger.info('Groq provider initialized');
}
if (process.env.COHERE_API_KEY && process.env.COHERE_API_KEY !== 'your_cohere_api_key') {
    providers.cohere = new CohereProvider(process.env.COHERE_API_KEY);
    logger.info('Cohere provider initialized');
}

const MOCK_MODE = Object.keys(providers).length === 0;
if (MOCK_MODE) {
    logger.warn('No valid API keys found — running in MOCK MODE (routing works, but responses are simulated)');
}

// Write queue tracking (for /health)
let writeQueueDepth = 0;
const MAX_WRITE_QUEUE = 1000;
let isDegraded = false; // Degraded mode: skip non-critical logging to prevent memory growth

// ────────────────────────────────────────────
// Express app
// ────────────────────────────────────────────
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Middleware
app.use(tracingMiddleware);
app.use(createAuthMiddleware(tenantManager));
app.use(createRateLimitMiddleware());

// ────────────────────────────────────────────
// Health endpoint
// ────────────────────────────────────────────
let isReady = false;

app.get('/health', (req, res) => {
    const health = {
        ready: isReady,
        status: writeQueueDepth > MAX_WRITE_QUEUE ? 'degraded' : 'healthy',
        uptime: process.uptime(),
        activeRequests: getActiveRequests(),
        maxConcurrent: MAX_CONCURRENT,
        writeQueueDepth,
        onnxReady: isOnnxReady(),
        mockMode: MOCK_MODE,
        providers: Object.keys(providers),
        circuitBreakers: getAllBreakerMetrics(),
        cache: cache.getMetrics()
    };

    res.status(isReady ? 200 : 503).json(health);
});

// ────────────────────────────────────────────
// Readiness endpoint
// ────────────────────────────────────────────
app.get('/ready', (req, res) => {
    try {
        // 1. Verify database is responsive
        db.prepare('SELECT 1').get();

        // 2. Verify ONNX model is loaded
        if (!isOnnxReady()) {
            return res.status(503).json({ ready: false, reason: 'ONNX model classifier not loaded' });
        }

        // 3. Verify server startup flag
        if (!isReady) {
            return res.status(503).json({ ready: false, reason: 'Server starting' });
        }

        res.status(200).json({ ready: true, status: 'ready' });
    } catch (err) {
        logger.error({ err: err.message }, 'Readiness probe failed');
        res.status(503).json({ ready: false, reason: 'Database or critical subsystem failure' });
    }
});

// ────────────────────────────────────────────
// Main proxy endpoint — OpenAI-compatible
// ────────────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
    const requestId = req.correlationId;
    const startTime = Date.now();

    try {
        const { messages, model, strategy: reqStrategy, stream } = req.body;
        const strategy = req.tenant?.strategy || reqStrategy || 'cost-first';

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error' }
            });
        }

        // Extract prompt (last user message)
        const prompt = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
        if (!prompt) {
            return res.status(400).json({
                error: { message: 'No user message found in messages array', type: 'invalid_request_error' }
            });
        }

        // ── Step 1: Check cache (exact match first) ──
        const promptHash = cache.hashPrompt(prompt);
        const cacheResult = cache.lookup(promptHash);
        if (cacheResult.hit && !stream) {
            logger.info({ requestId, source: cacheResult.source }, 'Cache hit — returning cached response');

            // Log the cache hit
            logRequest({
                requestId, tenantId: req.tenantId, prompt, classification: { tier: 'cached', score: 0, confidence: 1, intent: 'cached' },
                model: cacheResult.model, provider: 'cache', strategy, inputTokens: 0, outputTokens: 0,
                cost: 0, energyIntensity: 0, latencyMs: Date.now() - startTime, status: 200, cacheHit: true,
                reasoning: 'Cache hit'
            });

            return res.json(cacheResult.response);
        }

        // ── Step 2: ML Classification ──
        const classification = await classify(prompt);

        // ── Step 3: Route ──
        const rlScores = rlEngine.getScores(req.tenantId);
        const breakerMetrics = getAllBreakerMetrics();
        const benchmarkData = benchmarker.getAllMetrics();

        const routingResult = routeRequest(classification, strategy, {
            rlScores,
            benchmarkMetrics: benchmarkData,
            breakerStates: breakerMetrics,
            tenantAllowedModels: req.tenant?.allowedModels || null
        });

        const selectedModel = routingResult.selectedModel;
        const selectedProvider = providers[selectedModel.provider];

        // ── Step 4: Execute request ──
        let responseData, inputTokens, outputTokens, providerLatency, providerStatus;

        if (!selectedProvider || MOCK_MODE) {
            // Mock mode
            const mockResponse = generateMockResponse(selectedModel, prompt, requestId);
            responseData = mockResponse.data;
            inputTokens = mockResponse.inputTokens;
            outputTokens = mockResponse.outputTokens;
            providerLatency = Date.now() - startTime;
            providerStatus = 200;
        } else if (stream) {
            // ── Streaming mode ──
            const { strategy: _s, ...cleanBody } = req.body;
            req.body = cleanBody; // Update req.body for handleStreamingRequest to use cleaned version

            return await handleStreamingRequest(req, res, {
                requestId, selectedModel, selectedProvider, messages, model: model || selectedModel.id,
                classification, routingResult, strategy, startTime, prompt, promptHash
            });
        } else {
            // ── Non-streaming mode with provider fallback ──
            // Try candidates in score order; on failure, fall back to next provider
            const triedProviders = new Set();
            let lastError = null;

            // Strip internal fields that might reject the request (e.g. Gemini throws on "strategy")
            // eslint-disable-next-line no-unused-vars
            const { strategy: _s, ...cleanBody } = req.body;

            // Build ordered fallback list: primary + alternatives from different providers
            const fallbackCandidates = [
                { model: selectedModel, id: routingResult.selectedModelId },
                ...routingResult.allCandidates
                    .filter(c => c.id !== routingResult.selectedModelId)
                    .map(c => ({ model: c.modelData, id: c.id }))
            ];

            for (const candidate of fallbackCandidates) {
                const provider = providers[candidate.model.provider];
                if (!provider) continue; // no provider configured for this model
                if (triedProviders.has(candidate.model.provider)) continue; // already tried this provider
                triedProviders.add(candidate.model.provider);

                const breaker = getBreaker(candidate.model.provider);
                const canExecute = breaker.canExecute();
                if (!canExecute.allowed) {
                    logger.debug({ provider: candidate.model.provider, reason: canExecute.reason }, 'Skipping provider — circuit open');
                    continue;
                }

                try {
                    const result = await provider.chatCompletion({
                        ...cleanBody,
                        model: candidate.id
                    });

                    // Success! Update selectedModel to the one that worked
                    if (candidate.id !== routingResult.selectedModelId) {
                        logger.info({ requestId, primary: routingResult.selectedModelId, fallback: candidate.id },
                            'Primary provider failed — fell back to alternative');
                    }
                    // Update selectedModel reference for cost calculation below
                    Object.assign(selectedModel, candidate.model);
                    selectedModel.id = candidate.id;

                    responseData = result.data;
                    inputTokens = result.inputTokens;
                    outputTokens = result.outputTokens;
                    providerLatency = result.latencyMs;
                    providerStatus = result.status;

                    breaker.recordResult(true, providerLatency);
                    benchmarker.record(candidate.id, providerLatency, true);
                    lastError = null;
                    break; // success — stop trying

                } catch (err) {
                    lastError = err;
                    const breaker = getBreaker(candidate.model.provider);
                    breaker.recordResult(false, Date.now() - startTime, err.timedOut);
                    benchmarker.record(candidate.id, Date.now() - startTime, false, err.timedOut);
                    logger.warn({ requestId, provider: candidate.model.provider, err: err.message },
                        'Provider failed — trying next fallback');
                }
            }

            // If all providers failed, return the last error
            if (lastError) {
                logger.error({ requestId, err: lastError.message, triedProviders: [...triedProviders] },
                    'All providers failed');
                return res.status(lastError.status || 502).json({
                    error: { message: lastError.message, type: 'provider_error', provider: lastError.provider }
                });
            }
        }

        // ── Step 5: Compute cost ──
        // IMPORTANT: Cost is computed from the provider's ACTUAL token counts
        // (response.data.usage.prompt_tokens / completion_tokens), NOT from
        // prompt length estimation. This ensures billing accuracy.
        const cost = (inputTokens * selectedModel.input_cost_per_1m / 1000000) +
            (outputTokens * selectedModel.output_cost_per_1m / 1000000);

        // ── Step 6: Cache response ──
        if (responseData && !stream) {
            cache.store(promptHash, responseData, selectedModel.id);
        }

        // ── Step 7: Log & track ──
        const totalLatency = Date.now() - startTime;

        logRequest({
            requestId, tenantId: req.tenantId, prompt, classification,
            model: selectedModel.id, provider: selectedModel.provider, strategy,
            inputTokens, outputTokens, cost, energyIntensity: selectedModel.energy_intensity,
            latencyMs: totalLatency, status: providerStatus, cacheHit: false,
            reasoning: routingResult.reasoning
        });

        // Track tenant usage
        if (req.tenantId) {
            tenantManager.trackUsage(req.tenantId, cost);
        }

        // RL feedback (auto-generated from latency/success)
        rlEngine.recordFeedback(
            selectedModel.id,
            computeAutoReward(totalLatency, cost, true),
            req.tenantId
        );

        // ── Step 8: Add routing metadata to response ──
        if (responseData) {
            responseData._routing = {
                requestId,
                modelSelected: selectedModel.id,
                provider: selectedModel.provider,
                strategy,
                complexity: classification.tier,
                complexityScore: classification.score,
                confidence: classification.confidence,
                intent: classification.intent,
                routingScore: routingResult.score,
                scoreBreakdown: routingResult.scoreBreakdown,
                latencyMs: totalLatency,
                cost: Math.round(cost * 1000000) / 1000000,
                energyIntensity: selectedModel.energy_intensity,
                classifierMethod: classification.method
            };
        }

        res.json(responseData);

    } catch (error) {
        logger.error({ requestId, err: error.message, stack: error.stack }, 'Request failed');
        res.status(500).json({
            error: { message: 'Internal Server Error', type: 'internal_error', requestId }
        });
    }
});

// ────────────────────────────────────────────
// Streaming handler
// ────────────────────────────────────────────
async function handleStreamingRequest(req, res, ctx) {
    const {
        requestId, selectedModel, selectedProvider, messages,
        model, classification, routingResult, strategy, startTime, prompt, promptHash
    } = ctx;

    const breaker = getBreaker(selectedModel.provider);
    const canExecute = breaker.canExecute();

    if (!canExecute.allowed) {
        return res.status(503).json({
            error: { message: `Provider ${selectedModel.provider} unavailable: ${canExecute.reason}`, type: 'service_unavailable' }
        });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Request-Id', requestId);
    res.flushHeaders();

    let aborted = false;
    let providerStream = null;

    // Handle client disconnect
    req.on('close', () => {
        aborted = true;
        if (providerStream && providerStream.destroy) {
            providerStream.destroy();
        }
        logger.debug({ requestId }, 'Client disconnected during stream');
    });

    try {
        const result = await selectedProvider.chatCompletionStream({
            ...req.body,
            model: selectedModel.id
        });

        providerStream = result.stream;
        const providerLatency = result.latencyMs;

        // Pipe stream to client
        providerStream.on('data', (chunk) => {
            if (!aborted) {
                res.write(chunk);
            }
        });

        providerStream.on('end', () => {
            if (!aborted) {
                res.end();
            }

            const totalLatency = Date.now() - startTime;
            breaker.recordResult(true, providerLatency);
            benchmarker.record(selectedModel.id, totalLatency, true);

            // Get usage if available
            const usage = result.getUsage ? result.getUsage() : { inputTokens: 0, outputTokens: 0 };
            const cost = (usage.inputTokens * selectedModel.input_cost_per_1m / 1000000) +
                (usage.outputTokens * selectedModel.output_cost_per_1m / 1000000);

            logRequest({
                requestId, tenantId: req.tenantId, prompt, classification,
                model: selectedModel.id, provider: selectedModel.provider, strategy,
                inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
                cost, energyIntensity: selectedModel.energy_intensity,
                latencyMs: totalLatency, status: result.status, cacheHit: false,
                reasoning: routingResult.reasoning
            });

            if (req.tenantId) {
                tenantManager.trackUsage(req.tenantId, cost);
            }

            rlEngine.recordFeedback(selectedModel.id, computeAutoReward(totalLatency, cost, true), req.tenantId);
        });

        providerStream.on('error', (err) => {
            if (!aborted) {
                res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
                res.end();
            }
            breaker.recordResult(false, Date.now() - startTime);
            benchmarker.record(selectedModel.id, Date.now() - startTime, false);
        });

    } catch (err) {
        breaker.recordResult(false, Date.now() - startTime, err.timedOut);
        benchmarker.record(selectedModel.id, Date.now() - startTime, false, err.timedOut);

        if (!aborted) {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        }
    }
}

// ────────────────────────────────────────────
// Mock response generator
// ────────────────────────────────────────────
function generateMockResponse(model, prompt, requestId) {
    const responseText = `[MOCK - ${model.id}] This is a simulated response. Configure valid API keys in .env to enable real routing. Your prompt was classified and routed through the ML pipeline.`;
    // MOCK ONLY: char/4 is a rough token estimate. Real providers return actual
    // usage.prompt_tokens and usage.completion_tokens which we use for billing.
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(responseText.length / 4);

    return {
        data: {
            id: `chatcmpl-${requestId}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model.id,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: responseText },
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens
            }
        },
        inputTokens,
        outputTokens
    };
}

// ────────────────────────────────────────────
// Auto-reward computation (for RL)
// ────────────────────────────────────────────
function computeAutoReward(latencyMs, cost, success) {
    if (!success) return 0;
    const latencyScore = Math.max(0, 1 - (latencyMs / 30000));
    const costScore = Math.max(0, 1 - (cost / 0.01));
    return 0.4 + (latencyScore * 0.3) + (costScore * 0.3);
}

// ────────────────────────────────────────────
// Async request logging (batched)
// ────────────────────────────────────────────
const writeQueue = [];
let flushTimer = null;

function logRequest(data) {
    // Degraded mode: skip non-critical writes (cache hits) to prevent
    // unbounded memory growth when flush rate < write rate
    if (isDegraded && data.cacheHit) {
        return; // Drop non-critical log entries
    }

    writeQueue.push(data);
    writeQueueDepth = writeQueue.length;

    // Enter degraded mode if queue is filling up
    if (writeQueueDepth > MAX_WRITE_QUEUE && !isDegraded) {
        isDegraded = true;
        logger.warn({ writeQueueDepth, threshold: MAX_WRITE_QUEUE },
            'Write queue exceeded threshold — entering degraded mode, skipping non-critical logs');
    }

    if (!flushTimer) {
        flushTimer = setTimeout(flushWriteQueue, 500);
    }
}

function flushWriteQueue() {
    flushTimer = null;
    const batch = writeQueue.splice(0, writeQueue.length);
    writeQueueDepth = writeQueue.length;

    // Exit degraded mode if queue is now under control
    if (isDegraded && writeQueueDepth < MAX_WRITE_QUEUE / 2) {
        isDegraded = false;
        logger.info({ writeQueueDepth }, 'Write queue recovered — exiting degraded mode');
    }

    const insert = db.transaction((items) => {
        for (const d of items) {
            try {
                statements.insertRequest.run({
                    request_id: d.requestId,
                    tenant_id: d.tenantId || null,
                    prompt_preview: d.prompt.substring(0, 100),
                    complexity_tier: d.classification.tier,
                    complexity_score: d.classification.score,
                    ml_confidence: d.classification.confidence,
                    intent: d.classification.intent,
                    model_selected: d.model,
                    provider: d.provider,
                    strategy: d.strategy,
                    input_tokens: d.inputTokens,
                    output_tokens: d.outputTokens,
                    cost: d.cost,
                    energy_intensity: d.energyIntensity,
                    actual_latency_ms: d.latencyMs,
                    provider_status: d.status,
                    cache_hit: d.cacheHit ? 1 : 0,
                    routing_reasoning: d.reasoning
                });
            } catch (err) {
                logger.error({ err: err.message }, 'Failed to log request');
            }
        }
    });

    if (batch.length > 0) {
        try {
            insert(batch);
            logger.debug({ count: batch.length }, 'Flushed write queue');
        } catch (err) {
            logger.error({ err: err.message }, 'Batch write failed');
        }
    }
}

// ────────────────────────────────────────────
// API endpoints
// ────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
    try {
        const stats = statements.getStats.get();
        const modelStats = statements.getModelStats.all();
        const recentLogs = statements.getRecentRequests.all();
        const breakerMetrics = getAllBreakerMetrics();
        const cacheMetrics = cache.getMetrics();
        const rlWeights = rlEngine.getWeights(req.tenantId);
        const benchmarkData = benchmarker.getAllMetrics();

        // Calculate savings vs most expensive model
        const maxCostModel = Object.values(modelsConfig).reduce((max, m) =>
            (m.input_cost_per_1m + m.output_cost_per_1m) > (max.input_cost_per_1m + max.output_cost_per_1m) ? m : max
        );

        res.json({
            stats: {
                totalRequests: stats?.total_requests || 0,
                totalCost: Math.round((stats?.total_cost || 0) * 1000000) / 1000000,
                totalEnergy: Math.round((stats?.total_energy || 0) * 100) / 100,
                avgLatency: Math.round(stats?.avg_latency || 0),
                cacheHits: stats?.cache_hits || 0,
                cacheHitRate: cacheMetrics.hitRate
            },
            modelStats,
            recentLogs: recentLogs.slice(0, 20),
            circuitBreakers: breakerMetrics,
            cache: cacheMetrics,
            rlWeights,
            benchmarks: benchmarkData,
            mockMode: MOCK_MODE
        });
    } catch (err) {
        logger.error({ err: err.message }, 'Stats query failed');
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

app.get('/api/stats/export', (req, res) => {
    try {
        const recentLogs = statements.getRecentRequests.all();
        const csv = toCSV(recentLogs);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="analytics.csv"');
        res.send(csv);
    } catch (err) {
        logger.error({ err: err.message }, 'CSV export failed');
        res.status(500).json({ error: 'Failed to export CSV' });
    }
});

app.get('/api/config', (req, res) => {
    res.json({
        strategies: ['cost-first', 'green-first', 'performance-first', 'balanced'],
        models: modelsConfig,
        onnxReady: isOnnxReady(),
        mockMode: MOCK_MODE
    });
});

app.get('/api/benchmarks', (req, res) => {
    res.json(benchmarker.getAllMetrics());
});

// ── Tenant management ──
app.post('/api/tenants', (req, res) => {
    try {
        const { name, strategy, allowedModels, budgetLimitMonthly, rateLimitRpm, rateLimitTpm } = req.body;
        if (!name) return res.status(400).json({ error: 'name is required' });

        const result = tenantManager.createTenant(name, {
            strategy, allowedModels, budgetLimitMonthly, rateLimitRpm, rateLimitTpm
        });

        res.status(201).json(result);
    } catch (err) {
        logger.error({ err: err.message }, 'Tenant creation failed');
        res.status(500).json({ error: 'Failed to create tenant' });
    }
});

app.get('/api/tenants', (req, res) => {
    try {
        res.json(tenantManager.getAllTenants());
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch tenants' });
    }
});

// ── Feedback endpoint (for RL training) ──
app.post('/api/feedback', (req, res) => {
    try {
        const { requestId, modelId, qualityScore, latencyMs, cost, success } = req.body;
        if (!requestId || !modelId) {
            return res.status(400).json({ error: 'requestId and modelId are required' });
        }

        statements.insertFeedback.run({
            request_id: requestId,
            model_id: modelId,
            tenant_id: req.tenantId || null,
            quality_score: qualityScore || null,
            latency_ms: latencyMs || null,
            cost: cost || null,
            success: success !== undefined ? (success ? 1 : 0) : 1
        });

        // Immediate RL update
        const reward = success !== false ? (qualityScore ? qualityScore / 10 : 0.7) : 0;
        rlEngine.recordFeedback(modelId, reward, req.tenantId);

        res.json({ status: 'ok' });
    } catch (err) {
        logger.error({ err: err.message }, 'Feedback recording failed');
        res.status(500).json({ error: 'Failed to record feedback' });
    }
});

// ── Models listing (OpenAI-compatible) ──
app.get('/v1/models', (req, res) => {
    const modelList = Object.entries(modelsConfig).map(([id, data]) => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: data.provider,
        permission: []
    }));

    res.json({
        object: 'list',
        data: modelList
    });
});

// ────────────────────────────────────────────
// Startup
// ────────────────────────────────────────────
async function startServer() {
    logger.info('Starting Frugal AI Router...');

    // Load ONNX models (GPU-accelerated)
    const onnxLoaded = await loadOnnxModel();
    logger.info({ onnxLoaded }, 'ML classifier initialization complete');

    // Pre-initialize circuit breakers for all known providers
    // so /health always shows their state (not empty {})
    const providerNames = [...new Set(Object.values(modelsConfig).map(m => m.provider))];
    initializeBreakers(providerNames);

    // Start RL periodic recompute
    rlEngine.startPeriodicRecompute({ db, statements });

    // Start benchmarker periodic flush
    benchmarker.startPeriodicFlush();

    // Mark as ready
    isReady = true;

    app.listen(port, () => {
        logger.info({
            port,
            mockMode: MOCK_MODE,
            onnxReady: isOnnxReady(),
            providers: Object.keys(providers)
        }, `🚀 Frugal AI Router listening on port ${port}`);
    });
}

// ────────────────────────────────────────────
// Graceful shutdown
// ────────────────────────────────────────────
process.on('SIGTERM', () => {
    logger.info('SIGTERM received — shutting down gracefully');
    flushWriteQueue();
    rlEngine.stop();
    benchmarker.stop();
    db.close();
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('SIGINT received — shutting down gracefully');
    flushWriteQueue();
    rlEngine.stop();
    benchmarker.stop();
    db.close();
    process.exit(0);
});

// Start
startServer().catch(err => {
    logger.fatal({ err: err.message }, 'Failed to start server');
    process.exit(1);
});
