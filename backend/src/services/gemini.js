import { GoogleGenAI } from '@google/genai';
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';
import { DEFAULT_MODELS, DEFAULT_LIMITS, DEPRECATED_MODEL_FALLBACK } from '../config/constants.js';

/**
 * Gemini API Service with Function Calling
 * Handles AI interactions with tool execution loop
 */

const createLogger = logger.child({ module: 'gemini-service' });

/**
 * Process a message with Gemini API including function calling loop
 * @param {Object} options - Configuration options
 * @param {string} options.apiKey - Decrypted API key
 * @param {string} options.model - Model name (e.g., 'gemini-2.0-flash-001')
 * @param {string} options.systemPrompt - System instructions for the agent
 * @param {Array} options.tools - Available tools in Gemini format
 * @param {Array} options.history - Conversation history
 * @param {string} options.message - Current user message (text)
 * @param {Array} options.parts - Current user message parts (for media support, overrides message)
 * @param {number} options.temperature - Temperature setting (0.0-1.0)
 * @param {number} options.maxTokens - Maximum output tokens
 * @returns {Promise<Object>} Processing result with text and tool calls
 */
export async function processMessage(options) {
  const {
    apiKey,
    model: requestedModel = DEFAULT_MODELS.GEMINI_FLASH,
    systemPrompt,
    tools = [],
    history = [],
    message,
    parts,
    temperature = DEFAULT_LIMITS.TEMPERATURE,
    maxTokens = DEFAULT_LIMITS.MAX_TOKENS,
  } = options;

  // Auto-migrate deprecated models
  const model = DEPRECATED_MODEL_FALLBACK[requestedModel] || requestedModel;
  if (model !== requestedModel) {
    createLogger.warn('Auto-migrating deprecated model', { from: requestedModel, to: model });
  }

  const startTime = Date.now();
  const toolsCalled = [];
  let iteracoes = 0;
  let tokensInput = 0;
  let tokensOutput = 0;

  try {
    // Initialize Gemini API
    const ai = new GoogleGenAI({ apiKey });

    // Configure generation config (passed per-call in new SDK)
    const toolsConfig = tools.length > 0 ? [{ functionDeclarations: tools }] : undefined;
    const generateConfig = {
      systemInstruction: systemPrompt,
      tools: toolsConfig,
      temperature,
      maxOutputTokens: maxTokens,
      candidateCount: 1,
    };

    // Build conversation history
    const userParts = parts || [{ text: message }];
    const contents = [
      ...history,
      {
        role: 'user',
        parts: userParts
      }
    ];

    // Function calling loop
    let finalResponse = null;
    let currentContents = [...contents];

    while (iteracoes < DEFAULT_LIMITS.MAX_FUNCTION_CALLS) {
      iteracoes++;

      createLogger.debug('Gemini API call', {
        iteration: iteracoes,
        model,
        temperature,
        tools_count: tools.length
      });

      try {
        // Generate content
        const response = await ai.models.generateContent({
          model,
          contents: currentContents,
          config: generateConfig,
        });

        // Count tokens
        if (response.usageMetadata) {
          tokensInput += response.usageMetadata.promptTokenCount || 0;
          tokensOutput += response.usageMetadata.candidatesTokenCount || 0;
        }

        // Check for function calls
        const functionCalls = extractFunctionCalls(response);

        if (functionCalls.length > 0) {
          createLogger.debug('Function calls detected', {
            count: functionCalls.length,
            functions: functionCalls.map(fc => fc.name)
          });

          // Add model's function call to history (preserve thoughtSignature for Gemini 3)
          currentContents.push({
            role: 'model',
            parts: functionCalls.map(fc => {
              const part = { functionCall: { name: fc.name, args: fc.args } };
              if (fc.thoughtSignature) part.thoughtSignature = fc.thoughtSignature;
              return part;
            })
          });

          // Process each function call
          const functionResponses = [];

          for (const functionCall of functionCalls) {
            toolsCalled.push({
              name: functionCall.name,
              args: functionCall.args,
              result: null
            });

            functionResponses.push({
              functionResponse: {
                name: functionCall.name,
                response: { error: 'Function execution not implemented in this version' }
              }
            });
          }

          // Add function responses to history
          currentContents.push({
            role: 'user',
            parts: functionResponses
          });

          // Continue the loop for the next iteration
          continue;
        }

        // No function calls, get the text response
        const text = response.text;
        if (text) {
          finalResponse = {
            type: 'text',
            text,
            tokensInput,
            tokensOutput
          };
          break;
        }

        // If no text and no function calls, something went wrong
        throw new Error('No response generated from model');

      } catch (error) {
        // Handle specific API errors
        const status = error.status || error.httpStatusCode;
        const msg = error.message || '';

        if (status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
          const err = new Error('API rate limit exceeded');
          err.code = 'RATE_LIMITED';
          throw err;
        }

        if (status === 401 || status === 403 || msg.includes('PERMISSION_DENIED') || msg.includes('API key')) {
          const err = new Error('Invalid API key');
          err.code = 'INVALID_KEY';
          throw err;
        }

        if (status === 500 || msg.includes('INTERNAL')) {
          const err = new Error('API server error');
          err.code = 'API_ERROR';
          throw err;
        }

        if (msg.includes('timeout') || msg.includes('DEADLINE_EXCEEDED')) {
          const err = new Error('API request timeout');
          err.code = 'TIMEOUT';
          throw err;
        }

        // Re-throw other errors
        throw error;
      }
    }

    // Check if we hit the iteration limit
    if (!finalResponse && iteracoes >= DEFAULT_LIMITS.MAX_FUNCTION_CALLS) {
      createLogger.warn('Function calling loop limit reached', {
        iterations: iteracoes,
        limit: DEFAULT_LIMITS.MAX_FUNCTION_CALLS
      });

      finalResponse = {
        type: 'text',
        text: 'Desculpe, não consegui processar sua solicitação completamente. Por favor, tente novamente.',
        tokensInput,
        tokensOutput
      };
    }

    const duration = Date.now() - startTime;

    createLogger.info('Message processed successfully', {
      model,
      iterations: iteracoes,
      tools_called: toolsCalled.length,
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      duration_ms: duration
    });

    return {
      text: finalResponse.text,
      toolsCalled,
      tokensInput,
      tokensOutput,
      model,
      iteracoes,
      duration
    };

  } catch (error) {
    const duration = Date.now() - startTime;

    createLogger.error({ err: error, model, duration_ms: duration }, 'Gemini API error');

    throw error;
  }
}

