import { redis, setWithExpiry, getJSON } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { DEFAULT_LIMITS } from '../config/constants.js';

/**
 * Memory Service
 * Manages conversation history and session data in Redis
 */

const createLogger = logger.child({ module: 'memory-service' });

/**
 * Build Redis key for conversation
 * @param {string} empresaId - Company ID
 * @param {number} conversationId - Chatwoot conversation ID
 * @returns {string} Redis key
 */
function buildConversationKey(empresaId, conversationId) {
  return `conv:${empresaId}:${conversationId}`;
}

/**
 * Build Redis key for session data
 * @param {string} empresaId - Company ID
 * @param {number} conversationId - Chatwoot conversation ID
 * @returns {string} Redis key
 */
function buildSessionKey(empresaId, conversationId) {
  return `session:${empresaId}:${conversationId}`;
}

/**
 * Get conversation history from Redis
 * @param {string} empresaId - Company ID
 * @param {number} conversationId - Chatwoot conversation ID
 * @returns {Promise<Array>} Conversation history in Gemini format
 */
export async function getHistory(empresaId, conversationId) {
  try {
    const key = buildConversationKey(empresaId, conversationId);
    const history = await getJSON(key);

    if (!history) {
      createLogger.debug('No history found', {
        empresa_id: empresaId,
        conversation_id: conversationId
      });
      return [];
    }

    createLogger.debug('History retrieved', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      message_count: history.length
    });

    return history;

  } catch (error) {
    createLogger.error('Failed to get history', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      error: error.message
    });
    return [];
  }
}

/**
 * Add a message to conversation history
 * @param {string} empresaId - Company ID
 * @param {number} conversationId - Chatwoot conversation ID
 * @param {string} role - Message role ('user' or 'model')
 * @param {string} text - Message text
 * @returns {Promise<Array>} Updated history
 */
export async function addToHistory(empresaId, conversationId, role, text) {
  try {
    const key = buildConversationKey(empresaId, conversationId);

    // Get current history
    let history = await getHistory(empresaId, conversationId);

    // Add new message
    const message = {
      role,
      parts: [{ text }],
      timestamp: new Date().toISOString()
    };

    history.push(message);

    // Trim history if too long
    if (history.length > DEFAULT_LIMITS.CONVERSATION_HISTORY_SIZE) {
      // Keep system messages and recent messages
      const systemMessages = history.filter(msg =>
        msg.role === 'system' || msg.isSystemMessage
      );
      const recentMessages = history.slice(
        -(DEFAULT_LIMITS.CONVERSATION_HISTORY_SIZE - systemMessages.length)
      );
      history = [...systemMessages, ...recentMessages];
    }

    // Save to Redis with TTL
    await setWithExpiry(key, history, DEFAULT_LIMITS.SESSION_TTL_SECONDS);

    createLogger.debug('Message added to history', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      role,
      history_size: history.length
    });

    return history;

  } catch (error) {
    createLogger.error('Failed to add to history', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Add tool call and response to history
 * @param {string} empresaId - Company ID
 * @param {number} conversationId - Chatwoot conversation ID
 * @param {Object} functionCall - Function call object
 * @param {Object} functionResponse - Function response object
 * @returns {Promise<void>}
 */
export async function addToolCallToHistory(empresaId, conversationId, functionCall, functionResponse) {
  try {
    const key = buildConversationKey(empresaId, conversationId);

    // Get current history
    let history = await getHistory(empresaId, conversationId);

    // Add function call from model
    history.push({
      role: 'model',
      parts: [{
        functionCall: {
          name: functionCall.name,
          args: functionCall.args
        }
      }],
      timestamp: new Date().toISOString()
    });

    // Add function response
    history.push({
      role: 'function',
      parts: [{
        functionResponse: {
          name: functionCall.name,
          response: functionResponse
        }
      }],
      timestamp: new Date().toISOString()
    });

    // Trim if needed
    if (history.length > DEFAULT_LIMITS.CONVERSATION_HISTORY_SIZE) {
      history = history.slice(-DEFAULT_LIMITS.CONVERSATION_HISTORY_SIZE);
    }

    // Save to Redis
    await setWithExpiry(key, history, DEFAULT_LIMITS.SESSION_TTL_SECONDS);

    createLogger.debug('Tool call added to history', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      tool_name: functionCall.name,
      history_size: history.length
    });

  } catch (error) {
    createLogger.error('Failed to add tool call to history', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      tool_name: functionCall?.name,
      error: error.message
    });
    throw error;
  }
}

/**
 * Clear conversation history
 * @param {string} empresaId - Company ID
 * @param {number} conversationId - Chatwoot conversation ID
 * @returns {Promise<boolean>} True if cleared
 */
