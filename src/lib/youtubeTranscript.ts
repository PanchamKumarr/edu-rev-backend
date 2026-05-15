import { YoutubeTranscript, YoutubeTranscriptError } from 'youtube-transcript';
import { extractYoutubeVideoId } from './youtube.js';

/** Keep transcript small so MCQ prompts stay under Groq on-demand TPM / request limits. */
const MAX_TRANSCRIPT_CHARS = 5_000;

export type TranscriptResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: 'not_youtube' | 'unavailable'; message: string };

/**
 * Fetches captions for a YouTube `videoUrl` (or id) and returns plain text.
 * Returns `not_youtube` when the URL is not a recognized YouTube link.
 */
export async function fetchYoutubeTranscriptPlain(videoUrl: string): Promise<TranscriptResult> {
  const trimmed = videoUrl.trim();
  if (!trimmed || !extractYoutubeVideoId(trimmed)) {
    return { ok: false, reason: 'not_youtube', message: 'Not a YouTube URL' };
  }

  try {
    const chunks = await YoutubeTranscript.fetchTranscript(trimmed);
    const raw = chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
    if (!raw) {
      return { ok: false, reason: 'unavailable', message: 'Transcript was empty' };
    }
    const truncated = raw.length > MAX_TRANSCRIPT_CHARS;
    const text = truncated ? `${raw.slice(0, MAX_TRANSCRIPT_CHARS)}\n[...transcript truncated...]` : raw;
    return { ok: true, text, truncated };
  } catch (e: unknown) {
    const msg =
      e instanceof YoutubeTranscriptError
        ? e.message
        : e instanceof Error
          ? e.message
          : 'Unknown error';
    return { ok: false, reason: 'unavailable', message: msg };
  }
}
