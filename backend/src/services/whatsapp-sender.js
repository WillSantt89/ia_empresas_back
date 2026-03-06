import { logger } from '../config/logger.js';
import { execFile } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

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
 * Upload media to Meta and get a media_id
 * @param {string} phoneNumberId
 * @param {string} token
 * @param {Buffer} buffer - File data
 * @param {string} mimeType
 * @returns {Promise<{media_id: string|null, success: boolean, error?: string}>}
 */
/**
 * Convert audio buffer from webm to ogg/opus using ffmpeg
 */
async function convertWebmToOgg(buffer) {
  const id = randomUUID();
  const inputPath = join(tmpdir(), `${id}.webm`);
  const outputPath = join(tmpdir(), `${id}.ogg`);

  try {
    await writeFile(inputPath, buffer);

    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-i', inputPath,
        '-c:a', 'libopus',
        '-b:a', '48k',
        '-ar', '48000',
        '-ac', '1',
        '-y', outputPath,
      ], { timeout: 15000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`ffmpeg error: ${error.message}`));
        else resolve(stdout);
      });
    });

    const oggBuffer = await readFile(outputPath);
    return oggBuffer;
  } finally {
    unlink(inputPath).catch(() => {});
    unlink(outputPath).catch(() => {});
  }
}

export async function uploadMediaToMeta(phoneNumberId, token, buffer, mimeType) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/media`;

  // Meta API doesn't accept audio/webm — convert to real ogg/opus via ffmpeg
  let uploadBuffer = buffer;
  let uploadMimeType = mimeType;
  let uploadFileName = 'file';

  if (mimeType === 'audio/webm' || mimeType.startsWith('audio/webm;')) {
    try {
      uploadBuffer = await convertWebmToOgg(buffer);
      uploadMimeType = 'audio/ogg; codecs=opus';
      uploadFileName = 'audio.ogg';
      createLogger.info('Audio converted from webm to ogg/opus');
    } catch (err) {
      createLogger.error(`Failed to convert webm to ogg: ${err.message}`);
      // Fallback: try sending as-is with ogg mime type
      uploadMimeType = 'audio/ogg; codecs=opus';
      uploadFileName = 'audio.ogg';
    }
  } else if (mimeType.startsWith('audio/ogg')) {
    uploadFileName = 'audio.ogg';
  }

  try {
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', uploadMimeType);
    formData.append('file', new Blob([uploadBuffer], { type: uploadMimeType }), uploadFileName);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data?.error?.message || `HTTP ${response.status}`;
      createLogger.error(`Meta API error uploading media: ${errorMsg} (HTTP ${response.status}, mime=${uploadMimeType})`);
      return { media_id: null, success: false, error: errorMsg };
    }

    createLogger.info('Media uploaded to Meta', { media_id: data.id, mimeType });
    return { media_id: data.id, success: true };
  } catch (error) {
    createLogger.error('Failed to upload media to Meta', { error: error.message });
    return { media_id: null, success: false, error: error.message };
  }
}

/**
 * Send a media message via WhatsApp
 * @param {string} phoneNumberId
 * @param {string} token
 * @param {string} recipientPhone
 * @param {string} mediaType - image, audio, video, document
 * @param {string} mediaId - Meta media_id (from upload)
 * @param {string} [caption] - Optional caption
 * @param {string} [fileName] - Optional filename (documents)
 * @returns {Promise<{wamid: string|null, success: boolean, error?: string}>}
 */
export async function sendMediaMessage(phoneNumberId, token, recipientPhone, mediaType, mediaId, caption, fileName) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

  try {
    const mediaObj = { id: mediaId };
    if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
      mediaObj.caption = caption;
    }
    if (fileName && mediaType === 'document') {
      mediaObj.filename = fileName;
    }

    const body = {
      messaging_product: 'whatsapp',
      to: recipientPhone,
      type: mediaType,
      [mediaType]: mediaObj,
    };

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
      createLogger.error('Meta API error sending media', { status: response.status, error: errorMsg, mediaType });
      return { wamid: null, success: false, error: errorMsg };
    }

    const wamid = data?.messages?.[0]?.id || null;
    createLogger.info('Media message sent via Meta API', { phoneNumberId, recipientPhone, mediaType, wamid });
    return { wamid, success: true };
  } catch (error) {
    createLogger.error('Failed to send media message', { error: error.message, mediaType });
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