/**
 * Extract function calls from Gemini response
 * @param {Object} response - Gemini API response
 * @returns {Array} Array of function calls
 */
function extractFunctionCalls(response) {
  const functionCalls = [];

  try {
    if (response.candidates && response.candidates[0]) {
      const candidate = response.candidates[0];

      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.functionCall) {
            functionCalls.push({
              name: part.functionCall.name,
              args: part.functionCall.args || {},
              // Preserve thoughtSignature for Gemini 3 compatibility
              thoughtSignature: part.thoughtSignature || undefined
            });
          }
        }
      }
    }
  } catch (error) {
    createLogger.error('Error extracting function calls', {
      error: error.message
    });
  }

  return functionCalls;
}

/**
 * Build contents array for Gemini API with proper formatting
 * @param {Array} history - Conversation history
 * @param {string} currentMessage - Current user message
 * @returns {Array} Formatted contents array
 */
export function buildContents(history, currentMessage) {
  const contents = [];

  // Add history
  for (const msg of history) {
    if (msg.role === 'user' || msg.role === 'model') {
      contents.push({
        role: msg.role,
        parts: msg.parts
      });
    } else if (msg.role === 'function') {
      // Function responses need special handling
      contents.push({
        role: 'function',
        parts: msg.parts
      });
    }
  }

  // Add current message
  if (currentMessage) {
    contents.push({
      role: 'user',
      parts: [{ text: currentMessage }]
    });
  }

  return contents;
}

/**
 * Convert database tools to Gemini function declarations
 * @param {Array} tools - Array of tool objects from database
 * @returns {Array} Gemini-formatted function declarations
 */
export function buildToolDeclarations(tools) {
  return tools.map(tool => ({
    name: sanitizeFunctionName(tool.nome),
    description: tool.descricao_para_llm,
    parameters: tool.parametros_schema_json
  }));
}

/**
 * Sanitize function name for Gemini API compatibility
 * Gemini 3 requires lowercase alphanumeric, underscores, dots, colons, dashes
 * Must start with letter or underscore, max 64 chars
 */
function sanitizeFunctionName(name) {
  if (!name) return 'unnamed_tool';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]/g, '_')
    .replace(/^[^a-z_]/, '_$&')
    .slice(0, 64);
}

