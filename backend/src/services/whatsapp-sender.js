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
async function convertToOggOpus(buffer, sourceExt = 'webm') {
  const id = randomUUID();
  const inputPath = join(tmpdir(), `${id}.${sourceExt}`);
  const outputPath = join(tmpdir(), `${id}.ogg`);

  try {
    await writeFile(inputPath, buffer);

    const ffmpegArgs = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-map', '0:a:0',
      '-map_metadata', '-1',
      '-c:a', 'libopus',
      '-b:a', '24k',
      '-ar', '48000',
      '-ac', '1',
      '-application', 'voip',
      '-frame_duration', '60',
      outputPath,
    ];

    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ffmpegArgs, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`ffmpeg failed: ${error.message} | stderr: ${(stderr || '').slice(-500)}`));
        } else {
          resolve(stdout);
        }
      });
    });

    const oggBuffer = await readFile(outputPath);
    if (!oggBuffer || oggBuffer.length === 0) {
      throw new Error('ffmpeg produced empty output file');
    }
    return oggBuffer;
  } finally {
    unlink(inputPath).catch(() => {});
    unlink(outputPath).catch(() => {});
  }
}

export async function uploadMediaToMeta(phoneNumberId, token, buffer, mimeType) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/media`;

  let uploadBuffer = buffer;
  let uploadMimeType = mimeType;
  let uploadFileName = 'file';

  // --- Audio: Meta API so aceita opus em container ogg pra PTT ---
  // Convertemos webm/opus (Chrome/Firefox MediaRecorder) pra ogg/opus.
  // Tambem re-encodamos audio/ogg vindo do navegador pra garantir compatibilidade
  // de header (alguns ogg gerados pelo browser tem packets que o WhatsApp rejeita).
  const isWebmAudio = mimeType === 'audio/webm' || mimeType.startsWith('audio/webm;') || mimeType.startsWith('audio/webm ');
  const isOggAudio = mimeType === 'audio/ogg' || mimeType.startsWith('audio/ogg;') || mimeType.startsWith('audio/ogg ');

  if (isWebmAudio || isOggAudio) {
    try {
      const sourceExt = isWebmAudio ? 'webm' : 'ogg';
      uploadBuffer = await convertToOggOpus(buffer, sourceExt);
      uploadMimeType = 'audio/ogg';
      uploadFileName = 'audio.ogg';
      createLogger.info(`Audio converted to ogg/opus voip (source=${mimeType}, size=${buffer.length}->${uploadBuffer.length})`);
    } catch (err) {
      createLogger.error(`Failed to convert audio to ogg/opus: ${err.message}`);
      // SEM FALLBACK INSEGURO: abortamos. Enviar webm rotulado como ogg corrompe o audio.
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
export async function sendMediaMessage(phoneNumberId, token, recipientPhone, mediaType, mediaIdOrLink, caption, fileName) {
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
