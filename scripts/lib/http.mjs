// One bounded GET. No redirects are followed (a 3xx is returned to the caller),
// the body is read completely or rejected at the byte cap, and nothing retries.
import { assertRequestAllowed } from './urls.mjs';

export async function fetchBounded(url, { fetchImpl = globalThis.fetch, userAgent, timeoutMs, maxBytes }) {
  assertRequestAllowed(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': userAgent, Accept: 'text/csv, application/json;q=0.9, text/plain;q=0.5' },
        signal: controller.signal,
      });
    } catch (error) {
      return { kind: controller.signal.aborted ? 'timeout' : 'network', status: null, bytes: 0, detail: error?.name ?? 'Error' };
    }
    const status = response.status;
    const chunks = [];
    let bytes = 0;
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) {
            controller.abort();
            return { kind: 'byte-cap', status, bytes, detail: `response exceeded ${maxBytes} bytes` };
          }
          chunks.push(Buffer.from(chunk));
        }
      }
    } catch (error) {
      return { kind: controller.signal.aborted ? 'timeout' : 'network', status, bytes, detail: error?.name ?? 'Error' };
    }
    const body = Buffer.concat(chunks).toString('utf8');
    return { kind: 'response', status, bytes, body, location: response.headers?.get?.('location') ?? null };
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
