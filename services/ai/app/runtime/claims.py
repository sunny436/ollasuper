"""Claims the answer makes about things OllaSuper can verify — files and actions.

WHY THIS EXISTS. Testing (17-09-2026) found the assistant writing "📄 Download:
plan.pdf" as prose, with no file-generation call behind it, across Operations,
Coding and Content. Nothing in the pipeline compared what the answer CLAIMED
against what the turn actually PRODUCED, so a text label was indistinguishable
from a real deliverable. The same gap covers external actions: "sent to Slack"
when no Slack tool ran.

THE DESIGN RULE, shared with `ledger.py`: the answer STREAMS, so a check placed
after synthesis cannot retract a claim already on the user's screen. What it CAN
do is append a correction the model does not author, computed from recorded state
(ARTIFACT events on the writer, tool executions that actually succeeded), so a
model that would rather say "done" cannot override it.

WHAT IT DELIBERATELY DOES NOT DO. It does not flag the WORD "attached" — the user
attaches files, answers quote filenames, code blocks contain paths, and an
instruction ("save this as notes.csv") is not a claim. Only a FIRST-PERSON,
COMPLETED claim bound to a file or a named external system counts. A false
correction on an honest answer would be worse than the defect being fixed, so
every pattern here is anchored to both halves.
"""

from __future__ import annotations

import re

# Fenced code blocks are stripped before matching: a README sample containing
# "Download: report.pdf" is content, not a claim about this turn.
_FENCE = re.compile(r"```.*?```", re.S)
# Inline code, same reasoning (`report.pdf` in a sentence about filenames).
_INLINE_CODE = re.compile(r"`[^`\n]*`")

#: Extensions a claim can be ABOUT. A bare "the file" is not enough — the claim
#: has to name something the user would look for.
_EXT = (
    r"pdf|docx?|xlsx?|csv|pptx?|md|txt|json|zip|png|jpe?g|svg|html?|xml|yaml|yml"
)
#: "Download: x.pdf", "📄 Download plan.pdf", "[Download](…) report.xlsx".
_DOWNLOAD_LINE = re.compile(
    rf"\bdownload\b[^\n]{{0,40}}?\b[\w .\-]+\.({_EXT})\b", re.I
)
#: First-person completed delivery: "I've attached", "I have generated",
#: "I created", "here is your", "attached is" — bound to a filename below.
_DELIVERED = re.compile(
    r"\b("
    r"i(?:'ve| have)?\s+(?:attached|generated|created|produced|exported|compiled)"
    r"|attached\s+(?:is|you'll find|here)"
    r"|here(?:'s| is)\s+(?:your|the)\s+(?:attached|generated|completed)"
    r"|(?:has|have)\s+been\s+(?:attached|generated|created|exported)"
    r")\b",
    re.I,
)
#: No spaces: a space-tolerant pattern swallowed the words before the filename
#: ("'ve attached plan.pdf"), and every file this system generates is one token.
_FILENAME = re.compile(rf"\b[\w\-.]+\.({_EXT})\b", re.I)
#: A filename that is only being PROPOSED, not delivered.
_PROPOSED = re.compile(
    r"\b(save|store|write|name|call|export)\s+(it|this|them|the file|as)\b", re.I
)

#: External systems whose "I did it" is checkable: a tool either ran or it did not.
_ACTION = re.compile(
    r"\b(?:"
    r"i(?:'ve| have)?\s+(?:sent|posted|created|filed|opened|raised|dispatched|"
    r"notified|messaged|uploaded|scheduled)"
    r"|(?:has|have)\s+been\s+(?:sent|posted|created|filed|dispatched|notified)"
    r")\b[^\n.]{0,60}?\b(slack|jira|teams|email|e-mail|webhook|ticket|issue|"
    r"channel|calendar|notion|github|gitlab|linear|asana)\b",
    re.I,
)
#: The answer already says it is a draft — no correction is owed.
_DRAFT = re.compile(
    r"\b(draft only|not sent|not actually sent|no message was sent|"
    r"draft\s*[—-]\s*not sent|i cannot send|i can't send|you can (?:then )?send)\b",
    re.I,
)
#: The answer already says the file was not produced.
_DISCLAIMED = re.compile(
    r"\b(not (?:been )?(?:generated|created|attached|produced)|"
    r"no file (?:was|has been) (?:generated|created|attached)|"
    r"could not (?:generate|create|attach))\b",
    re.I,
)


def _strip_code(text: str) -> str:
    return _INLINE_CODE.sub(" ", _FENCE.sub(" ", text))


def file_claims(text: str) -> list[str]:
    """Filenames the answer claims to have DELIVERED, or [] when it claims none."""
    body = _strip_code(text)
    names: list[str] = []
    for line in body.splitlines():
        if _PROPOSED.search(line):
            continue  # "save this as report.csv" proposes, never delivers
        hit = _DOWNLOAD_LINE.search(line)
        if hit is None and _DELIVERED.search(line):
            hit = _FILENAME.search(line)
        if hit is None:
            continue
        name = _FILENAME.search(hit.group(0)) or _FILENAME.search(line)
        if name:
            names.append(name.group(0).strip())
    # Order-preserving dedupe: the same file named twice is one claim.
    return list(dict.fromkeys(names))


def action_claims(text: str) -> list[str]:
    """External systems the answer claims to have ACTED on, or []."""
    body = _strip_code(text)
    # A draft marker ANYWHERE in the answer disarms this check: real answers put
    # "DRAFT ONLY — NOT SENT" on its own line above the draft, so testing line by
    # line missed exactly the honest case it was meant to protect.
    if _DRAFT.search(body):
        return []
    out: list[str] = []
    for line in body.splitlines():
        m = _ACTION.search(line)
        if m:
            out.append(m.group(m.lastindex or 0).lower())
    return list(dict.fromkeys(out))


def render_correction(
    final_text: str,
    *,
    artifacts: list[dict[str, str]],
    external_tool_succeeded: bool,
) -> str:
    """The system-authored correction, or "" when the answer was honest.

    `artifacts` is the writer's record of ARTIFACT events — the only thing that
    puts a real download in front of the user. `external_tool_succeeded` says
    whether ANY side-effecting tool completed this turn; a claim to have sent
    something when nothing ran is the case being caught.
    """
    parts: list[str] = []
    claimed_files = file_claims(final_text)
    if claimed_files and not artifacts and not _DISCLAIMED.search(final_text):
        listed = ", ".join(claimed_files[:5])
        parts.append(
            "**No file was generated.** This answer refers to "
            f"{listed} as if it were ready to download, but no file was produced "
            "in this turn — the text above is the whole deliverable. Ask for it as "
            "a file and it will be generated properly."
        )
    if not external_tool_succeeded:
        claimed_actions = action_claims(final_text)
        if claimed_actions:
            listed = ", ".join(sorted(claimed_actions)[:5])
            parts.append(
                f"**Nothing was sent.** This answer reads as if an action in "
                f"{listed} had been carried out. It was not — what is above is a "
                "DRAFT you can send yourself."
            )
    if not parts:
        return ""
    return "\n\n---\n\n" + "\n\n".join(parts)