export async function clearHistory(empresaId, conversationId) {
  try {
    const key = buildConversationKey(empresaId, conversationId);
    const result = await redis.del(key);

    createLogger.info('History cleared', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      deleted: result > 0
    });

    return result > 0;

  } catch (error) {
    createLogger.error('Failed to clear history', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Get session data
 * @param {string} empresaId - Company ID
 * @param {number} conversationId - Chatwoot conversation ID
 * @returns {Promise<Object>} Session data
 */
export async function getSessionData(empresaId, conversationId) {
  try {
    const key = buildSessionKey(empresaId, conversationId);
    const data = await getJSON(key);

    return data || {};

  } catch (error) {
    createLogger.error('Failed to get session data', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      error: error.message
    });
    return {};
  }
}

/**
 * Set/merge session data
 * @param {string} empresaId - Company ID
 * @param {number} conversationId - Chatwoot conversation ID
 * @param {Object} data - Data to set/merge
 * @returns {Promise<Object>} Updated session data
 */
export async function setSessionData(empresaId, conversationId, data) {
  try {
    const key = buildSessionKey(empresaId, conversationId);

    // Get current data
    const currentData = await getSessionData(empresaId, conversationId);

    // Merge new data
    const updatedData = {
      ...currentData,
      ...data,
      updated_at: new Date().toISOString()
    };

    // Save to Redis
    await setWithExpiry(key, updatedData, DEFAULT_LIMITS.SESSION_TTL_SECONDS);

    createLogger.debug('Session data updated', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      keys: Object.keys(data)
    });

    return updatedData;

  } catch (error) {
    createLogger.error('Failed to set session data', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Update conversation history with new messages
 * Used when transferring between agents or updating history
 * @param {string} empresaId - Company ID
 * @param {number} conversationId - Chatwoot conversation ID
 * @param {Array} newHistory - Complete new history
 * @returns {Promise<void>}
 */
export async function updateHistory(empresaId, conversationId, newHistory) {
  try {
    const key = buildConversationKey(empresaId, conversationId);

    // Validate history format
    if (!Array.isArray(newHistory)) {
      throw new Error('History must be an array');
    }

    // Trim if needed
    let trimmedHistory = newHistory;
    if (newHistory.length > DEFAULT_LIMITS.CONVERSATION_HISTORY_SIZE) {
      trimmedHistory = newHistory.slice(-DEFAULT_LIMITS.CONVERSATION_HISTORY_SIZE);
    }

    // Save to Redis
    await setWithExpiry(key, trimmedHistory, DEFAULT_LIMITS.SESSION_TTL_SECONDS);

    createLogger.info('History updated', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      original_size: newHistory.length,
      final_size: trimmedHistory.length
    });

  } catch (error) {
    createLogger.error('Failed to update history', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Get conversation metadata
 * @param {string} empresaId - Company ID
 * @param {number} conversationId - Chatwoot conversation ID
 * @returns {Promise<Object>} Metadata
 */
export async function getConversationMetadata(empresaId, conversationId) {
  try {
    const [history, sessionData] = await Promise.all([
      getHistory(empresaId, conversationId),
      getSessionData(empresaId, conversationId)
    ]);

    const metadata = {
      message_count: history.length,
      has_history: history.length > 0,
      last_message_at: history.length > 0
        ? history[history.length - 1].timestamp
        : null,
      session_data_keys: Object.keys(sessionData),
      session_updated_at: sessionData.updated_at || null
    };

    return metadata;

  } catch (error) {
    createLogger.error('Failed to get conversation metadata', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      error: error.message
    });
    return {
      message_count: 0,
      has_history: false,
      last_message_at: null,
      session_data_keys: [],
      session_updated_at: null
    };
  }
}

/**
 * Archive conversation
 * Moves conversation data to archive with longer TTL
 * @param {string} empresaId - Company ID
 * @param {number} conversationId - Chatwoot conversation ID
 * @returns {Promise<boolean>} True if archived
 */
export async function archiveConversation(empresaId, conversationId) {
  try {
    const historyKey = buildConversationKey(empresaId, conversationId);
    const sessionKey = buildSessionKey(empresaId, conversationId);
    const archiveKey = `archive:${empresaId}:${conversationId}`;

    // Get current data
    const [history, sessionData] = await Promise.all([
      getHistory(empresaId, conversationId),
      getSessionData(empresaId, conversationId)
    ]);

    if (history.length === 0) {
      return false;
    }

    // Create archive object
    const archive = {
      history,
      session_data: sessionData,
      archived_at: new Date().toISOString(),
      message_count: history.length
    };

    // Save archive with 30-day TTL
    await setWithExpiry(archiveKey, archive, 30 * 24 * 60 * 60);

    // Delete active data
    await Promise.all([
      redis.del(historyKey),
      redis.del(sessionKey)
    ]);

    createLogger.info('Conversation archived', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      message_count: history.length
    });

    return true;

  } catch (error) {
    createLogger.error('Failed to archive conversation', {
      empresa_id: empresaId,
      conversation_id: conversationId,
      error: error.message
    });
    return false;
  }
}

/**
 * Build initial system message for conversation
 * @param {Object} agent - Agent configuration
 * @returns {Object} System message
 */
export function buildSystemMessage(agent) {
  return {
    role: 'system',
    parts: [{
      text: agent.prompt_ativo || 'You are a helpful assistant.'
    }],
    timestamp: new Date().toISOString(),
    isSystemMessage: true
  };
}

/**
 * Format history for Gemini API
 * Removes metadata and ensures correct format
 * @param {Array} history - Raw history from Redis
 * @returns {Array} Formatted history
 */
export function formatHistoryForGemini(history) {
  return history
    .filter(msg => msg.role === 'user' || msg.role === 'model' || msg.role === 'function')
    .map(msg => ({
      role: msg.role,
      parts: msg.parts
    }));
}