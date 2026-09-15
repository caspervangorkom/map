const OWNER = 'caspervangorkom';
const REPO = 'map';
const BRANCH = 'cms-v2';
const PATH = 'cases.json';
const MAX_BODY_BYTES = 2_000_000;
const MAX_CASES = 10_000;

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
      const page = await fetch(
        'https://raw.githubusercontent.com/caspervangorkom/map/cms-v2/admin.html',
        { cache: 'no-store' }
      );

      if (!page.ok) {
        return new Response('Adminpagina kon niet worden geladen.', {
          status: 502,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }

      return new Response(await page.text(), {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    }

    if (url.pathname === '/cases.json' && request.method === 'GET') {
      const data = await fetch(
        'https://raw.githubusercontent.com/caspervangorkom/map/cms-v2/cases.json',
        { cache: 'no-store' }
      );

      if (!data.ok) {
        return new Response('cases.json kon niet worden geladen.', {
          status: 502,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }

      return new Response(await data.text(), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    }

    if (url.pathname !== '/save' || request.method !== 'POST') {
      return json({ error: 'Niet gevonden.' }, 404, origin);
    }

    // Cloudflare Access is the CMS authentication layer. Do not accept saves
    // from an unauthenticated Worker invocation, even if the URL is known.
    if (!ctx?.access) {
      return json({ error: 'Cloudflare Access vereist.' }, 403, origin);
    }

    if (!env.GITHUB_TOKEN) {
      return json({ error: 'CMS is niet volledig geconfigureerd.' }, 500, origin);
    }

    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > MAX_BODY_BYTES) {
      return json({ error: 'Aanvraag is te groot.' }, 413, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'Ongeldige JSON.' }, 400, origin);
    }

    const cases = payload?.cases;
    if (!Array.isArray(cases) || cases.length > MAX_CASES) {
      return json({ error: 'Ongeldige lijst met zaken.' }, 400, origin);
    }

    const invalid = cases.findIndex(c => !validCase(c));
    if (invalid !== -1) {
      return json({ error: `Zaak ${invalid + 1} bevat ongeldige gegevens.` }, 400, origin);
    }

    // Read the current SHA immediately before writing. GitHub rejects the
    // update if somebody changed cases.json between our read and our write.
    const get = await github(request, env, `${PATH}?ref=${encodeURIComponent(BRANCH)}`);
    if (!get.ok) {
      return json({ error: `GitHub lezen mislukt (HTTP ${get.status}).` }, 502, origin);
    }

    const file = await get.json();
    const content = JSON.stringify(cases, null, 2) + '\n';
    const encoded = btoa(unescape(encodeURIComponent(content)));

    const put = await github(request, env, PATH, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'CMS: cases.json bijwerken',
        content: encoded,
        sha: file.sha,
        branch: BRANCH
      })
    });

    if (!put.ok) {
      let message = `GitHub schrijven mislukt (HTTP ${put.status}).`;
      try {
        const detail = await put.json();
        if (detail?.message) message += ` ${detail.message}`;
      } catch {}
      return json({ error: message }, put.status === 409 ? 409 : 502, origin);
    }

    const result = await put.json();
    return json({ ok: true, branch: BRANCH, commit: result?.commit?.sha || null, count: cases.length }, 200, origin);
  }
};
