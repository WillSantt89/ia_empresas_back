import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';
import { DEFAULT_MODELS, DEFAULT_LIMITS } from '../config/constants.js';

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
 * @param {string} options.message - Current user message
 * @param {number} options.temperature - Temperature setting (0.0-1.0)
 * @param {number} options.maxTokens - Maximum output tokens
 * @returns {Promise<Object>} Processing result with text and tool calls
 */
export async function processMessage(options) {
  const {
    apiKey,
    model = DEFAULT_MODELS.GEMINI_FLASH,
    systemPrompt,
    tools = [],
    history = [],
    message,
    temperature = DEFAULT_LIMITS.TEMPERATURE,
    maxTokens = DEFAULT_LIMITS.MAX_TOKENS,
  } = options;

  const startTime = Date.now();
  const toolsCalled = [];
  let iteracoes = 0;
  let tokensInput = 0;
  let tokensOutput = 0;

  try {
    // Initialize Gemini API
    const genAI = new GoogleGenerativeAI(apiKey);

    // Configure the model
    const generativeModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
      tools: tools.length > 0 ? [{
        functionDeclarations: tools
      }] : undefined,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        candidateCount: 1,
      },
    });

    // Build conversation history
    const contents = [
      ...history,
      {
        role: 'user',
        parts: [{ text: message }]
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
        const result = await generativeModel.generateContent({
          contents: currentContents,
        });

        const response = result.response;

        // Count tokens
        if (result.response.usageMetadata) {
          tokensInput += result.response.usageMetadata.promptTokenCount || 0;
          tokensOutput += result.response.usageMetadata.candidatesTokenCount || 0;
        }

        // Check for function calls
        const functionCalls = extractFunctionCalls(response);

        if (functionCalls.length > 0) {
          createLogger.debug('Function calls detected', {
            count: functionCalls.length,
            functions: functionCalls.map(fc => fc.name)
          });

          // Add model's function call to history
          currentContents.push({
            role: 'model',
            parts: functionCalls.map(fc => ({
              functionCall: fc
            }))
          });

          // Process each function call
          const functionResponses = [];

          for (const functionCall of functionCalls) {
            // Return to caller for execution
            const toolCall = {
              type: 'tool_call',
              toolName: functionCall.name,
              toolArgs: functionCall.args
            };

            // In the actual implementation, this would be yielded to the caller
            // For now, we'll collect it
            toolsCalled.push({
              name: functionCall.name,
              args: functionCall.args,
              result: null // Will be filled by the caller
            });

            // Simulate function response (in real implementation, this comes from the caller)
            const functionResponse = {
              name: functionCall.name,
              response: {
                error: 'Function execution not implemented in this version'
              }
            };

            functionResponses.push({
              functionResponse
            });
          }

          // Add function responses to history
          currentContents.push({
            role: 'function',
            parts: functionResponses
          });

          // Continue the loop for the next iteration
          continue;
        }

        // No function calls, get the text response
        const text = response.text();
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
        if (error.message?.includes('429') || error.status === 429) {
          const err = new Error('API rate limit exceeded');
          err.code = 'RATE_LIMITED';
          throw err;
        }

        if (error.message?.includes('401') || error.message?.includes('403') ||
            error.status === 401 || error.status === 403) {
          const err = new Error('Invalid API key');
          err.code = 'INVALID_KEY';
          throw err;
        }

        if (error.message?.includes('500') || error.status === 500) {
          const err = new Error('API server error');
          err.code = 'API_ERROR';
          throw err;
        }

        if (error.message?.includes('timeout')) {
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

    createLogger.error('Gemini API error', {
      error: error.message,
      code: error.code,
      model,
      duration_ms: duration
    });

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
              args: part.functionCall.args || {}
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
    name: tool.nome,
    description: tool.descricao_para_llm,
    parameters: tool.parametros_schema_json
  }));
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
 * Process message with function calling support
 * This is the main entry point that handles the complete flow
 */
export async function processMessageWithTools(options, toolExecutor) {
  const {
    apiKey,
    model = DEFAULT_MODELS.GEMINI_FLASH,
    systemPrompt,
    tools = [],
    history = [],
    message,
    temperature = DEFAULT_LIMITS.TEMPERATURE,
    maxTokens = DEFAULT_LIMITS.MAX_TOKENS,
  } = options;

  const startTime = Date.now();
  const executedTools = [];
  let currentHistory = [...history];
  let iteracoes = 0;
  let totalTokensInput = 0;
  let totalTokensOutput = 0;

  try {
    // Initialize Gemini API
    const genAI = new GoogleGenerativeAI(apiKey);

    // Configure the model
    const generativeModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
      tools: tools.length > 0 ? [{
        functionDeclarations: buildToolDeclarations(tools)
      }] : undefined,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        candidateCount: 1,
      },
    });

    // Inject system prompt as first messages (ensures compatibility with SDK < 0.7
    // where systemInstruction param is ignored)
    if (systemPrompt) {
      currentHistory.unshift(
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'model', parts: [{ text: 'Entendido. Vou seguir essas instrucoes em todas as minhas respostas.' }] }
      );
    }

    // Add user message to history
    currentHistory.push({
      role: 'user',
      parts: [{ text: message }]
    });

    // Function calling loop
    while (iteracoes < DEFAULT_LIMITS.MAX_FUNCTION_CALLS) {
      iteracoes++;

      // Generate content
      const result = await generativeModel.generateContent({
        contents: currentHistory,
      });

      const response = result.response;

      // Count tokens
      if (result.response.usageMetadata) {
        totalTokensInput += result.response.usageMetadata.promptTokenCount || 0;
        totalTokensOutput += result.response.usageMetadata.candidatesTokenCount || 0;
      }

      // Validate response
      if (!validateResponse(response)) {
        throw new Error('Invalid response from model');
      }

      // Check for function calls
      const functionCalls = extractFunctionCalls(response);

      if (functionCalls.length > 0) {
        // Add model's response with function calls to history
        currentHistory.push({
          role: 'model',
          parts: functionCalls.map(fc => ({
            functionCall: fc
          }))
        });

        // Execute function calls
        const functionResponses = [];

        for (const functionCall of functionCalls) {
          try {
            // Find the tool
            const tool = tools.find(t => t.nome === functionCall.name);
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
            createLogger.error('Tool execution failed', {
              tool: functionCall.name,
              error: error.message
            });

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

        // Add function responses to history
        currentHistory.push({
          role: 'function',
          parts: functionResponses
        });

        // Continue the loop
        continue;
      }

      // No function calls, get the final text response
      const finalText = response.text();

      if (!finalText) {
        throw new Error('No text response from model');
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

    createLogger.error('Message processing failed', {
      error: error.message,
      code: error.code,
      model,
      iterations: iteracoes,
      duration_ms: duration
    });

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