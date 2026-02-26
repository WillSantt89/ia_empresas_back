import fetch from 'node-fetch';
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';
import { DEFAULT_LIMITS } from '../config/constants.js';

/**
 * Chatwoot Service
 * Handles communication with Chatwoot API for conversation management
 */

const createLogger = logger.child({ module: 'chatwoot-service' });

/**
 * Build Chatwoot API URL
 * @param {string} baseUrl - Base URL of Chatwoot instance
 * @param {string} accountId - Account ID
 * @param {string} path - API path
 * @returns {string} Complete API URL
 */
function buildApiUrl(baseUrl, accountId, path) {
  // Remove trailing slash from base URL
  const cleanBaseUrl = baseUrl.replace(/\/$/, '');
  // Remove leading slash from path
  const cleanPath = path.replace(/^\//, '');

  return `${cleanBaseUrl}/api/v1/accounts/${accountId}/${cleanPath}`;
}

/**
 * Make authenticated request to Chatwoot API
 * @param {Object} options - Request options
 * @param {string} options.url - API URL
 * @param {string} options.method - HTTP method
 * @param {string} options.apiKey - API access token
 * @param {Object} options.body - Request body
 * @param {number} options.timeout - Request timeout in ms
 * @returns {Promise<Object>} API response
 */
async function makeRequest(options) {
  const {
    url,
    method = 'GET',
    apiKey,
    body = null,
    timeout = DEFAULT_LIMITS.TOOL_TIMEOUT_MS
  } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': apiKey
      },
      body: body ? JSON.stringify(body) : null,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.message || `HTTP ${response.status}`);
    }

    return data;

  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }

    throw error;
  }
}

/**
 * Get conversation details
 * @param {Object} options - Request options
 * @param {string} options.baseUrl - Chatwoot base URL
 * @param {string} options.accountId - Account ID
 * @param {string} options.apiKey - API access token
 * @param {number} options.conversationId - Conversation ID
 * @returns {Promise<Object>} Conversation details
 */
