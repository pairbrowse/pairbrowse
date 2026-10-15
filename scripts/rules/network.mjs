// Loopback, private and link-local addresses: your router, NAS, local dev servers.
export function isLocalNetwork(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) || /^0\./.test(host) || host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
}
