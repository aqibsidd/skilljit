const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".pdf", ".zip", ".tar", ".gz", ".woff", ".woff2", ".ttf", ".otf",
  ".mp3", ".mp4", ".mov", ".wav", ".exe", ".dll", ".so", ".dylib",
]);

/** Best-effort check so bundled-file ingestion doesn't fetch/read binary
 * assets as text (and corrupt them) — skipped files just aren't offered
 * via skill_read_file, rather than being stored garbled. */
export function isProbablyBinaryPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}
