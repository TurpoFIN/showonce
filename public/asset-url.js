/** Resolve app-owned media against the actual mount point, including an existing
 * authenticated workshop path-prefix preview. External/relative URLs are not
 * rewritten. This does not change server binding, origins, or authentication.
 */
export function resolveAssetUrl(value, baseURL) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('/clips/') || value.startsWith('/api/media/')) {
    return new URL(value.slice(1), baseURL).href;
  }
  return value;
}
