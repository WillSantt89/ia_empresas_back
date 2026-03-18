import { logger } from '../config/logger.js';

/**
 * Media Handler Service
 * Parses Meta webhook payloads, downloads media, converts to Gemini format
 */

const createLogger = logger.child({ module: 'media-handler' });

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Parse a single message object from Meta webhook payload
 * @param {Object} messageObj - messages[0] from Meta payload
 * @returns {Object} { type, text, mediaId, mimeType, caption, fileName }
 */
export function parseMetaMessage(messageObj) {
  if (!messageObj || !messageObj.type) {
    return { type: 'unknown', text: null };
  }

  const type = messageObj.type;

  switch (type) {
    case 'text':
      return {
        type: 'text',
        text: messageObj.text?.body || '',
      };

    case 'image':
      return {
        type: 'image',
        mediaId: messageObj.image?.id,
        mimeType: messageObj.image?.mime_type || 'image/jpeg',
        caption: messageObj.image?.caption || null,
      };

    case 'audio':
      return {
        type: 'audio',
        mediaId: messageObj.audio?.id,
        mimeType: messageObj.audio?.mime_type || 'audio/ogg',
      };

    case 'video':
      return {
        type: 'video',
        mediaId: messageObj.video?.id,
        mimeType: messageObj.video?.mime_type || 'video/mp4',
        caption: messageObj.video?.caption || null,
      };

    case 'document':
      return {
        type: 'document',
        mediaId: messageObj.document?.id,
        mimeType: messageObj.document?.mime_type || 'application/pdf',
        caption: messageObj.document?.caption || null,
        fileName: messageObj.document?.filename || null,
      };

    case 'sticker':
      return {
        type: 'sticker',
        mediaId: messageObj.sticker?.id,
        mimeType: messageObj.sticker?.mime_type || 'image/webp',
      };

    case 'contacts': {
      const contacts = messageObj.contacts || [];
      const descriptions = contacts.map(contact => {
        const name = contact.name?.formatted_name || contact.name?.first_name || 'Desconhecido';
        const phones = (contact.phones || []).map(p => p.phone || p.wa_id).filter(Boolean).join(', ');
        return phones ? `${name} (Tel: ${phones})` : name;
      });
      return {
        type: 'contacts',
        text: `Contato(s) recebido(s): ${descriptions.join('; ')}`,
      };
    }

    case 'location': {
      const loc = messageObj.location || {};
      const parts = [`Lat: ${loc.latitude}, Lng: ${loc.longitude}`];
      if (loc.name) parts.push(loc.name);
      if (loc.address) parts.push(loc.address);
      return {
        type: 'location',
        text: `Localização: ${parts.join(' - ')}`,
      };
    }

    case 'reaction':
      return {
        type: 'reaction',
        text: messageObj.reaction?.emoji
          ? `[Reagiu com ${messageObj.reaction.emoji}]`
          : null,
      };

    case 'button':
      return {
        type: 'text',
        text: messageObj.button?.text || messageObj.button?.payload || '',
      };

    case 'interactive': {
      const interactive = messageObj.interactive;
      if (interactive?.type === 'button_reply') {
        return { type: 'text', text: interactive.button_reply?.title || '' };
      }
      if (interactive?.type === 'list_reply') {
        return { type: 'text', text: interactive.list_reply?.title || '' };
      }
      return { type: 'text', text: JSON.stringify(interactive) };
    }

    case 'referral': {
      const ref = messageObj.referral || {};
      const body = messageObj.text?.body || '';
      const adText = [body, ref.headline, ref.body].filter(Boolean).join(' | ');
      return {
        type: 'text',
        text: adText || '[Cliente chegou via anúncio]',
      };
    }

    case 'request_welcome':
      return {
        type: 'text',
        text: messageObj.text?.body || '[Primeiro contato do cliente]',
      };

    case 'ephemeral':
      return {
        type: 'text',
        text: messageObj.ephemeral?.text || messageObj.text?.body || '[Mensagem temporária recebida]',
      };

    case 'unsupported':
      return {
        type: 'text',
        text: '[Mensagem não suportada pelo WhatsApp (enquete, edição ou canal)]',
      };

    case 'order':
      return {
        type: 'text',
        text: '[Pedido recebido via catálogo do WhatsApp]',
      };

    case 'system':
      return {
        type: 'text',
        text: messageObj.system?.body || '[Mensagem do sistema WhatsApp]',
      };

    default:
      createLogger.warn('Unknown message type', { type });
      return {
        type: 'unknown',
        text: `[Mensagem do tipo "${type}" não suportada]`,
      };
  }
}

