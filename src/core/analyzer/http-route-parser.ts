/**
 * HTTP Route Parser
 *
 * Extracts two complementary sets of data:
 *   1. HTTP CALLS  — fetch/axios/ky/got calls in JS/TS frontend files
 *   2. ROUTE DEFS  — FastAPI / Flask / Django route declarations in Python files
 *
 * These are then matched by `buildHttpEdges()` to create cross-language edges
 * between the frontend files that call an endpoint and the Python handlers that
 * serve it — filling the gap that static import analysis cannot reach.
 *
 * Matching strategy
 * -----------------
 * Routes are normalised to a canonical form before comparison:
 *   - Path parameters are replaced with a placeholder: /items/{id} → /items/:param
 *   - Leading slashes are normalised
 *   - Query strings are stripped from call-site URLs
 *   - Common API prefixes (/api, /api/v1, /v1, …) are tried both with and
 *     without the prefix so that a frontend call to /api/v1/search still matches
 *     a FastAPI router mounted at /search.
 *
 * Confidence levels
 * -----------------
 *   exact   — method + full path match
 *   path    — path matches, method unknown on one side (e.g. bare fetch)
 *   fuzzy   — normalised path matches after prefix stripping
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

/** An HTTP call found in a JS/TS source file */
export interface HttpCall {
  /** Absolute path of the file containing the call */
  file: string;
  /** HTTP method, upper-cased. 'UNKNOWN' when it cannot be determined. */
  method: string;
  /** URL as written in source — may be a template literal or variable ref */
  url: string;
  /** Normalised, static portion of the URL (params stripped, prefix removed) */
  normalizedUrl: string;
  /** 1-based source line */
  line: number;
  /** axios / fetch / ky / got / custom */
  client: string;
}

/** A route handler found in a Python source file */
export interface RouteDefinition {
  /** Absolute path of the file containing the handler */
  file: string;
  /** HTTP method, upper-cased */
  method: string;
  /** Path pattern as declared (may contain {param} or <param> placeholders) */
  path: string;
  /** Normalised path for matching */
  normalizedPath: string;
  /** Name of the handler function */
  handlerName: string;
  /** fastapi / flask / django / starlette / express / nestjs / nextjs-app etc. */
  framework: string;
  /** 1-based source line */
  line: number;
  /** Request body type extracted from handler signature, e.g. "CreateUserDto" or "z.infer<typeof schema>" */
  requestBodyType?: string;
  /** Response body type extracted from handler return type annotation, e.g. "User[]" or "void" */
  responseType?: string;
  /** How the contract was sourced */
  contractSource: 'annotation' | 'validator' | 'none';
}

/** A resolved cross-language edge */
export interface HttpEdge {
  /** Absolute path of the JS/TS caller file */
  callerFile: string;
  /** Absolute path of the Python handler file */
  handlerFile: string;
  method: string;
  /** Normalised path used for the match */
  path: string;
  call: HttpCall;
  route: RouteDefinition;
  /** How confident the match is */
  confidence: 'exact' | 'path' | 'fuzzy';
}

// ============================================================================
// NORMALISATION HELPERS
// ============================================================================

/** Common API prefixes that frontends add but backends may not declare */
const API_PREFIXES = [
  '/api/v1', '/api/v2', '/api/v3',
  '/api',
  '/v1', '/v2', '/v3',
];

/**
 * Reduce a URL/path to a comparable canonical form:
 *   - Strip protocol + host if present  (https://example.com/foo → /foo)
 *   - Strip query string and fragment
 *   - Replace path parameters with :param
 *     {id}, :id, <int:id>, <id>  →  :param
 *   - Collapse duplicate slashes
 *   - Remove trailing slash (except root)
 */