/**
 * Validate Gemini API response
 * @param {Object} response - API response
 * @returns {boolean} True if response is valid
 */
export function validateResponse(response) {
  if (!response) return false;

  try {
    if (response.candidates && response.candidates.length > 0) {
      const candidate = response.candidates[0];

      // Check for blocked content
      if (candidate.finishReason === 'SAFETY') {
        createLogger.warn('Response blocked by safety filters');
        return false;
      }

      // Check for other finish reasons that indicate problems
      if (candidate.finishReason === 'RECITATION') {
        createLogger.warn('Response blocked due to recitation');
        return false;
      }

      return true;
    }
  } catch (error) {
    createLogger.error('Error validating response', {
      error: error.message
    });
  }

  return false;
}

/**
 * Create a context cache in Gemini API for an agent's system prompt + tools
 * @param {Object} params - Cache configuration
 * @param {string} params.apiKey - Decrypted API key
 * @param {string} params.model - Model name
 * @param {string} params.systemPrompt - System prompt to cache
 * @param {Array} params.tools - Tool declarations to cache
 * @param {number} params.ttlSeconds - Cache TTL in seconds (default 24h)
 * @returns {Promise<Object>} Created cache { name, expireTime, ... }
 */
export async function createContextCache({ apiKey, model: requestedModel, systemPrompt, tools, ttlSeconds = 86400 }) {
  const model = DEPRECATED_MODEL_FALLBACK[requestedModel] || requestedModel;
  const ai = new GoogleGenAI({ apiKey });
  const cacheConfig = {
    displayName: `agent-cache-${Date.now()}`,
    systemInstruction: systemPrompt,
    ttl: `${ttlSeconds}s`,
  };

  if (tools.length > 0) {
    cacheConfig.tools = [{ functionDeclarations: tools }];
  }

  const cachedContent = await ai.caches.create({
    model: model,
    config: cacheConfig,
  });

  createLogger.info('Context cache created', {
    cacheName: cachedContent.name,
    model,
    ttlSeconds,
    expireTime: cachedContent.expireTime
  });

  return cachedContent;
}

/**
 * Delete a context cache from Gemini API
 * @param {string} apiKey - Decrypted API key
 * @param {string} cacheName - Cache name (e.g., 'cachedContents/abc123')
 */
export async function deleteContextCache(apiKey, cacheName) {
  const ai = new GoogleGenAI({ apiKey });
  await ai.caches.delete({ name: cacheName });

  createLogger.info('Context cache deleted', { cacheName });
}

/**
 * Process message with function calling support
 * This is the main entry point that handles the complete flow
 */
