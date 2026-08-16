/**
 * Cloudflare Workers Preview URL trust boundary.
 *
 * Preview URLs are deliberately narrower than ordinary workers.dev URLs. The
 * version/alias and account subdomain are DNS labels, followed by the fixed
 * `workers.dev` suffix. Keeping this parser in the CLI package lets the CLI
 * and the local Preview smoke orchestration share exactly the same boundary.
 */
const PREVIEW_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const PREVIEW_HOST = new RegExp(
  `^${PREVIEW_LABEL}-netokay-control\\.${PREVIEW_LABEL}\\.workers\\.dev$`,
);

export const isCanonicalPreviewHostname = (hostname: string): boolean =>
  PREVIEW_HOST.test(hostname.toLowerCase());

export const parsePreviewUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== '/' ||
      url.port !== '' ||
      !isCanonicalPreviewHostname(url.hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};
