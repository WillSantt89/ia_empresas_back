import { execFile } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../config/logger.js';

/**
 * Audio Converter — utilitário compartilhado entre whatsapp-sender e meta-sender.
 *
 * Converte qualquer áudio (webm, mp4, ogg, etc.) em ogg/opus PTT compatível com
 * todas as variantes do WhatsApp (iOS, Android, Web). Parâmetros calibrados pra
 * voz humana (voip), bitrate 32k (suficiente pra clareza, leve pra rede).
 */

const createLogger = logger.child({ module: 'audio-converter' });

export function extFromMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('amr')) return 'amr';
  if (m.includes('wav')) return 'wav';
  return 'bin';
}

/**
 * Converte buffer de áudio para ogg/opus PTT.
 * @param {Buffer} buffer audio source
 * @param {string} [mimeOrExt='audio/webm'] mime type ou extensão da fonte
 * @returns {Promise<Buffer>} buffer ogg/opus pronto pra Meta
 */
export async function convertToOggOpus(buffer, mimeOrExt = 'audio/webm') {
  const sourceExt = mimeOrExt.includes('/') ? extFromMime(mimeOrExt) : mimeOrExt;
  const id = randomUUID();
  const inputPath = join(tmpdir(), `${id}_in.${sourceExt}`);
  const outputPath = join(tmpdir(), `${id}_out.ogg`);

  try {
    await writeFile(inputPath, buffer);

    const ffmpegArgs = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-map', '0:a:0',
      '-map_metadata', '-1',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ar', '48000',
      '-ac', '1',
      '-application', 'voip',
      '-frame_duration', '20',
      '-vbr', 'on',
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
  } catch (err) {
    createLogger.error({ err: err.message, sourceMime: mimeOrExt }, 'Falha ao converter audio');
    throw err;
  } finally {
    unlink(inputPath).catch(() => {});
    unlink(outputPath).catch(() => {});
  }
}

/**
 * Decide se um mime de áudio precisa ser convertido.
 * Trata como "precisa converter" tudo que NÃO seja já um audio/ogg.
 */
export function precisaConverterAudio(mimeType) {
  if (!mimeType) return false;
  const mime = mimeType.toLowerCase();
  if (!mime.startsWith('audio/')) return false;
  // Mesmo audio/ogg vindo do navegador convém re-encodar (header inconsistente)
  return true;
}