export async function processMessageWithTools(options, toolExecutor) {
  const {
    apiKey,
    model: requestedModel = DEFAULT_MODELS.GEMINI_FLASH,
    systemPrompt,
    tools = [],
    history = [],
    message,
    parts,
    temperature = DEFAULT_LIMITS.TEMPERATURE,
    maxTokens = DEFAULT_LIMITS.MAX_TOKENS,
    cachedContentName,
  } = options;

  // Auto-migrate deprecated models
  const model = DEPRECATED_MODEL_FALLBACK[requestedModel] || requestedModel;
  if (model !== requestedModel) {
    createLogger.warn('Auto-migrating deprecated model', { from: requestedModel, to: model });
  }

  const startTime = Date.now();
  const executedTools = [];
  let currentHistory = [...history];
  let iteracoes = 0;
  let totalTokensInput = 0;
  let totalTokensOutput = 0;

  try {
    // Initialize Gemini API
    const ai = new GoogleGenAI({ apiKey });

    // Configure generation config (passed per-call in new SDK)
    const toolsConfig = tools.length > 0 ? [{ functionDeclarations: tools }] : undefined;
    let generateConfig;

    if (cachedContentName) {
      // CACHE mode: systemInstruction and tools are already in the cache
      generateConfig = {
        cachedContent: cachedContentName,
        temperature,
        maxOutputTokens: maxTokens,
        candidateCount: 1,
      };
      createLogger.debug('Using cached content', { cacheName: cachedContentName, model });
    } else {
      // NORMAL mode
      generateConfig = {
        systemInstruction: systemPrompt,
        tools: toolsConfig,
        temperature,
        maxOutputTokens: maxTokens,
        candidateCount: 1,
      };
    }

    // Add user message to history (supports parts array for media)
    const userParts = parts || [{ text: message }];
    currentHistory.push({
      role: 'user',
      parts: userParts
    });

    // Function calling loop
    while (iteracoes < DEFAULT_LIMITS.MAX_FUNCTION_CALLS) {
      iteracoes++;

      // Generate content
      const response = await ai.models.generateContent({
        model,
        contents: currentHistory,
        config: generateConfig,
      });

      // Count tokens
      if (response.usageMetadata) {
        totalTokensInput += response.usageMetadata.promptTokenCount || 0;
        totalTokensOutput += response.usageMetadata.candidatesTokenCount || 0;
      }

      // Validate response
      if (!validateResponse(response)) {
        throw new Error('Invalid response from model');
      }

      // Check for function calls
      const functionCalls = extractFunctionCalls(response);

      if (functionCalls.length > 0) {
        // Add model's response with function calls to history
        // Preserve thoughtSignature for Gemini 3 (required for function calling)
        currentHistory.push({
          role: 'model',
          parts: functionCalls.map(fc => {
            const part = {
              functionCall: { name: fc.name, args: fc.args }
            };
            if (fc.thoughtSignature) {
              part.thoughtSignature = fc.thoughtSignature;
            }
            return part;
          })
        });

        // Execute function calls
        const functionResponses = [];

        for (const functionCall of functionCalls) {
          try {
            // Find the tool (compare case-insensitive, support both nome and name fields)
            const tool = tools.find(t =>
              (t.nome || t.name || '').toLowerCase() === functionCall.name.toLowerCase()
            );
            if (!tool) {
              throw new Error(`Tool not found: ${functionCall.name}`);
            }

            // Execute the tool
            const result = await toolExecutor(tool, functionCall.args);

            executedTools.push({
              name: functionCall.name,
              args: functionCall.args,
              result: result
            });

            functionResponses.push({
              functionResponse: {
                name: functionCall.name,
                response: result
              }
            });

          } catch (error) {
            createLogger.error({ err: error, tool: functionCall.name }, 'Tool execution failed');

            functionResponses.push({
              functionResponse: {
                name: functionCall.name,
                response: {
                  error: error.message
                }
              }
            });
          }
        }

        // Add function responses to history (use 'user' role for Gemini 3 compatibility)
        currentHistory.push({
          role: 'user',
          parts: functionResponses
        });

        // Continue the loop
        continue;
      }

      // No function calls, extract text response
      // Use direct extraction to handle Gemini 3 thinking/thought parts
      let finalText = '';
      const candidate = response.candidates?.[0];
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          // Skip thinking/thought parts — only include actual response text
          if (part.thought) continue;
          if (part.text) finalText += part.text;
        }
        // If no non-thought text found, include thought text as fallback
        if (!finalText) {
          for (const part of candidate.content.parts) {
            if (part.text) finalText += part.text;
          }
        }
      }

      // Fallback to SDK text property
      if (!finalText) {
        try {
          finalText = response.text || '';
        } catch (textErr) {
          // Ignore errors accessing text
        }
      }

      if (!finalText) {
        const debugInfo = {
          finishReason: candidate?.finishReason,
          partsCount: candidate?.content?.parts?.length,
          partKeys: candidate?.content?.parts?.map(p => Object.keys(p)),
          hasContent: !!candidate?.content,
          candidatesCount: response.candidates?.length
        };
        createLogger.warn('No text in response', debugInfo);
        const err = new Error('No text response from model');
        err.debugInfo = debugInfo;
        throw err;
      }

      // Add final response to history
      currentHistory.push({
        role: 'model',
        parts: [{ text: finalText }]
      });

      const duration = Date.now() - startTime;

      return {
        text: finalText,
        toolsCalled: executedTools,
        tokensInput: totalTokensInput,
        tokensOutput: totalTokensOutput,
        model,
        iteracoes,
        duration,
        history: currentHistory
      };
    }

    // Hit iteration limit
    throw new Error('Function calling loop limit exceeded');

  } catch (error) {
    const duration = Date.now() - startTime;

    createLogger.error({ err: error, model, iterations: iteracoes, duration_ms: duration }, 'Message processing failed');

    // Return error with partial results
    const enrichedError = new Error(error.message || 'Gemini API error');
    enrichedError.code = error.code;
    enrichedError.status = error.status;
    enrichedError.partialResult = {
      toolsCalled: executedTools,
      tokensInput: totalTokensInput,
      tokensOutput: totalTokensOutput,
      iteracoes,
      duration
    };
    throw enrichedError;
  }
}