/**
 * Download media from WhatsApp via Meta Graph API (2-step process)
 * Step 1: GET media URL from media ID
 * Step 2: Download binary from URL
 * @param {string} mediaId - WhatsApp media ID
 * @param {string} accessToken - Graph API access token (decrypted)
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 */
export async function downloadWhatsAppMedia(mediaId, accessToken) {
  // Step 1: Get media URL
  const metaUrl = `${GRAPH_API_BASE}/${mediaId}`;
  const metaResponse = await fetch(metaUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10000),
  });

  if (!metaResponse.ok) {
    throw new Error(`Failed to get media URL: HTTP ${metaResponse.status}`);
  }

  const metaData = await metaResponse.json();
  const downloadUrl = metaData.url;
  const mimeType = metaData.mime_type;

  if (!downloadUrl) {
    throw new Error('No download URL in media metadata');
  }

  // Step 2: Download binary
  const downloadResponse = await fetch(downloadUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });

  if (!downloadResponse.ok) {
    throw new Error(`Failed to download media: HTTP ${downloadResponse.status}`);
  }

  const arrayBuffer = await downloadResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  createLogger.debug('Media downloaded', {
    mediaId,
    mimeType,
    sizeBytes: buffer.length,
  });

  return { buffer, mimeType: mimeType || 'application/octet-stream' };
}

/**
 * Convert a media buffer to Gemini inlineData part
 * @param {Buffer} buffer - Media binary data
 * @param {string} mimeType - MIME type
 * @returns {Object} Gemini inlineData part
 */
export function mediaToGeminiPart(buffer, mimeType) {
  return {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType,
    },
  };
}

/**
 * Build Gemini parts from a parsed Meta message
 * Downloads media if needed and converts to Gemini format
 * @param {Object} parsedMessage - Result of parseMetaMessage()
 * @param {string} accessToken - Graph API access token (for media download)
 * @returns {Promise<{parts: Array, historyText: string}>}
 *   - parts: array for Gemini API (inlineData for media, text for text)
 *   - historyText: descriptive text to save in Redis history (no base64)
 */
export async function buildGeminiParts(parsedMessage, accessToken) {
  const { type, text, mediaId, mimeType, caption, fileName } = parsedMessage;

  // Text-based types: text, contacts, location, reaction, button, interactive
  if (text && !mediaId) {
    return {
      parts: [{ text }],
      historyText: text,
      mediaBuffer: null,
      mediaMimeType: null,
      mediaFileName: null,
    };
  }

  // Media types: image, audio, video, document, sticker
  if (mediaId) {
    try {
      const { buffer, mimeType: downloadedMimeType } = await downloadWhatsAppMedia(mediaId, accessToken);
      const actualMimeType = downloadedMimeType || mimeType;
      const geminiPart = mediaToGeminiPart(buffer, actualMimeType);

      const parts = [geminiPart];
      let historyText;

      switch (type) {
        case 'image':
          historyText = caption ? `[Imagem recebida] ${caption}` : '[Imagem recebida]';
          if (caption) parts.push({ text: caption });
          break;
        case 'audio':
          historyText = '[Áudio recebido]';
          parts.push({ text: 'O usuário enviou um áudio. Por favor, ouça/transcreva e responda.' });
          break;
        case 'video':
          historyText = caption ? `[Vídeo recebido] ${caption}` : '[Vídeo recebido]';
          if (caption) parts.push({ text: caption });
          break;
        case 'document':
          historyText = fileName ? `[Documento recebido: ${fileName}]` : '[Documento recebido]';
          if (caption) {
            historyText += ` ${caption}`;
            parts.push({ text: `Documento: ${fileName || 'arquivo'}. ${caption}` });
          } else if (fileName) {
            parts.push({ text: `O usuário enviou o documento: ${fileName}` });
          }
          break;
        case 'sticker':
          historyText = '[Sticker recebido]';
          break;
        default:
          historyText = `[Mídia recebida: ${type}]`;
      }

      return { parts, historyText, mediaBuffer: buffer, mediaMimeType: actualMimeType, mediaFileName: fileName || null };
    } catch (error) {
      createLogger.error('Failed to download/process media', {
        type,
        mediaId,
        error: error.message,
      });

      // Fallback: send text description instead of media
      const fallbackText = `[Não foi possível processar a mídia (${type}). O usuário enviou um(a) ${type}.${caption ? ` Legenda: ${caption}` : ''}]`;
      return {
        parts: [{ text: fallbackText }],
        historyText: `[${type} recebido - falha no download]`,
        mediaBuffer: null,
        mediaMimeType: null,
        mediaFileName: null,
      };
    }
  }

  // Fallback for unknown types
  const fallbackText = text || `[Mensagem do tipo "${type}" recebida]`;
  return {
    parts: [{ text: fallbackText }],
    historyText: fallbackText,
    mediaBuffer: null,
    mediaMimeType: null,
    mediaFileName: null,
  };
}
