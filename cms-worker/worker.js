const OWNER = 'caspervangorkom';
const REPO = 'map';
const BRANCH = 'cms-v2';
const PATH = 'cases.json';
const MAX_BODY_BYTES = 2_000_000;
const MAX_CASES = 10_000;
const MAX_GEOCODE_QUERY = 200;
const MAX_IMAGE_URL = 2000;
const MAX_DOSSIER_BYTES = 2_000_000;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin'
  };
}

function json(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) }
  });
}

function validCase(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (typeof c.title !== 'string' || !c.title.trim() || c.title.length > 500) return false;
  if (typeof c.link !== 'string' || !c.link.trim() || c.link.length > 2000) return false;
  if (typeof c.lat !== 'number' || !Number.isFinite(c.lat) || c.lat < -90 || c.lat > 90) return false;
  if (typeof c.lng !== 'number' || !Number.isFinite(c.lng) || c.lng < -180 || c.lng > 180) return false;
  return true;
}

async function github(request, env, path, options = {}) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'Coldcase-Zaken-CMS',
      ...(options.headers || {})
    }
  });
}

function isAllowedDossierUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (u.hostname === 'coldcasezaken.nl' || u.hostname === 'www.coldcasezaken.nl');
  } catch {
    return false;
  }
}

function decodeHtmlEntities(value) {
  let result = String(value ?? '');
  for (let pass = 0; pass < 3; pass++) {
    const decoded = result
      .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&#([0-9]+);?/g, (_, dec) => {
        const code = parseInt(dec, 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => ({
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'
      })[name.toLowerCase()] || _);
    if (decoded === result) break;
    result = decoded;
  }
  return result;
}

