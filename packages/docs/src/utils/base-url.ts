export function normalizeBaseUrl(base: string): string {
  if (base === "") return "/";
  if (base === "/") return "/";
  return base.endsWith("/") ? base : `${base}/`;
}

export function withBaseUrl(base: string, path = ""): string {
  const normalizedBase = normalizeBaseUrl(base);
  const normalizedPath = path.replace(/^\/+/, "");
  return `${normalizedBase}${normalizedPath}`;
}
