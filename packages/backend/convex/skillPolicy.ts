import { ConvexError } from "convex/values";
import { scanForSecret } from "./memoryUtil";

/**
 * What a user-authored skill is allowed to contain.
 *
 * ONE definition of the rules, used by every write path, so a field can never be
 * validated in `create` and forgotten in `update`.
 *
 * The reason this file is stricter than a normal text field: unlike a display
 * name, this text is destined for a MODEL PROMPT. That makes three things
 * matter that would otherwise be cosmetic — length (prompt budget is finite and
 * shared), control characters (invisible glyphs can shape a prompt in ways the
 * author cannot see in their own textarea), and secrets (a prompt is copied into
 * logs, provider requests and, on failure, error reports).
 *
 * What this file deliberately does NOT do is filter for hostile INTENT. A skill
 * saying "ignore all previous instructions" is stored verbatim, because refusing
 * it would imply the stored text has authority it must never have. Authority is
 * denied by WHERE the runtime places this text, not by guessing at its wording —
 * the same reasoning `<project_instructions>` already records.
 */

export const MAX_SKILL_NAME = 80;
export const MAX_SKILL_DESCRIPTION = 200;
export const MAX_SKILL_INSTRUCTIONS = 4000;
export const MAX_SKILL_CONSTRAINTS = 2000;

/**
 * Per-user ceiling, mirroring MAX_TASKS_PER_USER (50).
 *
 * Not an anti-abuse afterthought: discovery ranks a user's skills on every turn,
 * and the prompt budget they share is finite. An unbounded catalogue degrades
 * the feature for the person who created it long before it costs the platform
 * anything.
 */
export const MAX_SKILLS_PER_USER = 50;

/**
 * Trim by CODE POINT, never by UTF-16 unit.
 *
 * `String.prototype.slice` cuts code units, so a cut landing inside an emoji
 * stores a lone surrogate — invalid text that then travels into a model
 * request. Spreading iterates code points, so a character is kept whole or
 * dropped whole.
 */
function clampByCodePoint(s: string, max: number): string {
  const points = [...s];
  return points.length <= max ? s : points.slice(0, max).join("");
}

/**
 * Is this code point one we strip outright?
 *
 * C0/C1 controls and the bidi overrides, but NOT `\n` or `\t` — instructions are
 * genuinely multi-line prose and stripping newlines would mangle every skill
 * anyone writes. Written as a predicate rather than a regex because biome's
 * `noControlCharactersInRegex` rejects the character class, and a lint
 * suppression would hide the one rule most worth reading.
 */
function isStripped(cp: number): boolean {
  if (cp === 0x0a || cp === 0x09) return false; // newline, tab: legitimate
  if (cp <= 0x1f) return true; // C0 controls
  if (cp >= 0x7f && cp <= 0x9f) return true; // DEL + C1 controls
  if (cp >= 0x200b && cp <= 0x200f) return true; // zero-width + LTR/RTL marks
  if (cp >= 0x202a && cp <= 0x202e) return true; // bidi embedding/override
  if (cp >= 0x2066 && cp <= 0x2069) return true; // bidi isolates
  if (cp === 0xfeff) return true; // BOM / zero-width no-break space
  return false;
}

function sanitize(raw: string): string {
  let out = "";
  for (const ch of raw.normalize("NFC")) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isStripped(cp)) continue;
    out += ch;
  }
  // Collapse runs of blank lines; a skill body is prose, not layout.
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** One validated field. Throws ConvexError — the client renders `.data`. */
function field(
  raw: string,
  { label, max, required }: { label: string; max: number; required: boolean },
): string {
  const clean = sanitize(clampByCodePoint(raw, max));
  if (required && !clean) {
    throw new ConvexError(`${label} is required.`);
  }
  if (clean && scanForSecret(clean)) {
    // Refused rather than redacted: a redacted skill silently means something
    // different from what its author wrote, and they would never know.
    throw new ConvexError(
      `${label} looks like it contains a secret (a key, token or password). Skills are stored as plain text and sent to the model — please remove it.`,
    );
  }
  return clean;
}

export type SkillInput = {
  name: string;
  description: string;
  instructions: string;
  constraints?: string;
};

export type ValidatedSkill = {
  name: string;
  description: string;
  instructions: string;
  constraints: string;
};

/**
 * Validate and normalise a whole skill, or throw.
 *
 * `name` and `instructions` are required because a skill without either is not
 * a skill: discovery ranks on the name, and guidance is the entire payload.
 * `description` and `constraints` are optional — plenty of useful skills are one
 * clear instruction with nothing to add.
 */
export function validateSkill(input: SkillInput): ValidatedSkill {
  return {
    name: field(input.name, {
      label: "Name",
      max: MAX_SKILL_NAME,
      required: true,
    }),
    description: field(input.description, {
      label: "Description",
      max: MAX_SKILL_DESCRIPTION,
      required: false,
    }),
    instructions: field(input.instructions, {
      label: "Instructions",
      max: MAX_SKILL_INSTRUCTIONS,
      required: true,
    }),
    constraints: field(input.constraints ?? "", {
      label: "Constraints",
      max: MAX_SKILL_CONSTRAINTS,
      required: false,
    }),
  };
}