export async function getConversation(options) {
  const { baseUrl, accountId, apiKey, conversationId } = options;

  try {
    const url = buildApiUrl(baseUrl, accountId, `conversations/${conversationId}`);

    const conversation = await makeRequest({
      url,
      apiKey
    });

    createLogger.debug('Conversation retrieved', {
      account_id: accountId,
      conversation_id: conversationId,
      status: conversation.status
    });

    return conversation;

  } catch (error) {
    createLogger.error('Failed to get conversation', {
      account_id: accountId,
      conversation_id: conversationId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Get conversation messages
 * @param {Object} options - Request options
 * @param {string} options.baseUrl - Chatwoot base URL
 * @param {string} options.accountId - Account ID
 * @param {string} options.apiKey - API access token
 * @param {number} options.conversationId - Conversation ID
 * @param {number} options.limit - Number of messages to retrieve
 * @returns {Promise<Array>} Array of messages
 */
export async function getMessages(options) {
  const {
    baseUrl,
    accountId,
    apiKey,
    conversationId,
    limit = 20
  } = options;

  try {
    const url = buildApiUrl(
      baseUrl,
      accountId,
      `conversations/${conversationId}/messages?limit=${limit}`
    );

    const response = await makeRequest({
      url,
      apiKey
    });

    const messages = response.payload || [];

    createLogger.debug('Messages retrieved', {
      account_id: accountId,
      conversation_id: conversationId,
      message_count: messages.length
    });

    return messages;

  } catch (error) {
    createLogger.error('Failed to get messages', {
      account_id: accountId,
      conversation_id: conversationId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Send a message to conversation
 * @param {Object} options - Request options
 * @param {string} options.baseUrl - Chatwoot base URL
 * @param {string} options.accountId - Account ID
 * @param {string} options.apiKey - API access token
 * @param {number} options.conversationId - Conversation ID
 * @param {string} options.content - Message content
 * @param {boolean} options.isPrivate - Whether message is private note
 * @param {string} options.messageType - Type of message (incoming/outgoing)
 * @returns {Promise<Object>} Created message
 */
export async function sendMessage(options) {
  const {
    baseUrl,
    accountId,
    apiKey,
    conversationId,
    content,
    isPrivate = false,
    messageType = 'outgoing'
  } = options;

  try {
    const url = buildApiUrl(
      baseUrl,
      accountId,
      `conversations/${conversationId}/messages`
    );

    const message = await makeRequest({
      url,
      method: 'POST',
      apiKey,
      body: {
        content,
        private: isPrivate,
        message_type: messageType
      }
    });

    createLogger.info('Message sent', {
      account_id: accountId,
      conversation_id: conversationId,
      message_id: message.id,
      is_private: isPrivate
    });

    return message;

  } catch (error) {
    createLogger.error('Failed to send message', {
      account_id: accountId,
      conversation_id: conversationId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Update conversation status
 * @param {Object} options - Request options
 * @param {string} options.baseUrl - Chatwoot base URL
 * @param {string} options.accountId - Account ID
 * @param {string} options.apiKey - API access token
 * @param {number} options.conversationId - Conversation ID
 * @param {string} options.status - New status (open/resolved/pending)
 * @returns {Promise<Object>} Updated conversation
 */
export async function updateConversationStatus(options) {
  const {
    baseUrl,
    accountId,
    apiKey,
    conversationId,
    status
  } = options;

  try {
    const url = buildApiUrl(
      baseUrl,
      accountId,
      `conversations/${conversationId}/toggle_status`
    );

    const conversation = await makeRequest({
      url,
      method: 'POST',
      apiKey,
      body: { status }
    });

    createLogger.info('Conversation status updated', {
      account_id: accountId,
      conversation_id: conversationId,
      new_status: status
    });

    return conversation;

  } catch (error) {
    createLogger.error('Failed to update conversation status', {
      account_id: accountId,
      conversation_id: conversationId,
      status,
      error: error.message
    });
    throw error;
  }
}

/**
 * Assign conversation to agent/team
 * @param {Object} options - Request options
 * @param {string} options.baseUrl - Chatwoot base URL
 * @param {string} options.accountId - Account ID
 * @param {string} options.apiKey - API access token
 * @param {number} options.conversationId - Conversation ID
 * @param {number} options.assigneeId - Agent ID to assign
 * @param {number} options.teamId - Team ID to assign
 * @returns {Promise<Object>} Updated conversation
 */
export async function assignConversation(options) {
  const {
    baseUrl,
    accountId,
    apiKey,
    conversationId,
    assigneeId = null,
    teamId = null
  } = options;

  try {
    const url = buildApiUrl(
      baseUrl,
      accountId,
      `conversations/${conversationId}/assignments`
    );

    const body = {};
    if (assigneeId) body.assignee_id = assigneeId;
    if (teamId) body.team_id = teamId;

    const conversation = await makeRequest({
      url,
      method: 'POST',
      apiKey,
      body
    });

    createLogger.info('Conversation assigned', {
      account_id: accountId,
      conversation_id: conversationId,
      assignee_id: assigneeId,
      team_id: teamId
    });

    return conversation;

  } catch (error) {
    createLogger.error('Failed to assign conversation', {
      account_id: accountId,
      conversation_id: conversationId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Add labels to conversation
 * @param {Object} options - Request options
 * @param {string} options.baseUrl - Chatwoot base URL
 * @param {string} options.accountId - Account ID
 * @param {string} options.apiKey - API access token
 * @param {number} options.conversationId - Conversation ID
 * @param {Array<string>} options.labels - Labels to add
 * @returns {Promise<Object>} Updated conversation
 */
export async function addLabels(options) {
  const {
    baseUrl,
    accountId,
    apiKey,
    conversationId,
    labels
  } = options;

  try {
    const url = buildApiUrl(
      baseUrl,
      accountId,
      `conversations/${conversationId}/labels`
    );

    const conversation = await makeRequest({
      url,
      method: 'POST',
      apiKey,
      body: { labels }
    });

    createLogger.info('Labels added to conversation', {
      account_id: accountId,
      conversation_id: conversationId,
      labels
    });

    return conversation;

  } catch (error) {
    createLogger.error('Failed to add labels', {
      account_id: accountId,
      conversation_id: conversationId,
      labels,
      error: error.message
    });
    throw error;
  }
}

/**
 * Get contact details
 * @param {Object} options - Request options
 * @param {string} options.baseUrl - Chatwoot base URL
 * @param {string} options.accountId - Account ID
 * @param {string} options.apiKey - API access token
 * @param {number} options.contactId - Contact ID
 * @returns {Promise<Object>} Contact details
 */
export async function getContact(options) {
  const { baseUrl, accountId, apiKey, contactId } = options;

  try {
    const url = buildApiUrl(baseUrl, accountId, `contacts/${contactId}`);

    const contact = await makeRequest({
      url,
      apiKey
    });

    createLogger.debug('Contact retrieved', {
      account_id: accountId,
      contact_id: contactId
    });

    return contact;

  } catch (error) {
    createLogger.error('Failed to get contact', {
      account_id: accountId,
      contact_id: contactId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Update contact attributes
 * @param {Object} options - Request options
 * @param {string} options.baseUrl - Chatwoot base URL
 * @param {string} options.accountId - Account ID
 * @param {string} options.apiKey - API access token
 * @param {number} options.contactId - Contact ID
 * @param {Object} options.customAttributes - Custom attributes to update
 * @returns {Promise<Object>} Updated contact
 */
export async function updateContactAttributes(options) {
  const {
    baseUrl,
    accountId,
    apiKey,
    contactId,
    customAttributes
  } = options;

  try {
    const url = buildApiUrl(baseUrl, accountId, `contacts/${contactId}`);

    const contact = await makeRequest({
      url,
      method: 'PUT',
      apiKey,
      body: { custom_attributes: customAttributes }
    });

    createLogger.info('Contact attributes updated', {
      account_id: accountId,
      contact_id: contactId,
      attributes: Object.keys(customAttributes)
    });

    return contact;

  } catch (error) {
    createLogger.error('Failed to update contact attributes', {
      account_id: accountId,
      contact_id: contactId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Send typing indicator
 * @param {Object} options - Request options
 * @param {string} options.baseUrl - Chatwoot base URL
 * @param {string} options.accountId - Account ID
 * @param {string} options.apiKey - API access token
 * @param {number} options.conversationId - Conversation ID
 * @param {string} options.status - Typing status (on/off)
 * @returns {Promise<void>}
 */
export async function sendTypingIndicator(options) {
  const {
    baseUrl,
    accountId,
    apiKey,
    conversationId,
    status = 'on'
  } = options;

  try {
    const url = buildApiUrl(
      baseUrl,
      accountId,
      `conversations/${conversationId}/toggle_typing_status`
    );

    await makeRequest({
      url,
      method: 'POST',
      apiKey,
      body: { typing_status: status }
    });

    createLogger.debug('Typing indicator sent', {
      account_id: accountId,
      conversation_id: conversationId,
      status
    });

  } catch (error) {
    createLogger.error('Failed to send typing indicator', {
      account_id: accountId,
      conversation_id: conversationId,
      error: error.message
    });
    // Don't throw - typing indicators are not critical
  }
}

/**
 * Search conversations
 * @param {Object} options - Request options
 * @param {string} options.baseUrl - Chatwoot base URL
 * @param {string} options.accountId - Account ID
 * @param {string} options.apiKey - API access token
 * @param {string} options.query - Search query
 * @param {number} options.page - Page number
 * @returns {Promise<Object>} Search results
 */
export async function searchConversations(options) {
  const {
    baseUrl,
    accountId,
    apiKey,
    query,
    page = 1
  } = options;

  try {
    const url = buildApiUrl(
      baseUrl,
      accountId,
      `conversations/filter?q=${encodeURIComponent(query)}&page=${page}`
    );

    const results = await makeRequest({
      url,
      method: 'POST',
      apiKey,
      body: {}
    });

    createLogger.debug('Conversations searched', {
      account_id: accountId,
      query,
      result_count: results.payload?.length || 0
    });

    return results;

  } catch (error) {
    createLogger.error('Failed to search conversations', {
      account_id: accountId,
      query,
      error: error.message
    });
    throw error;
  }
}

/**
 * Validate Chatwoot webhook signature
 * @param {string} payload - Request body as string
 * @param {string} signature - Signature from header
 * @param {string} secret - Webhook secret
 * @returns {boolean} True if valid
 */
export function validateWebhookSignature(payload, signature, secret) {
  try {
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    return signature === expectedSignature;

  } catch (error) {
    createLogger.error('Failed to validate webhook signature', {
      error: error.message
    });
    return false;
  }
}

/**
 * Parse Chatwoot webhook event
 * @param {Object} payload - Webhook payload
 * @returns {Object} Parsed event data
 */
/**
 * Unassign agent from conversation (return to unassigned pool)
 * Used by timeout-checker when human agent doesn't respond in time
 * @param {Object} chatwootConfig - Chatwoot connection config
 * @param {string} chatwootConfig.chatwoot_url - Chatwoot base URL
 * @param {string} chatwootConfig.chatwoot_api_token - API access token
 * @param {string} chatwootConfig.chatwoot_account_id - Account ID
 * @param {number} conversationId - Conversation ID
 * @returns {Promise<Object>} Updated conversation
 */
export async function unassignAgent(chatwootConfig, conversationId) {
  const { chatwoot_url, chatwoot_api_token, chatwoot_account_id } = chatwootConfig;

  try {
    const url = buildApiUrl(
      chatwoot_url,
      chatwoot_account_id,
      `conversations/${conversationId}/assignments`
    );

    const result = await makeRequest({
      url,
      method: 'POST',
      apiKey: chatwoot_api_token,
      body: { assignee_id: null }
    });

    createLogger.info('Agent unassigned from conversation', {
      account_id: chatwoot_account_id,
      conversation_id: conversationId
    });

    return result;

  } catch (error) {
    createLogger.error('Failed to unassign agent', {
      account_id: chatwoot_account_id,
      conversation_id: conversationId,
      error: error.message
    });
    throw error;
  }
}

export function parseWebhookEvent(payload) {
  const {
    event,
    id,
    content,
    conversation,
    sender,
    account,
    inbox,
    message_type
  } = payload;

  return {
    event,
    id,
    content,
    message_type,
    conversation: conversation ? {
      id: conversation.id,
      status: conversation.status,
      account_id: conversation.account_id,
      inbox_id: conversation.inbox_id,
      contact_id: conversation.contact?.id
    } : null,
    sender: sender ? {
      id: sender.id,
      name: sender.name,
      email: sender.email,
      phone_number: sender.phone_number
    } : null,
    account: account ? {
      id: account.id,
      name: account.name
    } : null,
    inbox: inbox ? {
      id: inbox.id,
      name: inbox.name
    } : null
  };
}

/**
 * Format message for Chatwoot
 * @param {string} text - Message text
 * @param {Object} options - Formatting options
 * @returns {string} Formatted message
 */
export function formatMessage(text, options = {}) {
  let formatted = text;

  // Convert markdown bold to plain text
  if (options.stripMarkdown) {
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '$1');
    formatted = formatted.replace(/\*(.*?)\*/g, '$1');
  }

  // Add line breaks for better readability
  if (options.addLineBreaks) {
    formatted = formatted.replace(/\. /g, '.\n');
  }

  // Truncate if too long
  if (options.maxLength && formatted.length > options.maxLength) {
    formatted = formatted.substring(0, options.maxLength - 3) + '...';
  }

  return formatted;
}