export function normalizeUrl(raw: string): string {
  // Remove template-literal variable parts: ${...}
  let url = raw.replace(/\$\{[^}]+\}/g, ':param');

  // Strip protocol + host
  url = url.replace(/^https?:\/\/[^/]+/, '');

  // Strip query string and fragment
  url = url.replace(/[?#].*$/, '');

  // Replace FastAPI / Flask style path params
  url = url.replace(/\{[^}]+\}/g, ':param');   // {item_id}
  url = url.replace(/<[^>]+>/g, ':param');      // <int:item_id>
  url = url.replace(/:[\w]+/g, ':param');       // :item_id  (Express style)

  // Collapse duplicate slashes, ensure leading slash
  url = ('/' + url).replace(/\/+/g, '/');

  // Remove trailing slash unless it IS the root
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);

  return url.toLowerCase();
}

/**
 * Return all candidate normalised paths to try for a frontend URL.
 * We try both the full path and the path with each known prefix stripped,
 * to handle cases where the backend router is mounted without the prefix.
 */
function candidatePaths(normalizedUrl: string): string[] {
  const candidates = new Set<string>([normalizedUrl]);
  for (const prefix of API_PREFIXES) {
    if (normalizedUrl.startsWith(prefix + '/') || normalizedUrl === prefix) {
      candidates.add(normalizedUrl.slice(prefix.length) || '/');
    }
  }
  return Array.from(candidates);
}

// ============================================================================
// HTTP CALL EXTRACTION  (JS / TS)
// ============================================================================



/**
 * Extract all HTTP calls from a JavaScript or TypeScript source file.
 */
