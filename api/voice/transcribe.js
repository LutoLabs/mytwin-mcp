// POST /api/voice/transcribe
//
// Whisper-only transcription — no storage, no extraction.
// Used as a fallback when the Deepgram WebSocket path fails on the client.
//
// Body:  { audio_base64: string, mime_type: string }
// Response: { transcript: string }
//
// Deliberately lean: no cap consumed (transcription is a utility step, not
// a storage action). The caller is responsible for deciding what to do with
// the transcript.

import OpenAI from 'openai';
import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { UserError } from '../../lib/errors.js';

const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 8 MB

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { audio_base64, mime_type } = req.body || {};
  if (typeof audio_base64 !== 'string' || !audio_base64) {
    return res.status(400).json({ error: 'audio_base64 is required' });
  }
  if (typeof mime_type !== 'string' || !mime_type) {
    return res.status(400).json({ error: 'mime_type is required (e.g. audio/webm)' });
  }

  let audioBuf;
  try {
    audioBuf = Buffer.from(audio_base64, 'base64');
  } catch {
    return res.status(400).json({ error: 'audio_base64 is not valid base64' });
  }
  if (audioBuf.length === 0) {
    return res.status(400).json({ error: 'Decoded audio is empty' });
  }
  if (audioBuf.length > MAX_AUDIO_BYTES) {
    return res.status(413).json({
      error: `Audio exceeds ${MAX_AUDIO_BYTES / 1024 / 1024} MB limit`,
    });
  }

  return runTwin(req, res, {
    toolName: 'voice_transcribe',
    fn: async () => {
      const ext = mime_type.includes('webm') ? 'webm'
                : mime_type.includes('mp4')  ? 'm4a'
                : mime_type.includes('wav')  ? 'wav'
                : 'webm';
      const file = new File([audioBuf], `voice.${ext}`, { type: mime_type });

      let transcript;
      try {
        const result = await getOpenAI().audio.transcriptions.create({
          file,
          model: 'whisper-1',
        });
        transcript = result.text || '';
      } catch (err) {
        // Never forward the provider's error text to the client. Log the detail
        // server-side; show one short, safe line.
        console.error('[voice/transcribe] upstream error', {
          message: err?.message,
          status:  err?.status ?? null,
        });
        throw new UserError('Could not transcribe that audio. Try again in a moment.');
      }

      return { transcript };
    },
  });
}
