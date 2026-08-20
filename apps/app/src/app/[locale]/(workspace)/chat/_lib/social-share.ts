/** Platform share-intent URLs. Only the public link + a generic title travel —
 *  never message content. */
export function socialShareUrls(url: string, title: string) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  return {
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    x: `https://twitter.com/intent/tweet?url=${u}&text=${t}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${title} ${url}`)}`,
  };
}