export async function extractHttpCalls(filePath: string): Promise<HttpCall[]> {
  const ext = extname(filePath).toLowerCase();
  if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) return [];

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const calls: HttpCall[] = [];

  // Strip comments to avoid false matches.
  // The line-comment regex must NOT match `://` inside URLs — we only strip
  // `//` that is preceded by whitespace, punctuation, brackets, or the start
  // of the line (i.e. genuine JS/TS comments, not protocol separators).
  // The character class intentionally includes ) and ] so that patterns like
  // `fetch('/api/items') // comment` are correctly stripped.
  const clean = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s,;()[\]{}])\/\/.*$/gm, '$1');

  const lines = content.split('\n'); // keep original for line numbers

  // ── fetch ──────────────────────────────────────────────────────────────────
  // fetch('/api/search')
  // fetch(`/api/search/${id}`, { method: 'POST' })
  const fetchRegex = /\bfetch\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*(?:,\s*\{([^}]*)\})?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fetchRegex.exec(clean)) !== null) {
    const rawUrl = m[1].replace(/^[`'"]/,'').replace(/[`'"]$/,'');
    const optionsBlock = m[2] ?? '';
    const methodMatch = optionsBlock.match(/method\s*:\s*['"`](\w+)['"`]/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

    calls.push({
      file: filePath,
      method,
      url: rawUrl,
      normalizedUrl: normalizeUrl(rawUrl),
      line: getLine(lines, m.index),
      client: 'fetch',
    });
  }

  // ── axios (method shorthands + generic) ────────────────────────────────────
  // axios.get('/api/items')
  // axios.post('/api/items', data)
  // axios({ method: 'post', url: '/api/items' })
  // axios.request({ method: 'DELETE', url: '/api/items/1' })
  const axiosMethodRegex = /\baxios\.(get|post|put|patch|delete|head|options)\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")/g;
  while ((m = axiosMethodRegex.exec(clean)) !== null) {
    const method = m[1].toUpperCase();
    const rawUrl = m[2].replace(/^[`'"]/,'').replace(/[`'"]$/,'');
    calls.push({
      file: filePath,
      method,
      url: rawUrl,
      normalizedUrl: normalizeUrl(rawUrl),
      line: getLine(lines, m.index),
      client: 'axios',
    });
  }

  // axios({ url: '...', method: '...' })  or  axios.request({ ... })
  const axiosConfigRegex = /\baxios(?:\.request)?\s*\(\s*\{([^}]{0,400})\}/g;
  while ((m = axiosConfigRegex.exec(clean)) !== null) {
    const block = m[1];
    const urlMatch = block.match(/url\s*:\s*(`[^`]+`|'[^']+'|"[^"]+")/);
    if (!urlMatch) continue;
    const rawUrl = urlMatch[1].replace(/^[`'"]/,'').replace(/[`'"]$/,'');
    const methodMatch = block.match(/method\s*:\s*['"`](\w+)['"`]/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'UNKNOWN';
    calls.push({
      file: filePath,
      method,
      url: rawUrl,
      normalizedUrl: normalizeUrl(rawUrl),
      line: getLine(lines, m.index),
      client: 'axios',
    });
  }

  // ── ky ─────────────────────────────────────────────────────────────────────
  // ky.get('/api/items')  ky.post('/api/items', { json: data })
  const kyRegex = /\bky\.(get|post|put|patch|delete|head)\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")/g;
  while ((m = kyRegex.exec(clean)) !== null) {
    const rawUrl = m[2].replace(/^[`'"]/,'').replace(/[`'"]$/,'');
    calls.push({
      file: filePath,
      method: m[1].toUpperCase(),
      url: rawUrl,
      normalizedUrl: normalizeUrl(rawUrl),
      line: getLine(lines, m.index),
      client: 'ky',
    });
  }

  // ── got ────────────────────────────────────────────────────────────────────
  // got.get('/api/items')
  const gotRegex = /\bgot\.(get|post|put|patch|delete|head)\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")/g;
  while ((m = gotRegex.exec(clean)) !== null) {
    const rawUrl = m[2].replace(/^[`'"]/,'').replace(/[`'"]$/,'');
    calls.push({
      file: filePath,
      method: m[1].toUpperCase(),
      url: rawUrl,
      normalizedUrl: normalizeUrl(rawUrl),
      line: getLine(lines, m.index),
      client: 'got',
    });
  }

  // ── React Query / SWR convenience wrappers ─────────────────────────────────
  // useQuery(['key', id], () => fetch('/api/items'))   — already caught above
  // useMutation(() => axios.post('/api/items'))        — already caught above

  return calls;
}

// ============================================================================
// ROUTE DEFINITION EXTRACTION  (Python)
// ============================================================================

/**
 * Extract all route definitions from a Python source file.
 * Supports FastAPI, Starlette, Flask, and Django (urls.py path/re_path).
 */
export async function extractRouteDefinitions(filePath: string): Promise<RouteDefinition[]> {
  const ext = extname(filePath).toLowerCase();
  if (!['.py', '.pyw'].includes(ext)) return [];

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const routes: RouteDefinition[] = [];
  const lines = content.split('\n');

  // Remove comments for cleaner matching
  const clean = content.replace(/#.*$/gm, '');

  // ── FastAPI / Starlette decorators ─────────────────────────────────────────
  // @app.get("/items/{item_id}")
  // @router.post("/search", ...)
  // @app.api_route("/multi", methods=["GET","POST"])
  const fastapiDecoratorRegex =
    /@(?:app|router|api_router)\.(get|post|put|patch|delete|head|options|trace)\s*\(\s*(['"/][^'")\n]+['"])/gm;
  let m: RegExpExecArray | null;
  while ((m = fastapiDecoratorRegex.exec(clean)) !== null) {
    const method = m[1].toUpperCase();
    const path = m[2].replace(/^['"]/, '').replace(/['"]$/, '');
    const lineNum = getLine(lines, m.index);
    // The handler name is on the `def` line right after the decorator block
    const handlerName = extractNextDefName(lines, lineNum);
    routes.push({
      file: filePath,
      method,
      path,
      normalizedPath: normalizeUrl(path),
      handlerName,
      framework: 'fastapi',
      line: lineNum,
      contractSource: 'none' as const,
    });
  }

  // @app.api_route("/path", methods=["GET", "POST"])
  const apiRouteRegex =
    /@(?:app|router|api_router)\.api_route\s*\(\s*(['"/][^'")\n]+['"]),\s*methods\s*=\s*\[([^\]]+)\]/gm;
  while ((m = apiRouteRegex.exec(clean)) !== null) {
    const path = m[1].replace(/^['"]/, '').replace(/['"]$/, '');
    const lineNum = getLine(lines, m.index);
    const handlerName = extractNextDefName(lines, lineNum);
    // Parse the methods list
    const methodMatches = m[2].matchAll(/['"](\w+)['"]/g);
    for (const mm of methodMatches) {
      routes.push({
        file: filePath,
        method: mm[1].toUpperCase(),
        path,
        normalizedPath: normalizeUrl(path),
        handlerName,
        framework: 'fastapi',
        line: lineNum,
        contractSource: 'none' as const,
      });
    }
  }

  // ── Flask ──────────────────────────────────────────────────────────────────
  // @app.route("/items", methods=["GET", "POST"])
  // @bp.route("/items/<int:item_id>", methods=["DELETE"])
  const flaskRouteRegex =
    /@(?:\w+)\.route\s*\(\s*(['"/][^'")\n]+['"]),?\s*(?:methods\s*=\s*\[([^\]]*)\])?\s*\)/gm;
  while ((m = flaskRouteRegex.exec(clean)) !== null) {
    const path = m[1].replace(/^['"]/, '').replace(/['"]$/, '');
    const lineNum = getLine(lines, m.index);
    const handlerName = extractNextDefName(lines, lineNum);
    const rawMethods = m[2];
    if (rawMethods) {
      const methodMatches = rawMethods.matchAll(/['"](\w+)['"]/g);
      for (const mm of methodMatches) {
        routes.push({
          file: filePath,
          method: mm[1].toUpperCase(),
          path,
          normalizedPath: normalizeUrl(path),
          handlerName,
          framework: 'flask',
          line: lineNum,
          contractSource: 'none' as const,
        });
      }
    } else {
      // Flask default is GET when no methods specified
      routes.push({
        file: filePath,
        method: 'GET',
        path,
        normalizedPath: normalizeUrl(path),
        handlerName,
        framework: 'flask',
        line: lineNum,
        contractSource: 'none' as const,
      });
    }
  }

  // ── Django urls.py ─────────────────────────────────────────────────────────
  // path('api/items/', views.ItemListView.as_view(), name='item-list'),
  // re_path(r'^api/items/(?P<pk>[0-9]+)/$', views.ItemDetailView.as_view()),
  //
  // NOTE: Django views handle HTTP method dispatch internally (via class-based
  // views or decorators), so no method is declared in urls.py. All Django
  // routes are stored with method='UNKNOWN', which means any frontend call
  // matched against a Django route will receive confidence='path' at best —
  // never 'exact'. This may produce false-positive edges when multiple HTTP
  // methods share the same URL pattern. Filter by confidence if this matters.
  const djangoPathRegex =
    /\bpath\s*\(\s*r?(['"])(.*?)\1\s*,\s*([\w.]+)/gm;
  while ((m = djangoPathRegex.exec(clean)) !== null) {
    const path = '/' + m[2].replace(/\$$/, '').replace(/^\^/, '');
    const handlerName = m[3].split('.').pop() ?? m[3];
    const lineNum = getLine(lines, m.index);
    routes.push({
      file: filePath,
      method: 'UNKNOWN', // Django views handle method internally
      path,
      normalizedPath: normalizeUrl(path),
      handlerName,
      framework: 'django',
      line: lineNum,
      contractSource: 'none' as const,
    });
  }

  return routes;
}

// ============================================================================
// EDGE BUILDER
// ============================================================================

/**
 * Match HTTP calls from JS/TS files against route definitions from Python files
 * and return cross-language edges.
 *
 * Pass in pre-extracted calls and routes (so callers can cache them across
 * multiple graph builds without re-parsing).
 */
export function buildHttpEdges(
  calls: HttpCall[],
  routes: RouteDefinition[]
): HttpEdge[] {
  const edges: HttpEdge[] = [];

  // Index routes by normalised path for O(1) lookup
  const routesByPath = new Map<string, RouteDefinition[]>();
  for (const route of routes) {
    const existing = routesByPath.get(route.normalizedPath) ?? [];
    existing.push(route);
    routesByPath.set(route.normalizedPath, existing);
  }

  for (const call of calls) {
    // Build all candidate paths (handles /api/v1 prefix stripping)
    const candidates = candidatePaths(call.normalizedUrl);
    let matched = false;

    for (const candidate of candidates) {
      const matchingRoutes = routesByPath.get(candidate);
      if (!matchingRoutes) continue;

      for (const route of matchingRoutes) {
        // Determine confidence
        let confidence: HttpEdge['confidence'];
        const methodsKnown = call.method !== 'UNKNOWN' && route.method !== 'UNKNOWN';
        const methodsMatch = call.method === route.method;

        if (methodsKnown && methodsMatch && candidate === call.normalizedUrl) {
          confidence = 'exact';
        } else if (!methodsKnown || !methodsMatch) {
          confidence = candidate !== call.normalizedUrl ? 'fuzzy' : 'path';
        } else {
          confidence = candidate !== call.normalizedUrl ? 'fuzzy' : 'exact';
        }

        edges.push({
          callerFile: call.file,
          handlerFile: route.file,
          method: methodsKnown ? call.method : route.method,
          path: candidate,
          call,
          route,
          confidence,
        });
        matched = true;
      }
    }

    // If no match found via exact/prefix logic, try fuzzy segment comparison
    if (!matched) {
      const callSegments = call.normalizedUrl.replace(/:param/g, '*').split('/');
      for (const [routePath, routeList] of routesByPath) {
        const routeSegments = routePath.replace(/:param/g, '*').split('/');
        if (callSegments.length !== routeSegments.length) continue;
        const allMatch = callSegments.every(
          (seg, i) => seg === routeSegments[i] || seg === '*' || routeSegments[i] === '*'
        );
        if (!allMatch) continue;
        for (const route of routeList) {
          edges.push({
            callerFile: call.file,
            handlerFile: route.file,
            method: call.method !== 'UNKNOWN' ? call.method : route.method,
            path: routePath,
            call,
            route,
            confidence: 'fuzzy',
          });
        }
      }
    }
  }

  // Deduplicate: same caller file + handler file + method + path
  const seen = new Set<string>();
  return edges.filter(e => {
    const key = `${e.callerFile}|${e.handlerFile}|${e.method}|${e.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// BATCH HELPERS
// ============================================================================

/**
 * Parse all files in a mixed JS+Python codebase and return HTTP edges.
 * Intended to be called once per graph build and its result merged into
 * the DependencyGraphResult edges.
 */
export async function extractAllHttpEdges(filePaths: string[]): Promise<{
  calls: HttpCall[];
  routes: RouteDefinition[];
  edges: HttpEdge[];
}> {
  const allCalls: HttpCall[] = [];
  const allRoutes: RouteDefinition[] = [];

  await Promise.all(
    filePaths.map(async fp => {
      const ext = extname(fp).toLowerCase();
      if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
        const calls = await extractHttpCalls(fp);
        allCalls.push(...calls);
      } else if (['.py', '.pyw'].includes(ext)) {
        const routes = await extractRouteDefinitions(fp);
        allRoutes.push(...routes);
      }
    })
  );

  const edges = buildHttpEdges(allCalls, allRoutes);
  return { calls: allCalls, routes: allRoutes, edges };
}

// ============================================================================
// PRIVATE UTILITIES
// ============================================================================

/** Convert a character offset in `content` to a 1-based line number */
function getLine(lines: string[], charOffset: number): number {
  let accumulated = 0;
  for (let i = 0; i < lines.length; i++) {
    accumulated += lines[i].length + 1; // +1 for newline
    if (accumulated > charOffset) return i + 1;
  }
  return lines.length;
}

/**
 * Given the line of a decorator, scan forward to find the next `def` name.
 * Handles multi-line decorators with up to 10 lines of lookahead.
 *
 * `decoratorLine` is 1-based (from getLine()), so we convert to a 0-based
 * index before indexing into the `lines` array.
 */
function extractNextDefName(lines: string[], decoratorLine: number): string {
  const start = decoratorLine - 1; // convert 1-based → 0-based
  const maxLook = Math.min(lines.length, start + 10);
  for (let i = start; i < maxLook; i++) {
    const defMatch = lines[i]?.match(/^\s*(?:async\s+)?def\s+(\w+)/);
    if (defMatch) return defMatch[1];
  }
  return 'unknown';
}

// ============================================================================
// CONTRACT / TYPE EXTRACTION HELPERS
// ============================================================================

/**
 * Extract contract information from a handler function body or surrounding context.
 *
 * Strategies:
 *   1. TypeScript Request<P, ResBody, ReqBody, Q> generic → requestBodyType = ReqBody
 *   2. NestJS @Body() dto: Type → requestBodyType = Type
 *   3. Zod .parse( / .parseAsync( → contractSource = 'validator'
 *   4. Promise<ResponseType> return annotation
 */
function extractContractFromHandler(
  handlerSource: string
): { requestBodyType?: string; responseType?: string; contractSource: 'annotation' | 'validator' | 'none' } {
  let requestBodyType: string | undefined;
  let responseType: string | undefined;
  let contractSource: 'annotation' | 'validator' | 'none' = 'none';

  // 1. TypeScript Request<P, ResBody, ReqBody, Q> generic
  //    handler(req: Request<Params, ResBody, Body, Query>)
  const reqGenericRe = /:\s*Request\s*<[^,>]+,\s*([^,>]+),\s*([^,>]+)/;
  const reqGenericMatch = reqGenericRe.exec(handlerSource);
  if (reqGenericMatch) {
    const resBodyType = reqGenericMatch[1].trim();
    const reqBodyType = reqGenericMatch[2].trim();
    if (reqBodyType && reqBodyType !== 'unknown' && reqBodyType !== 'any') {
      requestBodyType = reqBodyType;
      contractSource = 'annotation';
    }
    if (resBodyType && resBodyType !== 'unknown' && resBodyType !== 'any') {
      responseType = resBodyType;
    }
  }

  // 2. NestJS @Body() dto: CreateUserDto
  const bodyParamRe = /@Body\s*\(\s*\)\s+\w+\s*:\s*(\w+)/;
  const bodyParamMatch = bodyParamRe.exec(handlerSource);
  if (bodyParamMatch) {
    requestBodyType = bodyParamMatch[1];
    contractSource = 'annotation';
  }

  // 3. Zod validators: schema.parse( / schema.parseAsync( / z.infer<typeof
  const zodRe = /\b\w+\.parse(?:Async)?\s*\(|z\.infer\s*<\s*typeof\s+(\w+)/;
  const zodMatch = zodRe.exec(handlerSource);
  if (zodMatch) {
    contractSource = 'validator';
    if (zodMatch[1]) {
      requestBodyType = `z.infer<typeof ${zodMatch[1]}>`;
    } else {
      // Extract schema variable name from .parse( call
      const parseVarRe = /(\w+)\.parse(?:Async)?\s*\(/;
      const parseVarMatch = parseVarRe.exec(handlerSource);
      if (parseVarMatch) {
        requestBodyType = parseVarMatch[1];
      }
    }
  }

  // 4. Promise<ResponseType> return type annotation
  const returnTypeRe = /\):\s*Promise\s*<\s*([^>]+)>/;
  const returnTypeMatch = returnTypeRe.exec(handlerSource);
  if (returnTypeMatch && !responseType) {
    const rType = returnTypeMatch[1].trim();
    if (rType && rType !== 'void' && rType !== 'unknown' && rType !== 'any') {
      responseType = rType;
    }
  }

  return { requestBodyType, responseType, contractSource };
}

// ============================================================================
// TS/JS SERVER ROUTE EXTRACTION
// ============================================================================

// Express / Hono / Fastify / Koa / Elysia style:
//   app.get('/path', handler)
//   router.post('/path', ...)
//   app.use('/prefix', router)     ← prefix accumulation
const EXPRESS_ROUTE_RE = /(?:^|[\s;(,])(?:app|router|server|api|r)\.(get|post|put|delete|patch|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/gm;
const EXPRESS_USE_RE = /(?:^|[\s;(,])(?:app|router|server|api|r)\.use\s*\(\s*['"`]([^'"`]+)['"`]/gm;

// NestJS decorator-based:
//   @Controller('prefix')  →  class methods with @Get / @Post etc.
const NESTJS_CONTROLLER_RE = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/g;
const NESTJS_METHOD_RE = /@(Get|Post|Put|Delete|Patch|Head|Options|All)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
const NESTJS_HANDLER_RE = /(?:async\s+)?(\w+)\s*\(/;

// Next.js App Router: export (async) function GET(...) in app/**/route.ts
const NEXTJS_APP_ROUTER_RE = /^export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(/gm;

/** Detected framework from a file's content */
function detectTsFramework(source: string, filePath: string): string {
  if (/@Controller\s*\(/.test(source) && /@(Get|Post|Put|Delete|Patch)\s*\(/.test(source)) return 'nestjs';
  if (/app\/.*\/route\.[jt]sx?$/.test(filePath.replace(/\\/g, '/'))) return 'nextjs-app';
  if (/pages\/api\//.test(filePath.replace(/\\/g, '/'))) return 'nextjs-pages';
  if (/from\s+['"]hono['"]/.test(source) || /new\s+Hono\s*[(<]/.test(source)) return 'hono';
  if (/from\s+['"]fastify['"]/.test(source) || /fastify\s*\(/.test(source)) return 'fastify';
  if (/from\s+['"]express['"]/.test(source) || /require\s*\(\s*['"]express['"]\s*\)/.test(source)) return 'express';
  if (/from\s+['"]koa['"]/.test(source)) return 'koa';
  if (/from\s+['"]elysia['"]/.test(source)) return 'elysia';
  if (EXPRESS_ROUTE_RE.test(source)) return 'express';
  return 'unknown';
}

/**
 * Extract HTTP route definitions from a TypeScript/JavaScript server file.
 * Handles Express-style, NestJS decorators, and Next.js App Router.
 */
export async function extractTsRouteDefinitions(filePath: string): Promise<RouteDefinition[]> {
  let source: string;
  try {
    const { readFile } = await import('node:fs/promises');
    source = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const framework = detectTsFramework(source, filePath);
  const routes: RouteDefinition[] = [];
  const lines = source.split('\n');

  function lineOf(index: number): number {
    return source.slice(0, index).split('\n').length;
  }

  // ── Next.js App Router ────────────────────────────────────────────────────
  if (framework === 'nextjs-app') {
    // Derive path from file location: app/users/route.ts → /users
    const rel = filePath.replace(/\\/g, '/');
    const appIdx = rel.lastIndexOf('/app/');
    let routePath = '/';
    if (appIdx >= 0) {
      routePath = rel.slice(appIdx + 4).replace(/\/route\.[jt]sx?$/, '') || '/';
      // Remove dynamic segments brackets for display: [id] → :id
      routePath = routePath.replace(/\[([^\]]+)\]/g, ':$1');
    }

    const re = new RegExp(NEXTJS_APP_ROUTER_RE.source, NEXTJS_APP_ROUTER_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      // Extract handler body for contract detection (scan next 500 chars)
      const handlerBody = source.slice(m.index, m.index + 500);
      const contract = extractContractFromHandler(handlerBody);
      routes.push({
        file: filePath,
        method: m[1].toUpperCase(),
        path: routePath,
        normalizedPath: normalizeUrl(routePath),
        handlerName: m[1],
        framework: 'nextjs-app',
        line: lineOf(m.index),
        ...contract,
      });
    }
    return routes;
  }

  // ── NestJS ────────────────────────────────────────────────────────────────
  if (framework === 'nestjs') {
    // Collect controller prefixes
    const ctrlRe = new RegExp(NESTJS_CONTROLLER_RE.source, NESTJS_CONTROLLER_RE.flags);
    let ctrlPrefix = '';
    const ctrlMatch = ctrlRe.exec(source);
    if (ctrlMatch) {
      ctrlPrefix = ctrlMatch[1] ? `/${ctrlMatch[1].replace(/^\//, '')}` : '';
    }

    const methodRe = new RegExp(NESTJS_METHOD_RE.source, NESTJS_METHOD_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = methodRe.exec(source)) !== null) {
      const httpMethod = m[1].toUpperCase();
      const subPath = m[2] ? `/${m[2].replace(/^\//, '')}` : '';
      const fullPath = `${ctrlPrefix}${subPath}` || '/';

      // Find handler function name on subsequent lines
      const afterDecorator = source.slice(m.index + m[0].length);
      const handlerMatch = NESTJS_HANDLER_RE.exec(afterDecorator.slice(0, 200));
      const handlerName = handlerMatch?.[1] ?? 'unknown';

      // Extract contract from decorator + handler context (scan next 400 chars)
      const handlerContext = source.slice(m.index, m.index + 400);
      const contract = extractContractFromHandler(handlerContext);

      routes.push({
        file: filePath,
        method: httpMethod,
        path: fullPath,
        normalizedPath: normalizeUrl(fullPath),
        handlerName,
        framework: 'nestjs',
        line: lineOf(m.index),
        ...contract,
      });
    }
    return routes;
  }

  // ── Express / Hono / Fastify / Koa / Elysia ───────────────────────────────
  // Collect prefix map from .use() calls (best-effort)
  const prefixes: string[] = [];
  const useRe = new RegExp(EXPRESS_USE_RE.source, EXPRESS_USE_RE.flags);
  let um: RegExpExecArray | null;
  while ((um = useRe.exec(source)) !== null) {
    prefixes.push(um[1]);
  }

  const routeRe = new RegExp(EXPRESS_ROUTE_RE.source, EXPRESS_ROUTE_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(source)) !== null) {
    const method = m[1].toUpperCase();
    let path = m[2];

    // Apply a prefix if the route is relative (no leading slash)
    if (!path.startsWith('/') && prefixes.length > 0) {
      path = `${prefixes[0]}/${path}`;
    }

    // Find the handler name from the same line
    const lineText = lines[lineOf(m.index) - 1] ?? '';
    const handlerMatch = lineText.match(/,\s*(?:async\s+)?(?:function\s+)?(\w+)\s*[,)]/);
    const handlerName = handlerMatch?.[1] ?? 'handler';

    // Extract contract from route context (scan next 600 chars)
    const routeContext = source.slice(m.index, m.index + 600);
    const contract = extractContractFromHandler(routeContext);

    routes.push({
      file: filePath,
      method,
      path,
      normalizedPath: normalizeUrl(path),
      handlerName,
      framework,
      line: lineOf(m.index),
      ...contract,
    });
  }

  return routes;
}

// ============================================================================
// ROUTE INVENTORY
// ============================================================================

export interface RouteInventory {
  total: number;
  byMethod: Record<string, number>;
  byFramework: Record<string, number>;
  routes: Array<{
    method: string;
    path: string;
    framework: string;
    file: string;
    handler: string;
    requestBodyType?: string;
    responseType?: string;
    contractSource: 'annotation' | 'validator' | 'none';
  }>;
}

/**
 * Build a complete route inventory from all source files.
 * Combines Python routes (extractRouteDefinitions) and TS/JS routes
 * (extractTsRouteDefinitions) into a single summary.
 *
 * @param filePaths - Absolute paths to all source files in the project
 * @param rootDir   - Project root for computing relative paths
 */
export async function buildRouteInventory(
  filePaths: string[],
  rootDir: string
): Promise<RouteInventory> {
  const { relative } = await import('node:path');

  const allRoutes: RouteDefinition[] = [];

  await Promise.all(
    filePaths.map(async fp => {
      const ext = extname(fp).toLowerCase();
      if (['.py', '.pyw'].includes(ext)) {
        allRoutes.push(...await extractRouteDefinitions(fp));
      } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
        allRoutes.push(...await extractTsRouteDefinitions(fp));
      }
    })
  );

  const byMethod: Record<string, number> = {};
  const byFramework: Record<string, number> = {};

  for (const r of allRoutes) {
    byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
    byFramework[r.framework] = (byFramework[r.framework] ?? 0) + 1;
  }

  return {
    total: allRoutes.length,
    byMethod,
    byFramework,
    routes: allRoutes.map(r => ({
      method: r.method,
      path: r.path,
      framework: r.framework,
      file: relative(rootDir, r.file),
      handler: r.handlerName,
      requestBodyType: r.requestBodyType,
      responseType: r.responseType,
      contractSource: r.contractSource,
    })),
  };
}
