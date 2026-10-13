/**
 * Shared by the OAuth tests: replaces global fetch with a responder so token
 * endpoints can be driven with their documented responses. There is no real
 * Google or Microsoft reachable from the test environment, so these prove the
 * state machine against documented error *shapes*, not against the providers.
 *
 * Not a *.test.ts file, so the runner doesn't treat it as a suite.
 */

export interface Call {
  url: string;
  body: URLSearchParams | null;
  method: string;
}

const realFetch = globalThis.fetch;

/** Put the real fetch back — call from afterEach. */
export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** Replaces fetch with a responder; returns the live list of calls it has seen. */
export function stubFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      body: init?.body instanceof URLSearchParams ? init.body : null,
      method: init?.method ?? "GET",
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
