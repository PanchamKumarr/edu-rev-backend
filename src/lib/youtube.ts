/** YouTube watch / embed URLs use an 11-character video id. */
const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function normalizeId(raw: string | undefined): string | null {
  if (!raw) return null;
  const id = raw.split(/[?&#]/)[0];
  return YOUTUBE_ID_RE.test(id) ? id : null;
}

export function extractYoutubeVideoId(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  let href = trimmed;
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;

  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

  if (host === 'youtu.be') {
    const seg = parsed.pathname.split('/').filter(Boolean)[0];
    return normalizeId(seg);
  }

  const isYoutube =
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube.com');

  if (!isYoutube) return null;

  const fromQuery = parsed.searchParams.get('v');
  if (fromQuery) return normalizeId(fromQuery);

  const parts = parsed.pathname.split('/').filter(Boolean);
  const markers = ['embed', 'v', 'shorts', 'live'] as const;
  for (let i = 0; i < parts.length; i++) {
    if (markers.includes(parts[i] as (typeof markers)[number]) && parts[i + 1]) {
      const id = normalizeId(parts[i + 1]);
      if (id) return id;
    }
  }

  return null;
}
