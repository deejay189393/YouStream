/**
 * The address the reader's browser or app used to reach YouStream.
 *
 * Behind Railway's proxy, TLS ends upstream and req.protocol reads "http".
 * The forwarded header says what the client actually used, so the manifest
 * advertises https:// URLs, which Stremio requires of a remote addon, and a
 * sign-in cookie is marked Secure.
 */
function getBaseUrl(req) {
  const forwardedProto = req.get("x-forwarded-proto");
  const proto = forwardedProto ? forwardedProto.split(",")[0].trim() : req.protocol;
  return `${proto}://${req.get("host")}`;
}

const isHttps = (req) => getBaseUrl(req).startsWith("https:");

module.exports = { getBaseUrl, isHttps };
