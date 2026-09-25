interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Comtrade MCP — UN Comtrade API for international bilateral trade data
 *
 * Tools:
 * - comtrade_trade_data: get bilateral trade data between countries
 * - comtrade_top_partners: top trading partners for a country
 * - comtrade_top_commodities: top traded commodities between two countries
 * - comtrade_country_codes: common country codes reference
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Comtrade');
}


const BASE_URL = 'https://comtradeapi.un.org/public/v1/preview';

const tools: McpToolExport['tools'] = [
  {
    name: 'comtrade_trade_data',
    description:
      'AUTHORITATIVE bilateral trade data between two countries from UN Comtrade — the official international-trade statistics database (every country\'s customs filings, harmonized). Returns trade values USD, quantities, and HS commodity-level detail for imports and exports between reporter + partner. Use for "how much X did US import from China in 2024", "what does Germany export to Brazil", "Mexico\'s top trade partners by commodity", or "how did Saudi–Egypt trade move this year" (pass frequency="monthly" for month-by-month, not just last year\'s annual total). UN Comtrade reporter/partner codes (842=US — Comtrade uses 842, NOT the ISO 840; 156=China, 276=Germany, 0=World — see comtrade_country_codes). Defaults to ANNUAL data (lags ~3 months from reporting period); pass frequency="monthly" for month-level data (lags more and some reporters never file monthly — a missing month is simply absent from the result, never shown as a zero). Every response states its own "frequency" so a monthly figure is never mistaken for an annual one.',
    summary: 'Trade values and quantities between two countries, from UN Comtrade customs statistics.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reporter_code: {
          type: 'string',
          description: 'Country name (e.g. "USA", "China", "Germany") or UN numeric code (US=842, China=156). Names are resolved automatically.',
        },
        partner_code: {
          type: 'string',
          description: 'Partner country name (e.g. "China") or UN code (156=China, 0=World). Optional — defaults to World (0). Names resolved automatically.',
        },
        year: {
          type: 'string',
          description: 'Trade period. For frequency="annual" (default): a year, e.g. "2024". For frequency="monthly": year+month as YYYYMM, e.g. "202401" for January 2024.',
        },
        hs_code: {
          type: 'string',
          description: 'HS commodity code at 2/4/6 digit level (e.g., "8471" for computers, "2603" for copper ores). Optional — omit for all commodities. Aliases accepted: commodity_code, commodity, hs, cmd_code (pass exactly one of hs_code/commodity_code/commodity/hs/cmd_code — do not need hs_code as well).',
        },
        commodity_code: {
          type: 'string',
          description: 'Alias for hs_code — HS commodity code (e.g. "2603" for copper ores). Use this OR hs_code, not both.',
        },
        commodity: {
          type: 'string',
          description: 'Alias for hs_code — HS commodity code. Use this OR hs_code, not both.',
        },
        hs: {
          type: 'string',
          description: 'Alias for hs_code — HS commodity code. Use this OR hs_code, not both.',
        },
        cmd_code: {
          type: 'string',
          description: 'Alias for hs_code — HS commodity code. Use this OR hs_code, not both.',
        },
        flow: {
          type: 'string',
          description: 'Trade flow: "M" for imports, "X" for exports. Optional — defaults to both "M,X".',
        },
        frequency: {
          type: 'string',
          description: 'Data frequency: "annual" (default) for yearly totals, or "monthly" for month-level data. Monthly coverage is thinner than annual — not every reporter files monthly, and recent months lag by reporter; a country-month with no filing is simply omitted from the results, not returned as zero. When "monthly", pass `year` as YYYYMM.',
        },
      },
      required: ['reporter_code', 'partner_code', 'year'],
    },
  },
  {
    name: 'comtrade_top_partners',
    description:
      'Find a country\'s top trading partners ranked by trade volume. Returns partner countries and total trade values. Defaults to ANNUAL; pass frequency="monthly" for a single month\'s ranking instead of the last full year\'s.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reporter_code: {
          type: 'string',
          description: 'Country name (e.g. "USA", "China") or UN numeric code (842=US). Names resolved automatically.',
        },
        year: {
          type: 'string',
          description: 'Trade period. For frequency="annual" (default): a year, e.g. "2024". For frequency="monthly": year+month as YYYYMM, e.g. "202401".',
        },
        flow: {
          type: 'string',
          description: 'Trade flow: "M" for imports, "X" for exports',
        },
        hs_code: {
          type: 'string',
          description: 'Optional HS commodity code to filter by specific product (e.g. "2603" for copper ores) — omit for all commodities (TOTAL). Aliases accepted: commodity_code, commodity, hs, cmd_code (pass exactly one).',
        },
        commodity_code: {
          type: 'string',
          description: 'Alias for hs_code — HS commodity code (e.g. "2603" for copper ores). Use this OR hs_code, not both.',
        },
        commodity: {
          type: 'string',
          description: 'Alias for hs_code — HS commodity code. Use this OR hs_code, not both.',
        },
        hs: {
          type: 'string',
          description: 'Alias for hs_code — HS commodity code. Use this OR hs_code, not both.',
        },
        cmd_code: {
          type: 'string',
          description: 'Alias for hs_code — HS commodity code. Use this OR hs_code, not both.',
        },
        limit: {
          type: 'number',
          description: 'Number of top partners to return (default 20)',
        },
        frequency: {
          type: 'string',
          description: 'Data frequency: "annual" (default) or "monthly". Monthly coverage is thinner — not every reporter files monthly, and recent months lag; a reporter with no filing for the requested month is absent from the ranking, not shown at zero. When "monthly", pass `year` as YYYYMM.',
        },
      },
      required: ['reporter_code', 'year', 'flow'],
    },
  },
  {
    name: 'comtrade_top_commodities',
    description:
      'Rank the products two countries actually trade, largest value first — "what does the US import most from China". Returns HS categories with trade value and net weight. Defaults to HS 2-digit chapters (~97 categories, e.g. 85 Electrical machinery); pass hs_level 4 or 6 for finer product detail.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reporter_code: {
          type: 'string',
          description: 'Country name (e.g. "USA", "China") or UN numeric code (842=US). Names resolved automatically.',
        },
        partner_code: {
          type: 'string',
          description: 'Partner country name or UN code (0=World). Optional — defaults to World. Names resolved automatically.',
        },
        year: {
          type: 'string',
          description: 'Trade period. For frequency="annual" (default): a year, e.g. "2024". For frequency="monthly": year+month as YYYYMM, e.g. "202401".',
        },
        flow: {
          type: 'string',
          description: 'Trade flow, REQUIRED because it decides what the answer MEANS: "X" for exports (what a country SELLS / ships abroad) or "M" for imports (what it BUYS / receives). Deliberately not defaulted — guessing returns imports for an export question, which reads as a confident wrong answer instead of an error.',
        },
        limit: {
          type: 'number',
          description: 'Number of top commodities to return (default 20)',
        },
        hs_level: {
          type: 'number',
          description: 'HS aggregation level: 2 for chapters (default, ~97 broad categories), 4 for headings, 6 for subheadings. Higher numbers give finer product detail and many more rows.',
        },
        frequency: {
          type: 'string',
          description: 'Data frequency: "annual" (default) or "monthly". Monthly coverage is thinner — not every reporter files monthly, and recent months lag. When "monthly", pass `year` as YYYYMM.',
        },
      },
      // partner_code is documented "Optional — defaults to World" and the handler
      // already coerces null/empty to '0', but it was listed REQUIRED, so the
      // validator rejected the call before that default could run — the router
      // asking for "Vietnam's top exports" (no partner) failed twice this week.
      // Same shape as the census_exports hs_code fix.
      required: ['reporter_code', 'year', 'flow'],
    },
  },
  {
    name: 'comtrade_country_codes',
    description:
      'Look up UN Comtrade reporter/partner codes for trade queries (e.g., "842" = US, "156" = China). Note Comtrade uses 842 for the US, not the ISO 840. Returns code and country name pairs.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

interface ComtradeRecord {
  reporterCode: number;
  reporterDesc: string;
  partnerCode: number;
  partnerDesc: string;
  flowCode: string;
  flowDesc: string;
  cmdCode: string;
  cmdDesc: string;
  primaryValue: number;
  netWgt: number;
  qty: number;
  qtyUnitAbbr: string | null;
  qtyUnitCode: number;
  period: number;
  // Present on both annual and monthly records. isReported=false + isAggregate=true
  // means the figure is a UN mirror-estimate rather than the reporter's own filed
  // submission (confirmed live on both /C/A/HS and /C/M/HS) — worth surfacing so a
  // caller doesn't treat every number as equally authoritative.
  isReported?: boolean;
  isAggregate?: boolean;
}

interface ComtradeResponse {
  data: ComtradeRecord[];
  count: number;
  error?: string;
  elapsedTime?: string;
}

// Reverse lookup: numeric code → country name (preview API returns null for desc fields)
/** Exported so compound packs can turn a Comtrade M49 code back into the
 *  English country name that sibling packs (treasury-fiscal, census-trade)
 *  require — rather than each keeping its own drifting copy. */
/** Comtrade's HS aggregation levels: chapters, headings, subheadings. */
const HS_LEVELS = new Set([2, 4, 6]);

// Comtrade returns cmdDesc empty on this endpoint, so an AG2 ranking came back
// as a column of bare numbers — "85, $127bn" tells a reader nothing, and the
// whole point of ranking commodities is knowing WHICH commodities. These are the
// WCO Harmonized System chapter titles, an international standard revised every
// five years, so unlike a vendor list this does not rot between releases. Only
// the 2-digit level is mapped; headings and subheadings fall back to whatever
// the API sends.
const HS_CHAPTERS: Record<string, string> = {
  '01': 'Live animals', '02': 'Meat and edible meat offal',
  '03': 'Fish and crustaceans', '04': 'Dairy produce, eggs, honey',
  '05': 'Other products of animal origin', '06': 'Live trees and plants',
  '07': 'Edible vegetables', '08': 'Edible fruit and nuts',
  '09': 'Coffee, tea and spices', '10': 'Cereals',
  '11': 'Milling products, malt, starches', '12': 'Oil seeds and oleaginous fruits',
  '13': 'Lac, gums, resins and vegetable saps', '14': 'Vegetable plaiting materials',
  '15': 'Animal or vegetable fats and oils', '16': 'Preparations of meat or fish',
  '17': 'Sugars and sugar confectionery', '18': 'Cocoa and cocoa preparations',
  '19': 'Cereal, flour and milk preparations', '20': 'Preparations of vegetables and fruit',
  '21': 'Miscellaneous edible preparations', '22': 'Beverages, spirits and vinegar',
  '23': 'Food industry residues and animal fodder', '24': 'Tobacco and tobacco substitutes',
  '25': 'Salt, sulphur, stone, plaster, cement', '26': 'Ores, slag and ash',
  '27': 'Mineral fuels, oils and waxes', '28': 'Inorganic chemicals',
  '29': 'Organic chemicals', '30': 'Pharmaceutical products',
  '31': 'Fertilisers', '32': 'Tanning and dyeing extracts, paints',
  '33': 'Essential oils, perfumery and cosmetics', '34': 'Soap, waxes, polishes and candles',
  '35': 'Albuminoidal substances, glues, enzymes', '36': 'Explosives, pyrotechnics, matches',
  '37': 'Photographic and cinematographic goods', '38': 'Miscellaneous chemical products',
  '39': 'Plastics and articles thereof', '40': 'Rubber and articles thereof',
  '41': 'Raw hides, skins and leather', '42': 'Leather articles, handbags, saddlery',
  '43': 'Furskins and artificial fur', '44': 'Wood and articles of wood',
  '45': 'Cork and articles of cork', '46': 'Straw, esparto and basketware',
  '47': 'Wood pulp and recovered paper', '48': 'Paper and paperboard',
  '49': 'Printed books, newspapers and pictures', '50': 'Silk',
  '51': 'Wool and animal hair', '52': 'Cotton',
  '53': 'Other vegetable textile fibres', '54': 'Man-made filaments',
  '55': 'Man-made staple fibres', '56': 'Wadding, felt, nonwovens and cordage',
  '57': 'Carpets and textile floor coverings', '58': 'Special woven fabrics and embroidery',
  '59': 'Impregnated or coated textile fabrics', '60': 'Knitted or crocheted fabrics',
  '61': 'Apparel, knitted or crocheted', '62': 'Apparel, not knitted or crocheted',
  '63': 'Other made-up textile articles', '64': 'Footwear',
  '65': 'Headgear', '66': 'Umbrellas and walking sticks',
  '67': 'Prepared feathers and artificial flowers', '68': 'Articles of stone, plaster and cement',
  '69': 'Ceramic products', '70': 'Glass and glassware',
  '71': 'Pearls, precious stones and metals', '72': 'Iron and steel',
  '73': 'Articles of iron or steel', '74': 'Copper and articles thereof',
  '75': 'Nickel and articles thereof', '76': 'Aluminium and articles thereof',
  '78': 'Lead and articles thereof', '79': 'Zinc and articles thereof',
  '80': 'Tin and articles thereof', '81': 'Other base metals and cermets',
  '82': 'Tools, implements and cutlery', '83': 'Miscellaneous articles of base metal',
  '84': 'Machinery and mechanical appliances', '85': 'Electrical machinery and equipment',
  '86': 'Railway locomotives and track fixtures', '87': 'Vehicles other than railway',
  '88': 'Aircraft and spacecraft', '89': 'Ships and boats',
  '90': 'Optical, photographic and medical instruments', '91': 'Clocks and watches',
  '92': 'Musical instruments', '93': 'Arms and ammunition',
  '94': 'Furniture, bedding and lamps', '95': 'Toys, games and sports equipment',
  '96': 'Miscellaneous manufactured articles', '97': 'Works of art and antiques',
  '99': 'Commodities not elsewhere specified',
};

function describeCommodity(code: unknown, apiDesc: unknown): string {
  const raw = String(code ?? '').trim();
  const fromApi = typeof apiDesc === 'string' ? apiDesc.trim() : '';
  // The API's own description wins when it sends one — it is authoritative and
  // covers every aggregation level.
  if (fromApi && fromApi.toUpperCase() !== raw.toUpperCase()) return fromApi;
  return HS_CHAPTERS[raw.padStart(2, '0')] ?? raw;
}

export const CODE_TO_COUNTRY: Record<number, string> = {
  0: "World", 4: "Afghanistan", 8: "Albania", 10: "Antarctica", 12: "Algeria", 16: "American Samoa",
  20: "Andorra", 24: "Angola", 28: "Antigua and Barbuda", 31: "Azerbaijan", 32: "Argentina", 36: "Australia",
  40: "Austria", 44: "Bahamas", 48: "Bahrain", 50: "Bangladesh", 51: "Armenia", 52: "Barbados",
  56: "Belgium", 58: "Belgium-Luxembourg (...1998)", 60: "Bermuda", 64: "Bhutan",
  68: "Bolivia (Plurinational State of)", 70: "Bosnia Herzegovina", 72: "Botswana", 74: "Bouvet Island",
  76: "Brazil", 80: "Br. Antarctic Terr.", 84: "Belize", 86: "Br. Indian Ocean Terr.", 90: "Solomon Isds",
  92: "Br. Virgin Isds", 96: "Brunei Darussalam", 100: "Bulgaria", 104: "Myanmar", 108: "Burundi",
  112: "Belarus", 116: "Cambodia", 120: "Cameroon", 124: "Canada", 129: "Caribbean, nes", 132: "Cabo Verde",
  136: "Cayman Isds", 140: "Central African Rep.", 144: "Sri Lanka", 148: "Chad", 152: "Chile", 156: "China",
  158: "Taiwan, Province of China", 162: "Christmas Isds", 166: "Cocos Isds", 170: "Colombia",
  174: "Comoros", 175: "Mayotte (Overseas France)", 178: "Congo", 180: "Dem. Rep. of the Congo",
  184: "Cook Isds", 188: "Costa Rica", 191: "Croatia", 192: "Cuba", 196: "Cyprus",
  200: "Czechoslovakia (...1992)", 203: "Czechia", 204: "Benin", 208: "Denmark", 212: "Dominica",
  214: "Dominican Rep.", 218: "Ecuador", 221: "Eastern Europe, nes", 222: "El Salvador",
  226: "Equatorial Guinea", 230: "Ethiopia (...1992)", 231: "Ethiopia", 232: "Eritrea", 233: "Estonia",
  234: "Faroe Isds", 238: "Falkland Isds (Malvinas)", 239: "South Georgia and the South Sandwich Islands",
  242: "Fiji", 246: "Finland", 248: "Åland Islands", 250: "Metropolitan France", 251: "France",
  254: "French Guiana (Overseas France)", 258: "French Polynesia", 260: "Fr. South Antarctic Terr.",
  262: "Djibouti", 266: "Gabon", 268: "Georgia", 270: "Gambia", 275: "State of Palestine", 276: "Germany",
  278: "Dem. Rep. of Germany (...1990)", 280: "Fed. Rep. of Germany (...1990)", 288: "Ghana",
  290: "Northern Africa, nes", 292: "Gibraltar", 296: "Kiribati", 300: "Greece", 304: "Greenland",
  308: "Grenada", 312: "Guadeloupe (Overseas France)", 316: "Guam", 320: "Guatemala", 324: "Guinea",
  328: "Guyana", 332: "Haiti", 334: "Heard Island and McDonald Islands",
  336: "Holy See (Vatican City State)", 340: "Honduras", 344: "China, Hong Kong SAR", 348: "Hungary",
  352: "Iceland", 356: "India (...1974)", 360: "Indonesia", 364: "Iran", 368: "Iraq", 372: "Ireland",
  376: "Israel", 380: "Italy", 384: "Côte d'Ivoire", 388: "Jamaica", 392: "Japan", 398: "Kazakhstan",
  400: "Jordan", 404: "Kenya", 408: "Dem. People's Rep. of Korea", 410: "Rep. of Korea", 412: "Kosovo",
  414: "Kuwait", 417: "Kyrgyzstan", 418: "Lao People's Dem. Rep.", 422: "Lebanon", 426: "Lesotho",
  428: "Latvia", 430: "Liberia", 434: "Libya", 438: "Liechtenstein", 440: "Lithuania", 442: "Luxembourg",
  446: "China, Macao SAR", 450: "Madagascar", 454: "Malawi", 457: "Sarawak", 458: "Malaysia",
  459: "Peninsula Malaysia (...1963)", 461: "Sabah (...1963)", 462: "Maldives", 466: "Mali", 470: "Malta",
  471: "CACM, nes", 472: "Africa CAMEU region, nes", 473: "LAIA, nes", 474: "Martinique (Overseas France)",
  478: "Mauritania", 480: "Mauritius", 484: "Mexico", 488: "Midway Islands", 490: "Other Asia, nes",
  492: "Europe EU, nes", 496: "Mongolia", 498: "Rep. of Moldova", 499: "Montenegro", 500: "Montserrat",
  504: "Morocco", 508: "Mozambique", 512: "Oman", 516: "Namibia", 520: "Nauru", 524: "Nepal",
  527: "Oceania, nes", 528: "Netherlands", 530: "Netherlands Antilles (...2010)", 531: "Curaçao",
  532: "Netherlands Antilles and Aruba (...1985)", 533: "Aruba", 534: "Saint Maarten", 535: "Bonaire",
  536: "Neutral Zone", 540: "New Caledonia", 548: "Vanuatu", 554: "New Zealand", 558: "Nicaragua",
  562: "Niger", 566: "Nigeria", 568: "Other Europe, nes", 570: "Niue", 574: "Norfolk Isds",
  577: "Other Africa, nes", 578: "Norway, excluding Svalbard and Jan Mayen", 579: "Norway",
  580: "N. Mariana Isds", 581: "United States Minor Outlying Islands", 582: "Pacific Isds (...1991)",
  583: "FS Micronesia", 584: "Marshall Isds", 585: "Palau", 586: "Pakistan",
  588: "East and West Pakistan (...1971)", 590: "Panama, excl.Canal Zone (...1977)", 591: "Panama",
  592: "Panama-Canal-Zone (...1977)", 598: "Papua New Guinea", 600: "Paraguay", 604: "Peru",
  608: "Philippines", 612: "Pitcairn", 616: "Poland", 620: "Portugal", 624: "Guinea-Bissau",
  626: "Timor-Leste", 630: "Puerto Rico", 634: "Qatar", 636: "Rest of America, nes",
  637: "North America and Central America, nes", 638: "Réunion (Overseas France)", 642: "Romania",
  643: "Russian Federation", 646: "Rwanda", 647: "Ryukyu Isd", 652: "Saint Barthélemy", 654: "Saint Helena",
  658: "Saint Kitts, Nevis and Anguilla (...1980)", 659: "Saint Kitts and Nevis", 660: "Anguilla",
  662: "Saint Lucia", 663: "Saint Martin (French part)", 666: "Saint Pierre and Miquelon",
  670: "Saint Vincent and the Grenadines", 674: "San Marino", 678: "Sao Tome and Principe",
  682: "Saudi Arabia", 686: "Senegal", 688: "Serbia", 690: "Seychelles", 694: "Sierra Leone",
  697: "Europe EFTA, nes", 698: "Sikkim, Protectorate of India (...1974)", 699: "India", 702: "Singapore",
  703: "Slovakia", 704: "Viet Nam", 705: "Slovenia", 706: "Somalia", 710: "South Africa",
  711: "Southern African Customs Union (...1999)", 716: "Zimbabwe", 717: "Rhodesia Nyas (...1964)",
  720: "Dem. Yemen (...1990)", 724: "Spain", 728: "South Sudan", 729: "Sudan", 732: "Western Sahara",
  736: "Sudan (...2011)", 740: "Suriname", 744: "Svalbard and Jan Mayen Islands", 748: "Eswatini",
  752: "Sweden", 756: "Switzerland", 757: "Switzerland", 760: "Syria", 762: "Tajikistan", 764: "Thailand",
  768: "Togo", 772: "Tokelau", 776: "Tonga", 780: "Trinidad and Tobago", 784: "United Arab Emirates",
  788: "Tunisia", 792: "Türkiye", 795: "Turkmenistan", 796: "Turks and Caicos Isds", 798: "Tuvalu",
  800: "Uganda", 804: "Ukraine", 807: "North Macedonia", 810: "USSR (...1990)", 818: "Egypt",
  826: "United Kingdom", 830: "Channel Islands", 831: "Guernsey", 832: "Jersey", 833: "Isle of Man",
  834: "United Rep. of Tanzania", 835: "Tanganyika (...1964)", 836: "Zanzibar and Pemba Isd (...1964)",
  837: "Bunkers", 838: "Free Zones", 839: "Special Categories", 840: "United States of America",
  841: "USA and Puerto Rico (...1980)", 842: "USA", 849: "US Misc. Pacific Isds",
  850: "US Virgin Isds (...1980)", 854: "Burkina Faso", 858: "Uruguay", 860: "Uzbekistan", 862: "Venezuela",
  866: "Dem. Rep. of Vietnam (...1974)", 868: "Rep. of Vietnam (...1974)", 872: "Wake Island",
  876: "Wallis and Futuna Isds", 879: "Western Asia, nes", 882: "Samoa", 886: "Arab Rep. of Yemen (...1990)",
  887: "Yemen", 890: "Yugoslavia (...1991)", 891: "Serbia and Montenegro (...2005)", 894: "Zambia",
};
const ISO_TO_CODE: Record<string, string> = {
  "_ac": "472", "_ci": "830", "_ks": "412", "_mi": "488", "_pm": "459", "_ri": "647", "_rn": "717",
  "_sh": "461", "_sk": "457", "_sm": "698", "_tk": "835", "_wi": "872", "_zp": "836", "a49": "129",
  "a59": "637", "a79": "636", "abw": "533", "ad": "20", "ae": "784", "af": "4", "afg": "4", "ag": "28",
  "ago": "24", "ai": "660", "aia": "660", "al": "8", "ala": "248", "alb": "8", "am": "51", "an": "532",
  "and": "20", "ant": "532", "ao": "24", "aq": "10", "ar": "32", "are": "784", "arg": "32", "arm": "51",
  "as": "16", "asm": "16", "at": "40", "ata": "10", "atb": "80", "atf": "260", "atg": "28", "au": "36",
  "aus": "36", "aut": "40", "aw": "533", "ax": "248", "az": "31", "aze": "31", "ba": "70", "bb": "52",
  "bd": "50", "bdi": "108", "be": "58", "bel": "58", "ben": "204", "bes": "535", "bf": "854", "bfa": "854",
  "bg": "100", "bgd": "50", "bgr": "100", "bh": "48", "bhr": "48", "bhs": "44", "bi": "108", "bih": "70",
  "bj": "204", "bl": "652", "blm": "652", "blr": "112", "blz": "84", "bm": "60", "bmu": "60", "bn": "96",
  "bo": "68", "bol": "68", "bq": "80", "br": "76", "bra": "76", "brb": "52", "brn": "96", "bs": "44",
  "bt": "64", "btn": "64", "bv": "74", "bvt": "74", "bw": "72", "bwa": "72", "by": "112", "bz": "84",
  "ca": "124", "caf": "140", "can": "124", "cc": "166", "cck": "166", "cd": "180", "cf": "140", "cg": "178",
  "ch": "757", "che": "757", "chl": "152", "chn": "156", "ci": "384", "civ": "384", "ck": "184", "cl": "152",
  "cm": "120", "cmr": "120", "cn": "156", "co": "170", "cod": "180", "cog": "178", "cok": "184",
  "col": "170", "com": "174", "cpv": "132", "cr": "188", "cri": "188", "cs": "891", "csk": "200",
  "cu": "192", "cub": "192", "cuw": "531", "cv": "132", "cw": "531", "cx": "162", "cxr": "162", "cy": "196",
  "cym": "136", "cyp": "196", "cz": "203", "cze": "203", "dd": "278", "ddr": "278", "de": "276",
  "deu": "276", "dj": "262", "dji": "262", "dk": "208", "dm": "212", "dma": "212", "dnk": "208", "do": "214",
  "dom": "214", "dz": "12", "dza": "12", "e19": "568", "e29": "221", "ec": "218", "ecu": "218", "ee": "233",
  "eg": "818", "egy": "818", "eh": "732", "er": "232", "eri": "232", "es": "724", "esh": "732", "esp": "724",
  "est": "233", "et": "230", "eth": "230", "f19": "577", "f49": "290", "f97": "879", "fi": "246",
  "fin": "246", "fj": "242", "fji": "242", "fk": "238", "flk": "238", "fm": "583", "fo": "234", "fr": "250",
  "fra": "250", "fro": "234", "fsm": "583", "ga": "266", "gab": "266", "gb": "826", "gbr": "826",
  "gd": "308", "ge": "268", "geo": "268", "gf": "254", "gg": "831", "ggy": "831", "gh": "288", "gha": "288",
  "gi": "292", "gib": "292", "gin": "324", "gl": "304", "glp": "312", "gm": "270", "gmb": "270", "gn": "324",
  "gnb": "624", "gnq": "226", "gp": "312", "gq": "226", "gr": "300", "grc": "300", "grd": "308",
  "grl": "304", "gs": "239", "gt": "320", "gtm": "320", "gu": "316", "guf": "254", "gum": "316",
  "guy": "328", "gw": "624", "gy": "328", "hk": "344", "hkg": "344", "hm": "334", "hmd": "334", "hn": "340",
  "hnd": "340", "hr": "191", "hrv": "191", "ht": "332", "hti": "332", "hu": "348", "hun": "348", "id": "360",
  "idn": "360", "ie": "372", "il": "376", "im": "833", "imn": "833", "in": "356", "ind": "356", "io": "86",
  "iot": "86", "iq": "368", "ir": "364", "irl": "372", "irn": "364", "irq": "368", "is": "352", "isl": "352",
  "isr": "376", "it": "380", "ita": "380", "jam": "388", "je": "832", "jey": "832", "jm": "388", "jo": "400",
  "jor": "400", "jp": "392", "jpn": "392", "kaz": "398", "ke": "404", "ken": "404", "kg": "417",
  "kgz": "417", "kh": "116", "khm": "116", "ki": "296", "kir": "296", "km": "174", "kn": "658", "kna": "658",
  "kor": "410", "kp": "408", "kr": "410", "kw": "414", "kwt": "414", "ky": "136", "kz": "398", "la": "418",
  "lao": "418", "lb": "422", "lbn": "422", "lbr": "430", "lby": "434", "lc": "662", "lca": "662",
  "li": "438", "lie": "438", "lk": "144", "lka": "144", "lr": "430", "ls": "426", "lso": "426", "lt": "440",
  "ltu": "440", "lu": "442", "lux": "442", "lv": "428", "lva": "428", "ly": "434", "ma": "504", "mac": "446",
  "maf": "663", "mar": "504", "mc": "492", "mco": "492", "md": "498", "mda": "498", "mdg": "450",
  "mdv": "462", "me": "499", "mex": "484", "mf": "663", "mg": "450", "mh": "584", "mhl": "584", "mk": "807",
  "mkd": "807", "ml": "466", "mli": "466", "mlt": "470", "mm": "104", "mmr": "104", "mn": "496",
  "mne": "499", "mng": "496", "mnp": "580", "mo": "446", "moz": "508", "mp": "580", "mq": "474", "mr": "478",
  "mrt": "478", "ms": "500", "msr": "500", "mt": "470", "mtq": "474", "mu": "480", "mus": "480", "mv": "462",
  "mw": "454", "mwi": "454", "mx": "484", "my": "458", "mys": "458", "myt": "175", "mz": "508", "na": "516",
  "nam": "516", "nc": "540", "ncl": "540", "ne": "562", "ner": "562", "nf": "574", "nfk": "574", "ng": "566",
  "nga": "566", "ni": "558", "nic": "558", "niu": "570", "nl": "528", "nld": "528", "no": "578",
  "nor": "578", "np": "524", "npl": "524", "nr": "520", "nru": "520", "nt": "536", "ntz": "536", "nu": "570",
  "nz": "554", "nzl": "554", "o19": "527", "om": "512", "omn": "512", "pa": "590", "pak": "586",
  "pan": "590", "pc": "582", "pci": "582", "pcn": "612", "pcz": "592", "pe": "604", "per": "604",
  "pf": "258", "pg": "598", "ph": "608", "phl": "608", "pk": "586", "pl": "616", "plw": "585", "pm": "666",
  "pn": "612", "png": "598", "pol": "616", "pr": "630", "pri": "630", "prk": "408", "prt": "620",
  "pry": "600", "ps": "275", "pse": "275", "pt": "620", "pu": "849", "pus": "849", "pw": "585", "py": "600",
  "pyf": "258", "pz": "592", "qa": "634", "qat": "634", "r20": "697", "r91": "471", "re": "638",
  "reu": "638", "ro": "642", "rou": "642", "rs": "688", "ru": "643", "rus": "643", "rw": "646", "rwa": "646",
  "s19": "490", "sa": "682", "sau": "682", "sb": "90", "sc": "690", "scg": "891", "sd": "736", "sdn": "736",
  "se": "752", "sen": "686", "sg": "702", "sgp": "702", "sgs": "239", "sh": "654", "shn": "654", "si": "705",
  "sj": "744", "sjm": "744", "sk": "703", "sl": "694", "slb": "90", "sle": "694", "slv": "222", "sm": "674",
  "smr": "674", "sn": "686", "so": "706", "som": "706", "spm": "666", "sr": "740", "srb": "688", "ss": "728",
  "ssd": "728", "st": "678", "stp": "678", "su": "810", "sun": "810", "sur": "740", "sv": "222",
  "svk": "703", "svn": "705", "swe": "752", "swz": "748", "sx": "534", "sxm": "534", "sy": "760",
  "syc": "690", "syr": "760", "sz": "748", "tc": "796", "tca": "796", "tcd": "148", "td": "148", "tf": "260",
  "tg": "768", "tgo": "768", "th": "764", "tha": "764", "tj": "762", "tjk": "762", "tk": "772", "tkl": "772",
  "tkm": "795", "tl": "626", "tls": "626", "tm": "795", "tn": "788", "to": "776", "ton": "776", "tr": "792",
  "tt": "780", "tto": "780", "tun": "788", "tur": "792", "tuv": "798", "tv": "798", "tw": "158",
  "twn": "158", "tz": "834", "tza": "834", "ua": "804", "ug": "800", "uga": "800", "ukr": "804", "um": "581",
  "umi": "581", "ury": "858", "us": "841", "usa": "841", "uy": "858", "uz": "860", "uzb": "860", "va": "336",
  "vat": "336", "vc": "670", "vct": "670", "vd": "866", "vdr": "866", "ve": "862", "ven": "862", "vg": "92",
  "vgb": "92", "vi": "850", "vir": "850", "vn": "704", "vnm": "704", "vu": "548", "vut": "548", "wf": "876",
  "wlf": "876", "ws": "882", "wsm": "882", "x1": "837", "x2": "838", "xx": "839", "yd": "720", "ye": "887",
  "yem": "887", "ymd": "720", "yt": "175", "yu": "890", "yug": "890", "za": "710", "za1": "711",
  "zaf": "710", "zm": "894", "zmb": "894", "zw": "716", "zwe": "716",
};
const FLOW_NAMES: Record<string, string> = { M: 'Imports', X: 'Exports', 'RE-X': 'Re-exports', 'RE-M': 'Re-imports' };

// The preview endpoint sends qtyUnitAbbr as null on every record (user feedback
// #49 — quantity_unit was null in every response), but qtyUnitCode is always
// populated. This is the official mapping from
// comtradeapi.un.org/files/v1/app/reference/QuantityUnits.json (fetched
// 2026-09-07) — a UN standard like the HS chapters above, so it does not rot.
// Code -1 means "not available / no quantity" and is deliberately absent: a
// null unit is more honest than the string "N/A" next to a qty of 0.
const QTY_UNITS: Record<number, string> = {
  2: 'm²', 3: '1000 kWh', 4: 'm', 5: 'u', 6: '2u', 7: 'l', 8: 'kg',
  9: '1000u', 10: 'U (jeu/pack)', 11: '12u', 12: 'm³', 13: 'carat',
  14: 'km', 15: 'g', 16: 'hive', 17: '1000 m³', 18: 'TJ', 19: 'BBL',
  20: '1000 L', 21: '1000 KG', 22: 'kWH', 23: 'l alc 100%', 24: 'head',
  25: 'kg/net eda', 26: 'kg C5H14ClNO', 27: 'kg P2O5', 28: 'kg H2O2',
  29: 'kg met.am.', 30: 'kg N', 31: 'kg KOH', 32: 'kg K2O', 33: 'kg NaOH',
  34: 'kg 90% sdt', 35: 'kg U', 36: 'ct/l', 37: 'Bq', 38: 'gi F/S',
  39: 'GRT', 40: 'GT', 41: 'ce/el',
};

// Agents routinely pass a country NAME or ISO in reporter_code/partner_code
// despite the "numeric code" hint, and UN Comtrade then 400s. Resolve names/ISO
// to the UN M49 code (note: US = 842 in Comtrade, NOT the ISO 840). Numeric input
// passes through unchanged; an unresolvable name yields null so the caller can
// return a helpful error instead of a raw 400.
const NAME_TO_CODE: Record<string, string> = {};
for (const [code, name] of Object.entries(CODE_TO_COUNTRY)) {
  NAME_TO_CODE[name.toLowerCase().replace(/[^a-z]/g, '')] = code;
}
// Common-name/ISO overrides for reporters whose OFFICIAL Comtrade name (in
// CODE_TO_COUNTRY above, and therefore the auto-generated key above) is not
// the name a caller would actually type. Live-verified rejections: "Turkey",
// "Moldova", "Tanzania" and "Laos" all 400'd because Comtrade's own name
// strips to a different normalized key ("Türkiye" -> "trkiye" once accents
// are stripped, "Rep. of Moldova" -> "repofmoldova", etc.) — the class this
// fixes, not just those four (fleet fix-pack, paying-subscriber traffic).
Object.assign(NAME_TO_CODE, {
  us: '842', usa: '842', unitedstates: '842', unitedstatesofamerica: '842', america: '842',
  uk: '826', britain: '826', greatbritain: '826', unitedkingdom: '826', england: '826',
  korea: '410', southkorea: '410', rok: '410', northkorea: '408',
  uae: '784', unitedarabemirates: '784',
  russia: '643', russianfederation: '643',
  vietnam: '704', hongkong: '344', taiwan: '490', world: '0',
  // Türkiye — official Comtrade name strips its diacritic to a key ("trkiye")
  // nobody would type; cover both the plain and accent-typed spellings.
  turkey: '792', turkiye: '792',
  // Rep. of Moldova
  moldova: '498', republicofmoldova: '498',
  // United Rep. of Tanzania
  tanzania: '834',
  // Lao People's Dem. Rep.
  laos: '418', laopdr: '418', laopeoplesdemocraticrepublic: '418',
  // Czechia / Czech Republic — Czechia already matches directly; the older
  // common name does not.
  czechrepublic: '203',
  // Bolivia (Plurinational State of)
  bolivia: '68', plurinationalstateofbolivia: '68',
  // Côte d'Ivoire / Ivory Coast — apostrophe + accent stripping leaves the
  // official-name key mismatched against either common spelling.
  cotedivoire: '384', ivorycoast: '384',
  // DR Congo vs Congo (Brazzaville) — two different countries, two different
  // codes; "congo" alone already matches the Congo (178) official name.
  drcongo: '180', democraticrepublicofcongo: '180', congokinshasa: '180',
  republicofcongo: '178', congobrazzaville: '178',
  // North Macedonia / Macedonia (old name)
  macedonia: '807',
  // Eswatini / Swaziland (old name)
  swaziland: '748',
  // Cabo Verde / Cape Verde (old name)
  capeverde: '132',
  // Myanmar / Burma (old name)
  burma: '104',
});

function toCode(input: unknown): string | null {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const key = s.toLowerCase().replace(/[^a-z]/g, '');
  return NAME_TO_CODE[key] ?? ISO_TO_CODE[key] ?? null;
}
function unresolved(field: string, val: unknown) {
  return {
    error: 'unknown_country',
    message: `Could not resolve ${field} "${String(val)}". Pass a country name (e.g. "USA", "China", "Germany") or a UN numeric code (e.g. 842 = US, 156 = China), or call comtrade_country_codes.`,
  };
}

// Verified live 2026-09-25: comtrade_top_partners called with
// `commodity_code: "2603"` (instead of the schema's declared `hs_code`) came
// back as a class-success 200 with 20 partners labelled commodity "TOTAL" —
// the copper-ore question silently answered with all-goods trade instead
// (Chile/Peru's real copper-ore ranking only appeared once `hs_code` was
// used). The gateway does not strip an undeclared arg from what reaches the
// pack, it just flags it in `_meta.ignored_args` — so the bug was entirely
// ours: nothing here ever looked at `commodity_code`. Fixed two ways: these
// aliases are declared in every hs_code-taking tool's schema (stops the
// ignored_args flag) AND resolved here (stops the silent TOTAL fallback).
const HS_CODE_ALIASES = ['hs_code', 'commodity_code', 'commodity', 'hs', 'cmd_code'] as const;

function resolveHsCode(args: Record<string, unknown>): { hsCode?: string; error?: { error: string; message: string } } {
  for (const key of HS_CODE_ALIASES) {
    const v = args[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return { hsCode: String(v).trim() };
    }
  }
  // A commodity-shaped arg name that is NOT one of the declared aliases (e.g.
  // a typo'd "product_code" or "hsCode") would previously vanish into TOTAL
  // with no trace. Refuse instead of guessing — omitting hs_code entirely
  // (no commodity-shaped key at all) is the legitimate "all commodities" case
  // and is left alone.
  const nearMiss = Object.keys(args).find(
    (k) =>
      !(HS_CODE_ALIASES as readonly string[]).includes(k) &&
      /^(hs|cmd|commodity|product)/i.test(k) &&
      args[k] != null &&
      String(args[k]).trim() !== '',
  );
  if (nearMiss) {
    return {
      error: {
        error: 'unrecognized_commodity_argument',
        message: `"${nearMiss}" is not a recognized commodity argument. Use one of: ${HS_CODE_ALIASES.join(', ')}.`,
      },
    };
  }
  return {};
}

function resolveRecord(r: ComtradeRecord) {
  return {
    reporter: r.reporterDesc || CODE_TO_COUNTRY[r.reporterCode] || `Code ${r.reporterCode}`,
    partner: r.partnerDesc || CODE_TO_COUNTRY[r.partnerCode] || `Code ${r.partnerCode}`,
    flow: r.flowDesc || FLOW_NAMES[r.flowCode] || r.flowCode,
    commodity_code: r.cmdCode,
    commodity: r.cmdDesc || r.cmdCode,
    trade_value_usd: r.primaryValue,
    net_weight_kg: r.netWgt,
    quantity: r.qty,
    quantity_unit: r.qtyUnitAbbr || QTY_UNITS[r.qtyUnitCode] || null,
    // Pass through only when the API actually sent the flag — absent on some
    // legacy shapes, and `undefined` there is more honest than guessing false.
    ...(typeof r.isReported === 'boolean' ? { is_reported: r.isReported } : {}),
    ...(typeof r.isAggregate === 'boolean' ? { is_estimate: r.isAggregate } : {}),
  };
}

// freq: 'A' (annual, default — every existing call site is unaffected) or 'M' (monthly).
async function fetchComtrade(params: Record<string, string>, freq: 'A' | 'M' = 'A'): Promise<ComtradeResponse> {
  const url = new URL(`${BASE_URL}/C/${freq}/HS`);
  url.searchParams.set('customsCode', 'C00');
  url.searchParams.set('motCode', '0');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await pwFetch(url.toString());
  if (!res.ok) {
    throw await httpError(res, 'UN Comtrade API error');
  }

  const data = (await res.json()) as ComtradeResponse;
  if (data.error) {
    throw new Error(`UN Comtrade API error: ${data.error}`);
  }
  // Comtrade omits `data` (or returns null) for queries with no records — e.g. a
  // reporter/partner/period combo it doesn't cover. Downstream .filter/.map/.sort
  // then crash ("Cannot read properties of undefined"). Normalize to [] so those
  // handlers return an empty-but-valid result instead of throwing.
  if (!Array.isArray(data.data)) data.data = [];
  return data;
}

// Comtrade ANNUAL data lags ~1+ year, so a query for the current/most-recent year
// usually returns 0 records — and agents naturally ask about "now". When a recent
// year comes back empty, walk back to the latest year that has data and report
// which year was actually used. (An older empty year is a genuine no-data, left as-is.)
async function fetchComtradeYear(baseParams: Record<string, string>, year: string): Promise<{ response: ComtradeResponse; yearUsed: string; note?: string }> {
  let response = await fetchComtrade({ ...baseParams, period: year });
  if (response.data.length > 0 || !/^\d{4}$/.test(year)) return { response, yearUsed: year };
  // Comtrade annual lag varies by reporter — 1 year for prompt filers, 2+ for
  // slower ones (Vietnam had no 2024 data in mid-2026). Walk back up to 3 years
  // for any recent year; only a genuinely old (>3y) empty year is left as no-data.
  const cy = new Date().getUTCFullYear();
  if (Number(year) < cy - 3) return { response, yearUsed: year };
  for (const y of [Number(year) - 1, Number(year) - 2, Number(year) - 3]) {
    const r = await fetchComtrade({ ...baseParams, period: String(y) });
    if (r.data.length > 0) {
      return { response: r, yearUsed: String(y), note: `No UN Comtrade data for ${year} yet (annual data lags by reporter); showing ${y} instead.` };
    }
  }
  return { response, yearUsed: year };
}

// Monthly counterpart to fetchComtradeYear above. Same walk-back idea, but in
// months rather than years — monthly filings lag more unevenly than annual
// ones, and a caller asking for "this month" or "last month" is the common
// case that needs it. A genuinely old empty month (>24mo) is left as no-data
// rather than walked back, same reasoning as the >3y annual cutoff.
function shiftYyyymm(period: string, deltaMonths: number): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(4, 6)); // 1-12
  const total = y * 12 + (m - 1) + deltaMonths;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}${String(nm).padStart(2, '0')}`;
}

const MONTHLY_FALLBACK_STEPS = 6;

async function fetchComtradeMonth(baseParams: Record<string, string>, period: string): Promise<{ response: ComtradeResponse; periodUsed: string; note?: string }> {
  let response = await fetchComtrade({ ...baseParams, period }, 'M');
  if (response.data.length > 0 || !/^\d{6}$/.test(period)) return { response, periodUsed: period };

  const now = new Date();
  const curTotal = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const reqTotal = Number(period.slice(0, 4)) * 12 + (Number(period.slice(4, 6)) - 1);
  if (curTotal - reqTotal > 24) return { response, periodUsed: period }; // old + empty = genuine no-data

  for (let i = 1; i <= MONTHLY_FALLBACK_STEPS; i++) {
    const p = shiftYyyymm(period, -i);
    const r = await fetchComtrade({ ...baseParams, period: p }, 'M');
    if (r.data.length > 0) {
      return { response: r, periodUsed: p, note: `No UN Comtrade monthly data for ${period} yet (recent months lag by reporter, and not every reporter files monthly); showing ${p} instead.` };
    }
  }
  return { response, periodUsed: period };
}

// frequency='annual' keeps the exact pre-existing call path (fetchComtradeYear,
// `year` field name) untouched. frequency='monthly' is purely additive: a new
// `period` field (YYYYMM) plus an explicit `frequency` on every response so a
// caller never has to infer which grain a number is.
async function getTradeData(
  reporterCode: string,
  partnerCode: string,
  period: string,
  hsCode?: string,
  flow?: string,
  frequency: 'annual' | 'monthly' = 'annual',
) {
  const params: Record<string, string> = {
    reporterCode,
    partnerCode,
    flowCode: flow || 'M,X',
  };
  if (hsCode) {
    params.cmdCode = hsCode;
  }

  if (frequency === 'monthly') {
    const { response, periodUsed, note } = await fetchComtradeMonth(params, period);
    return {
      frequency: 'monthly' as const,
      period: periodUsed,
      count: response.count,
      ...(note ? { note } : {}),
      records: response.data.map(resolveRecord),
    };
  }

  const { response, yearUsed, note } = await fetchComtradeYear(params, period);

  return {
    frequency: 'annual' as const,
    count: response.count,
    year: yearUsed,
    ...(note ? { note } : {}),
    records: response.data.map(resolveRecord),
  };
}

async function getTopPartners(
  reporterCode: string,
  period: string,
  flow: string,
  hsCode?: string,
  limit: number = 20,
  frequency: 'annual' | 'monthly' = 'annual',
) {
  // Don't set partnerCode — omitting it returns all partners
  const params: Record<string, string> = {
    reporterCode,
    flowCode: flow,
    cmdCode: hsCode || 'TOTAL',
  };

  const { response, periodUsed, note } =
    frequency === 'monthly'
      ? await fetchComtradeMonth(params, period).then((r) => ({ response: r.response, periodUsed: r.periodUsed, note: r.note }))
      : await fetchComtradeYear(params, period).then((r) => ({ response: r.response, periodUsed: r.yearUsed, note: r.note }));

  const sorted = response.data
    .filter((r) => r.partnerCode !== 0 && r.primaryValue > 0)
    .sort((a, b) => b.primaryValue - a.primaryValue)
    .slice(0, limit);

  return {
    frequency,
    reporter: CODE_TO_COUNTRY[Number(reporterCode)] || `Code ${reporterCode}`,
    ...(frequency === 'monthly' ? { period: periodUsed } : { year: periodUsed }),
    ...(note ? { note } : {}),
    flow: flow === 'M' ? 'Imports' : 'Exports',
    total_partners: sorted.length,
    top_partners: sorted.map((r, i) => ({
      rank: i + 1,
      partner: r.partnerDesc || CODE_TO_COUNTRY[r.partnerCode] || `Code ${r.partnerCode}`,
      partner_code: r.partnerCode,
      trade_value_usd: r.primaryValue,
      commodity: r.cmdDesc || r.cmdCode,
    })),
  };
}

async function getTopCommodities(
  reporterCode: string,
  partnerCode: string,
  period: string,
  flow: string,
  limit: number = 20,
  hsLevel: number = 2,
  frequency: 'annual' | 'monthly' = 'annual',
) {
  // cmdCode was pinned to 'TOTAL', which asks Comtrade for the single all-goods
  // aggregate. So a tool whose whole purpose is ranking product categories could
  // only ever return one row, `limit` did nothing, and the answer read as
  // "rank 1: TOTAL, $462bn" — an aggregate presented as the leading commodity.
  // AG2/AG4/AG6 are Comtrade's HS aggregation levels; AG2 is the ~97 chapters,
  // which is the grain a "top commodities" question is actually asking about.
  const level = HS_LEVELS.has(hsLevel) ? hsLevel : 2;
  const params: Record<string, string> = {
    reporterCode,
    partnerCode,
    flowCode: flow,
    cmdCode: `AG${level}`,
  };

  const { response, periodUsed, note } =
    frequency === 'monthly'
      ? await fetchComtradeMonth(params, period).then((r) => ({ response: r.response, periodUsed: r.periodUsed, note: r.note }))
      : await fetchComtradeYear(params, period).then((r) => ({ response: r.response, periodUsed: r.yearUsed, note: r.note }));

  const sorted = response.data
    // The aggregate still arrives when a reporter files it, and leaving it in
    // would hand back a row worth more than every real commodity combined.
    .filter((r) => String(r.cmdCode).toUpperCase() !== 'TOTAL')
    .sort((a, b) => b.primaryValue - a.primaryValue);
  const top = sorted.slice(0, limit);

  return {
    frequency,
    reporter: CODE_TO_COUNTRY[Number(reporterCode)] || `Code ${reporterCode}`,
    partner: CODE_TO_COUNTRY[Number(partnerCode)] || `Code ${partnerCode}`,
    ...(frequency === 'monthly' ? { period: periodUsed } : { year: periodUsed }),
    ...(note ? { note } : {}),
    flow: flow === 'M' ? 'Imports' : 'Exports',
    hs_level: level,
    total_commodities: sorted.length,
    returned: top.length,
    // `top`, not `sorted` — mapping the full set here is how `limit` went on
    // being ignored after the cmdCode fix, just with 97 rows instead of 1.
    top_commodities: top.map((r, i) => ({
      rank: i + 1,
      hs_code: r.cmdCode,
      commodity: describeCommodity(r.cmdCode, r.cmdDesc),
      trade_value_usd: r.primaryValue,
      net_weight_kg: r.netWgt,
    })),
  };
}

function getCountryCodes() {
  const codes: Record<string, { code: number; name: string }> = {
    US: { code: 842, name: 'United States' },
    China: { code: 156, name: 'China' },
    Japan: { code: 392, name: 'Japan' },
    Germany: { code: 276, name: 'Germany' },
    UK: { code: 826, name: 'United Kingdom' },
    Mexico: { code: 484, name: 'Mexico' },
    Canada: { code: 124, name: 'Canada' },
    India: { code: 699, name: 'India' },
    Brazil: { code: 76, name: 'Brazil' },
    Vietnam: { code: 704, name: 'Vietnam' },
    'South Korea': { code: 410, name: 'South Korea' },
    Taiwan: { code: 490, name: 'Taiwan' },
    France: { code: 251, name: 'France' },
    Italy: { code: 381, name: 'Italy' },
    Netherlands: { code: 528, name: 'Netherlands' },
    Australia: { code: 36, name: 'Australia' },
    Singapore: { code: 702, name: 'Singapore' },
    Thailand: { code: 764, name: 'Thailand' },
    Indonesia: { code: 360, name: 'Indonesia' },
    Malaysia: { code: 458, name: 'Malaysia' },
    'Saudi Arabia': { code: 682, name: 'Saudi Arabia' },
    Switzerland: { code: 757, name: 'Switzerland' },
    Ireland: { code: 372, name: 'Ireland' },
    Spain: { code: 724, name: 'Spain' },
    World: { code: 0, name: 'World (aggregate)' },
  };

  return {
    note: 'Use these numeric codes in reporter_code and partner_code parameters. Use 0 for World aggregate.',
    countries: Object.entries(codes).map(([key, val]) => ({
      label: key,
      numeric_code: val.code,
      full_name: val.name,
    })),
  };
}

// Resolves the frequency arg (default 'annual') and normalizes `year` into the
// period Comtrade expects for that frequency: YYYY for annual (unchanged,
// existing behavior — no validation added there so old callers see no change),
// YYYYMM for monthly (strips separators like "2024-01" -> "202401"; rejects a
// bare year with a clear message rather than silently misinterpreting it).
function resolveFrequency(args: Record<string, unknown>): { frequency: 'annual' | 'monthly'; period: string } | { error: string; message: string } {
  const freqRaw = String(args.frequency ?? '').trim().toLowerCase();
  const frequency: 'annual' | 'monthly' = freqRaw === 'monthly' ? 'monthly' : 'annual';
  const yearRaw = String(args.year ?? '').trim();
  if (frequency === 'monthly') {
    const digits = yearRaw.replace(/\D/g, '');
    if (!/^\d{6}$/.test(digits)) {
      return {
        error: 'invalid_period',
        message: `frequency="monthly" requires \`year\` as YYYYMM (e.g. "202401" for January 2024); got "${yearRaw}".`,
      };
    }
    return { frequency, period: digits };
  }
  return { frequency, period: yearRaw };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'comtrade_trade_data': {
      const rc = toCode(args.reporter_code);
      if (!rc) return unresolved('reporter_code', args.reporter_code);
      // partner defaults to World (0) when omitted; resolve a name if given.
      const pc = args.partner_code == null || `${args.partner_code}` === '' ? '0' : toCode(args.partner_code);
      if (!pc) return unresolved('partner_code', args.partner_code);
      const freq = resolveFrequency(args);
      if ('error' in freq) return freq;
      const hs = resolveHsCode(args);
      if (hs.error) return hs.error;
      return getTradeData(rc, pc, freq.period, hs.hsCode, args.flow as string | undefined, freq.frequency);
    }
    case 'comtrade_top_partners': {
      const rc = toCode(args.reporter_code);
      if (!rc) return unresolved('reporter_code', args.reporter_code);
      const freq = resolveFrequency(args);
      if ('error' in freq) return freq;
      const hs = resolveHsCode(args);
      if (hs.error) return hs.error;
      return getTopPartners(rc, freq.period, (args.flow as string) || 'M', hs.hsCode, (args.limit as number) || 20, freq.frequency);
    }
    case 'comtrade_top_commodities': {
      const rc = toCode(args.reporter_code);
      if (!rc) return unresolved('reporter_code', args.reporter_code);
      const pc = args.partner_code == null || `${args.partner_code}` === '' ? '0' : toCode(args.partner_code);
      if (!pc) return unresolved('partner_code', args.partner_code);
      const freq = resolveFrequency(args);
      if ('error' in freq) return freq;
      return getTopCommodities(rc, pc, freq.period, (args.flow as string) || 'M', (args.limit as number) || 20, Number(args.hs_level) || 2, freq.frequency);
    }
    case 'comtrade_country_codes':
      return getCountryCodes();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;

// Exported for tests; the gateway consumes the default export only.
export { describeCommodity, toCode, resolveHsCode };
