/* Security headers for every response the Worker sends. public/_headers carries the same values for the static files
   Cloudflare serves without running the Worker (keep the two in step; test/run.mjs compares them).
   The web app is one script file with no inline scripts, so scripts run only from this site (plus Razorpay Checkout,
   which is optional). Inline style attributes are used throughout the screens, hence 'unsafe-inline' for styles only. */
const RZP = 'https://*.razorpay.com';
export const CSP_APP = [
  "default-src 'self'",
  `script-src 'self' ${RZP}`,
  `style-src 'self' 'unsafe-inline' ${RZP}`,
  `img-src 'self' data: blob: ${RZP}`,
  `font-src 'self' data: ${RZP}`,
  `connect-src 'self' ${RZP}`,
  `frame-src ${RZP}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
/* JSON, downloads and images are never pages: they may not load or run anything, nor be framed */
export const CSP_API = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com" "https://api.razorpay.com"), usb=(), serial=()',
};

/* Adds the headers to a response (copying it when its headers are read-only, as with static assets).
   api: JSON, downloads and images from /api/*; everything else is a page or a file of the web app. */
export function secure(res, api) {
  let out = res;
  try { out.headers.set('X-Content-Type-Options', 'nosniff'); } catch (e) { out = new Response(res.body, res); }
  for (const [k, v] of Object.entries(BASE_HEADERS)) out.headers.set(k, v);
  out.headers.set('Content-Security-Policy', api ? CSP_API : CSP_APP);
  return out;
}
