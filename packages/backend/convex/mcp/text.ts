/**
 * Bounding and cleaning THIRD-PARTY TEXT, in one place.
 *
 * MOVED HERE FROM `connections.ts` to break an import cycle: `audit.ts` needs
 * it and `connections.ts` needs `audit.ts`, so a shared leaf module is the only
 * shape that works. It is also where this belongs — three files now bound MCP
 * text, and one implementation of a rendering-and-logging safety control beats
 * three that can drift.
 */

/** Strip control characters and cap the length.
 *
 *  This text originates on a third party's server and is rendered in a browser
 *  AND written to logs, so a crafted string must not be able to forge log
 *  structure or carry a terminal escape. Filtered with a predicate rather than
 *  a regex because a character class of literal control codes is exactly what
 *  biome's `noControlCharactersInRegex` forbids — and it is right to: the
 *  intent reads far more clearly as a predicate than as an opaque range. */
export function clamp(
  value: string | undefined,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const clean = [...value].filter((c) => c >= " " && c !== "\u007F").join("");
  return clean.slice(0, max);
}