function absoluteImageUrl(value, base) {
  if (!value) return null;
  const cleaned = decodeHtmlEntities(value).trim();
  if (!cleaned || /^(undefined|null|about:blank)$/i.test(cleaned)) return null;
  try {
    const u = new URL(cleaned, base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (/\/undefined(?:$|[/?#])/i.test(u.pathname)) return null;
    if (/\/null(?:$|[/?#])/i.test(u.pathname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function imageLooksUseful(url) {
  const s = url.toLowerCase();
  if (/facebook|instagram|twitter|x\.com|youtube/.test(s)) return false;
  if (/favicon|logo|icon|sprite|tracking|pixel|avatar/.test(s)) return false;
  if (/\/undefined(?:$|[/?#])|\/null(?:$|[/?#])/.test(s)) return false;
  if (/\.(svg|gif)(\?|$)/.test(s)) return false;
  if (/[?&](?:tracking|pixel|analytics)=/i.test(s)) return false;
  return true;
}

function firstSrcsetUrl(value) {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  if (!first) return null;
  return first.split(/\s+/)[0] || null;
}

function stripNonContentSections(html) {
  return html
    .replace(/<\s*(script|style|noscript|template|svg|canvas|iframe|footer|nav|header|aside)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*(script|style|noscript|template|svg|canvas|iframe|footer|nav|header|aside)\b[^>]*\/?>/gi, ' ');
}

function contentSections(html) {
  const sections = [];
  const pushMatches = (re) => {
    let m;
    while ((m = re.exec(html))) {
      if (m[1]) sections.push(m[1]);
    }
  };

  pushMatches(/<main\b[^>]*>([\s\S]*?)<\/main>/gi);
  pushMatches(/<article\b[^>]*>([\s\S]*?)<\/article>/gi);

  if (sections.length) return sections;

  const containerRe = /<([a-z0-9]+)\b[^>]*(?:id|class)=["'][^"']*(?:content|article|post|page|main|story|dossier|zaak)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = containerRe.exec(html))) {
    if (m[2]) sections.push(m[2]);
  }

  if (sections.length) return sections;
  return [stripNonContentSections(html)];
}

function imageTagLooksUseful(tag) {
  const lower = tag.toLowerCase();
  if (/(?:class|id|alt|title)=["'][^"']*(?:logo|icon|avatar|social|facebook|instagram|twitter|youtube|footer|header|nav|menu|cookie|tracking|pixel)[^"']*["']/.test(lower)) return false;

  const widthMatch = lower.match(/\bwidth\s*=\s*["']\s*(\d+)/i);
  const heightMatch = lower.match(/\bheight\s*=\s*["']\s*(\d+)/i);
  const width = widthMatch ? Number(widthMatch[1]) : null;
  const height = heightMatch ? Number(heightMatch[1]) : null;
  if (width !== null && width < 120) return false;
  if (height !== null && height < 120) return false;
  return true;
}

function extractFirstImage(html, base) {
  const ogPatterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i
  ];
  for (const re of ogPatterns) {
    const m = html.match(re);
    const u = m && absoluteImageUrl(m[1], base);
    if (u && imageLooksUseful(u)) return { image: u, source: 'og:image' };
  }

  const sections = contentSections(html);
  const imgRe = /<img\b[^>]*>/gi;
  for (const section of sections) {
    let m;
    imgRe.lastIndex = 0;
    while ((m = imgRe.exec(section))) {
      const tag = m[0];
      if (!imageTagLooksUseful(tag)) continue;
      const attrs = {};
      const attrRe = /([:\w-]+)\s*=\s*["']([^"']*)["']/gi;
      let a;
      while ((a = attrRe.exec(tag))) attrs[a[1].toLowerCase()] = a[2];
      const candidates = [attrs.src, attrs['data-src'], firstSrcsetUrl(attrs.srcset), firstSrcsetUrl(attrs['data-srcset'])];
      for (const candidate of candidates) {
        const u = absoluteImageUrl(candidate, base);
        if (u && imageLooksUseful(u)) return { image: u, source: 'img' };
      }
    }
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      return json({ ok: true, service: 'coldcase-cms', branch: BRANCH }, 200, origin);
    }

    if (url.pathname === '/admin' && request.method === 'GET') {
      const page = await fetch('https://raw.githubusercontent.com/caspervangorkom/map/cms-v2/admin.html', { cache: 'no-store' });
      if (!page.ok) return new Response('Adminpagina kon niet worden geladen.', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      return new Response(await page.text(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/cases.json' && request.method === 'GET') {
      const data = await fetch('https://raw.githubusercontent.com/caspervangorkom/map/cms-v2/cases.json', { cache: 'no-store' });
      if (!data.ok) return new Response('cases.json kon niet worden geladen.', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      return new Response(await data.text(), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/geocode' && request.method === 'GET') {
      if (!ctx?.access) return json({ error: 'Cloudflare Access vereist.' }, 403, origin);
      const query = (url.searchParams.get('q') || '').trim();
      if (!query || query.length > MAX_GEOCODE_QUERY) return json({ error: 'Vul een plaats of adres in (maximaal 200 tekens).' }, 400, origin);
      const nominatimUrl = new URL('https://nominatim.openstreetmap.org/search');
      nominatimUrl.searchParams.set('q', query);
      nominatimUrl.searchParams.set('format', 'jsonv2');
      nominatimUrl.searchParams.set('limit', '1');
      nominatimUrl.searchParams.set('accept-language', 'nl');
      try {
        const result = await fetch(nominatimUrl.toString(), { headers: { 'Accept': 'application/json', 'User-Agent': 'Coldcasezaken-CMS/1.0 (+https://www.coldcasezaken.nl/cold-case-kaart)' } });
        if (!result.ok) return json({ error: `Locatie zoeken mislukt (HTTP ${result.status}).` }, 502, origin);
        const matches = await result.json();
        if (!Array.isArray(matches) || !matches.length) return json({ error: 'Geen locatie gevonden. Probeer een plaatsnaam of een iets duidelijker adres.' }, 404, origin);
        const match = matches[0], lat = Number(match.lat), lng = Number(match.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: 'De gevonden locatie bevat geen geldige coördinaten.' }, 502, origin);
        return json({ ok: true, lat, lng, display_name: typeof match.display_name === 'string' ? match.display_name : query }, 200, origin);
      } catch { return json({ error: 'Locatie zoeken kon niet worden uitgevoerd.' }, 502, origin); }
    }

    if (url.pathname === '/image' && request.method === 'GET') {
      if (!ctx?.access) return json({ error: 'Cloudflare Access vereist.' }, 403, origin);
      const dossier = (url.searchParams.get('url') || '').trim();
      if (!dossier || dossier.length > MAX_IMAGE_URL || !isAllowedDossierUrl(dossier)) return json({ error: 'Alleen HTTPS-dossierpagina’s van coldcasezaken.nl zijn toegestaan.' }, 400, origin);
      try {
        const page = await fetch(dossier, { headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': 'Coldcasezaken-CMS/1.0 (+https://www.coldcasezaken.nl/cold-case-kaart)' } });
        if (!page.ok) return json({ error: `Dossier kon niet worden geladen (HTTP ${page.status}).` }, 502, origin);
        const length = Number(page.headers.get('Content-Length') || 0);
        if (length > MAX_DOSSIER_BYTES) return json({ error: 'Dossierpagina is te groot om automatisch te verwerken.' }, 413, origin);
        const html = await page.text();
        if (new TextEncoder().encode(html).length > MAX_DOSSIER_BYTES) return json({ error: 'Dossierpagina is te groot om automatisch te verwerken.' }, 413, origin);
        const found = extractFirstImage(html, dossier);
        if (!found) return json({ error: 'Geen geschikte foto gevonden op deze dossierpagina.' }, 404, origin);
        return json({ ok: true, image: found.image, source: found.source }, 200, origin);
      } catch { return json({ error: 'De dossierpagina kon niet worden verwerkt.' }, 502, origin); }
    }

    if (url.pathname !== '/save' || request.method !== 'POST') return json({ error: 'Niet gevonden.' }, 404, origin);
    if (!ctx?.access) return json({ error: 'Cloudflare Access vereist.' }, 403, origin);
    if (!env.GITHUB_TOKEN) return json({ error: 'CMS is niet volledig geconfigureerd.' }, 500, origin);
    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > MAX_BODY_BYTES) return json({ error: 'Aanvraag is te groot.' }, 413, origin);
    let payload;
    try { payload = await request.json(); } catch { return json({ error: 'Ongeldige JSON.' }, 400, origin); }
    const cases = payload?.cases;
    if (!Array.isArray(cases) || cases.length > MAX_CASES) return json({ error: 'Ongeldige lijst met zaken.' }, 400, origin);
    const invalid = cases.findIndex(c => !validCase(c));
    if (invalid !== -1) return json({ error: `Zaak ${invalid + 1} bevat ongeldige gegevens.` }, 400, origin);
    const get = await github(request, env, `${PATH}?ref=${encodeURIComponent(BRANCH)}`);
    if (!get.ok) return json({ error: `GitHub lezen mislukt (HTTP ${get.status}).` }, 502, origin);
    const file = await get.json();
    const content = JSON.stringify(cases, null, 2) + '\n';
    const encoded = btoa(unescape(encodeURIComponent(content)));
    const put = await github(request, env, PATH, { method: 'PUT', body: JSON.stringify({ message: 'CMS: cases.json bijwerken', content: encoded, sha: file.sha, branch: BRANCH }) });
    if (!put.ok) {
      let message = `GitHub schrijven mislukt (HTTP ${put.status}).`;
      try { const detail = await put.json(); if (detail?.message) message += ` ${detail.message}`; } catch {}
      return json({ error: message }, put.status === 409 ? 409 : 502, origin);
    }
    const result = await put.json();
    return json({ ok: true, branch: BRANCH, commit: result?.commit?.sha || null, count: cases.length }, 200, origin);
  }
};
