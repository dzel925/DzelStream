const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
    process.loadEnvFile(ENV_FILE);
}
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const INDEX_FILE = path.join(__dirname, 'index.html');
const LOGO_FILE = path.join(__dirname, 'assets', 'dzelstream-logo.webp');
const rateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 300;
const ALLOWED_QUERY_PARAMS = new Set([
    'language',
    'append_to_response',
    'query',
    'include_adult',
    'page',
    'with_genres',
    'region',
    'with_origin_country'
]);

function sendJson(response, statusCode, body) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(body));
}

function allowTmdbBrowserOrigin(request, response) {
    const origin = request.headers.origin;
    if (!origin) return true;

    const remoteAddress = request.socket.remoteAddress || '';
    const isLoopback = remoteAddress === '::1' ||
        remoteAddress === '127.0.0.1' ||
        remoteAddress.startsWith('127.') ||
        remoteAddress.startsWith('::ffff:127.');
    let allowed = origin === 'null' && isLoopback;
    try {
        const parsedOrigin = new URL(origin);
        const requestHost = request.headers.host?.toLowerCase();
        const isSameOrigin = requestHost &&
            parsedOrigin.host.toLowerCase() === requestHost &&
            ['http:', 'https:'].includes(parsedOrigin.protocol);
        const isLocalOrigin = parsedOrigin.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname) &&
            isLoopback;
        allowed = allowed || isSameOrigin || isLocalOrigin;
    } catch {
        if (origin !== 'null') allowed = false;
    }
    if (!allowed) return false;

    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    response.setHeader('Vary', 'Origin');
    return true;
}

function isAllowedTmdbPath(apiPath) {
    return /^\/(?:trending\/(?:movie|tv)\/day|search\/multi|discover\/(?:movie|tv)|(?:movie|tv)\/(?:popular|top_rated)|movie\/\d+(?:\/(?:credits|videos|similar|watch\/providers))?|tv\/\d+(?:\/(?:credits|videos|similar|watch\/providers|season\/\d+))?)$/.test(apiPath);
}

function isRateLimited(request) {
    const now = Date.now();
    const clientAddress = request.socket.remoteAddress || 'unknown';
    const previous = rateLimits.get(clientAddress);
    if (!previous || now - previous.startedAt >= RATE_LIMIT_WINDOW_MS) {
        rateLimits.set(clientAddress, { startedAt: now, requests: 1 });
        return false;
    }
    previous.requests += 1;
    return previous.requests > RATE_LIMIT_MAX_REQUESTS;
}

setInterval(() => {
    const now = Date.now();
    for (const [address, entry] of rateLimits) {
        if (now - entry.startedAt >= RATE_LIMIT_WINDOW_MS) rateLimits.delete(address);
    }
}, RATE_LIMIT_WINDOW_MS).unref();

const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (requestUrl.pathname === '/api/health') {
        const configured = Boolean(TMDB_API_KEY);
        return sendJson(response, configured ? 200 : 503, { ok: configured, tmdbConfigured: configured });
    }

    if (requestUrl.pathname.startsWith('/api/tmdb/')) {
        if (!allowTmdbBrowserOrigin(request, response)) {
            return sendJson(response, 403, { error: 'This browser origin is not allowed to use the TMDB proxy.' });
        }
        if (request.method === 'OPTIONS') {
            response.writeHead(204);
            return response.end();
        }
        if (request.method !== 'GET') {
            return sendJson(response, 405, { error: 'Only GET requests are supported.' });
        }
        if (!TMDB_API_KEY) {
            return sendJson(response, 503, { error: 'TMDB_API_KEY is not configured on the server.' });
        }
        if (isRateLimited(request)) {
            return sendJson(response, 429, { error: 'Too many API requests. Please wait and try again.' });
        }

        const apiPath = requestUrl.pathname.slice('/api/tmdb'.length);
        if (!isAllowedTmdbPath(apiPath)) {
            return sendJson(response, 404, { error: 'This TMDB endpoint is not available through the proxy.' });
        }

        const upstreamParams = new URLSearchParams({ api_key: TMDB_API_KEY });
        for (const [name, value] of requestUrl.searchParams) {
            if (!ALLOWED_QUERY_PARAMS.has(name)) {
                return sendJson(response, 400, { error: `Query parameter "${name}" is not allowed.` });
            }
            if (value.length > 500 || upstreamParams.has(name)) {
                return sendJson(response, 400, { error: `Query parameter "${name}" is invalid.` });
            }
            upstreamParams.set(name, value);
        }

        try {
            const upstream = await fetch(`https://api.themoviedb.org/3${apiPath}?${upstreamParams.toString()}`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(12_000)
            });
            const body = await upstream.text();
            response.writeHead(upstream.status, {
                'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff'
            });
            return response.end(body);
        } catch (error) {
            console.error('TMDB upstream request failed:', error);
            return sendJson(response, 502, { error: 'TMDB is temporarily unavailable.' });
        }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        return response.end('Method Not Allowed');
    }

    if (requestUrl.pathname === '/assets/dzelstream-logo.webp') {
        fs.readFile(LOGO_FILE, (error, content) => {
            if (error) {
                console.error('Could not read DzelStream logo:', error);
                response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                return response.end('Could not load the logo.');
            }
            response.writeHead(200, {
                'Content-Type': 'image/webp',
                'Cache-Control': 'public, max-age=3600',
                'X-Content-Type-Options': 'nosniff'
            });
            if (request.method === 'HEAD') return response.end();
            response.end(content);
        });
        return;
    }

    if (requestUrl.pathname !== '/' && requestUrl.pathname !== '/index.html') {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return response.end('Not Found');
    }

    fs.readFile(INDEX_FILE, (error, content) => {
        if (error) {
            console.error('Could not read index.html:', error);
            response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            return response.end('Could not load the application.');
        }
        response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache'
        });
        if (request.method === 'HEAD') return response.end();
        response.end(content);
    });
});

server.listen(PORT, () => {
    console.log(`DzelStream server running at http://localhost:${PORT}`);
    if (!TMDB_API_KEY) {
        console.warn('TMDB_API_KEY is not set. Configure it on the server to enable catalog requests.');
    }
});
