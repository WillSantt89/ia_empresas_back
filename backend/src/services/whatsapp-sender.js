import { logger } from '../config/logger.js';
import { convertToOggOpus } from './audio-converter.js';

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
 * @param {string} [contextMessageId] - Optional wamid of the message being replied to (creates a quote/reply in WhatsApp)
 * @returns {Promise<{wamid: string, success: boolean}>}
 */
export async function sendTextMessage(phoneNumberId, token, recipientPhone, text, contextMessageId = null) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

  try {
    const body = {
      messaging_product: 'whatsapp',
      to: recipientPhone,
      type: 'text',
      text: { body: text },
    };
    if (contextMessageId) {
      body.context = { message_id: contextMessageId };
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
 * Convert audio buffer to ogg/opus voice note compatible with WhatsApp Cloud API.
 *
 * Use case: Chrome/Firefox MediaRecorder produz webm/opus que a Meta API ate aceita
 * mas o WhatsApp Android nao reproduz consistentemente. Re-encodamos pra opus em
 * container ogg, parametros otimizados para voz (PTT).
 *
 * Parametros:
 *  -vn               descarta qualquer stream de video (webm pode ter ambos)
 *  -map 0:a:0        pega so o primeiro stream de audio
 *  -map_metadata -1  remove tags do encoder (Chrome tags)
 *  -c:a libopus      re-encode em opus
 *  -b:a 24k          24 kbps (PTT do whatsapp ~16-24k)
 *  -ar 48000         opus exige 48kHz internamente (libopus aceita outros e converte)
 *  -ac 1             mono (Meta exige mono)
 *  -application voip otimiza pra fala humana
 *  -frame_duration 60 frame longo, mais eficiente pra voz
 */
// Conversão de áudio extraída para src/services/audio-converter.js
// (compartilhada com meta-sender)

export async function uploadMediaToMeta(phoneNumberId, token, buffer, mimeType) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/media`;

  let uploadBuffer = buffer;
  let uploadMimeType = mimeType;
  let uploadFileName = 'file';

  // --- Audio: Meta API so reproduz consistentemente ogg/opus PTT ---
  // Convertemos QUALQUER audio (webm/Chrome, mp4/Safari, ogg/Firefox, etc.)
  // pra opus em container ogg, parametros otimizados pra voz (PTT).
  // Isso evita que iOS/Android antigos exibam "audio nao disponivel".
  const isAudio = (mimeType || '').toLowerCase().startsWith('audio/');

  if (isAudio) {
    try {
      uploadBuffer = await convertToOggOpus(buffer, mimeType);
      uploadMimeType = 'audio/ogg';
      uploadFileName = 'audio.ogg';
      createLogger.info(`Audio converted to ogg/opus voip (source=${mimeType}, size=${buffer.length}->${uploadBuffer.length})`);
    } catch (err) {
      createLogger.error(`Failed to convert audio to ogg/opus: ${err.message}`);
      // SEM FALLBACK INSEGURO: abortamos. Enviar formato rotulado errado corrompe o audio.
      return { media_id: null, success: false, error: `Falha ao converter audio: ${err.message}` };
    }
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

    createLogger.info('Media uploaded to Meta', { media_id: data.id, originalMime: mimeType, uploadMime: uploadMimeType });
    // Retornamos o mime EFETIVO enviado pra Meta + tamanho final (apos conversao)
    // para que a rota possa registrar no DB com precisao (ajuda em diagnostico).
    return {
      media_id: data.id,
      success: true,
      uploadedMimeType: uploadMimeType,
      uploadedSizeBytes: uploadBuffer.length,
      uploadedFileName: uploadFileName,
    };
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
export async function sendMediaMessage(phoneNumberId, token, recipientPhone, mediaType, mediaIdOrLink, caption, fileName, contextMessageId = null) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

  try {
    // Support both media_id and link-based sending
    const isLink = typeof mediaIdOrLink === 'string' && mediaIdOrLink.startsWith('http');
    const mediaObj = isLink ? { link: mediaIdOrLink } : { id: mediaIdOrLink };
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
    if (contextMessageId) {
      body.context = { message_id: contextMessageId };
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
