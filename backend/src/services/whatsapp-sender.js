import { logger } from '../config/logger.js';

/**
 * WhatsApp Sender Service
 * Sends messages directly via Meta Graph API (replaces n8n Flow 2)
 */

const createLogger = logger.child({ module: 'whatsapp-sender' });

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Send a text message via WhatsApp
 * @param {string} phoneNumberId - WhatsApp Business phone number ID
 * @param {string} token - Graph API access token (decrypted)
 * @param {string} recipientPhone - Recipient phone number (e.g., "5511999999999")
 * @param {string} text - Message text
 * @returns {Promise<{wamid: string, success: boolean}>}
 */
export async function sendTextMessage(phoneNumberId, token, recipientPhone, text) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'text',
        text: { body: text },
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data?.error?.message || `HTTP ${response.status}`;
      createLogger.error('Meta API error sending text', {
        status: response.status,
        error: errorMsg,
        phoneNumberId,
        recipientPhone,
      });
      return { wamid: null, success: false, error: errorMsg };
    }

    const wamid = data?.messages?.[0]?.id || null;

    createLogger.info('Text message sent via Meta API', {
      phoneNumberId,
      recipientPhone,
      wamid,
    });

    return { wamid, success: true };
  } catch (error) {
    createLogger.error('Failed to send text message', {
      error: error.message,
      phoneNumberId,
      recipientPhone,
    });
    return { wamid: null, success: false, error: error.message };
  }
}

/**
 * Send a template message via WhatsApp (stub for future use)
 * @param {string} phoneNumberId - WhatsApp Business phone number ID
 * @param {string} token - Graph API access token (decrypted)
 * @param {string} recipientPhone - Recipient phone number
 * @param {string} templateName - Template name
 * @param {string} languageCode - Language code (e.g., "pt_BR")
 * @param {Array} components - Template components
 * @returns {Promise<{wamid: string, success: boolean}>}
 */
export async function sendTemplateMessage(phoneNumberId, token, recipientPhone, templateName, languageCode = 'pt_BR', components = []) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

  try {
    const body = {
      messaging_product: 'whatsapp',
      to: recipientPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
      },
    };

    if (components.length > 0) {
      body.template.components = components;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data?.error?.message || `HTTP ${response.status}`;
      createLogger.error('Meta API error sending template', {
        status: response.status,
        error: errorMsg,
        templateName,
      });
      return { wamid: null, success: false, error: errorMsg };
    }

    const wamid = data?.messages?.[0]?.id || null;

    createLogger.info('Template message sent via Meta API', {
      phoneNumberId,
      recipientPhone,
      templateName,
      wamid,
    });

    return { wamid, success: true };
  } catch (error) {
    createLogger.error('Failed to send template message', {
      error: error.message,
      phoneNumberId,
      recipientPhone,
      templateName,
    });
    return { wamid: null, success: false, error: error.message };
  }
}

/**
 * Mark a message as read
 * @param {string} phoneNumberId - WhatsApp Business phone number ID
 * @param {string} token - Graph API access token (decrypted)
 * @param {string} messageId - WhatsApp message ID to mark as read
 */
export async function markAsRead(phoneNumberId, token, messageId) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    createLogger.warn('Failed to mark message as read', {
      error: error.message,
      messageId,
    });
  }
}
