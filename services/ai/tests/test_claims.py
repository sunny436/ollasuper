"""Claims about files and external actions — the "📄 Download: plan.pdf" defect.

The tested failure (17-09-2026): answers across Operations, Coding and Content
presented a text label as a deliverable, with no file-generation call behind it,
and drafted external actions in language that read as though they had been
carried out. The correction is computed from recorded state — ARTIFACT events and
side-effecting executions — so no wording in the answer can suppress it.

The second half of this file is the one that matters for safety: a correction
appended to an HONEST answer would be worse than the defect, so the false-positive
cases are tested as carefully as the true ones.
"""

from __future__ import annotations

from app.runtime.claims import action_claims, file_claims, render_correction

ARTIFACT = [{"id": "k17abc", "filename": "plan.pdf"}]


def correction(text: str, *, artifacts=None, external=False) -> str:
    return render_correction(
        text, artifacts=artifacts or [], external_tool_succeeded=external
    )


# --------------------------------------------------------------- the defect
def test_download_line_without_a_file_is_corrected():
    out = correction("Here is the plan.\n\n📄 Download: plan.pdf")
    assert "No file was generated" in out
    assert "plan.pdf" in out


def test_attached_claim_without_a_file_is_corrected():
    assert "No file was generated" in correction(
        "I've attached the full runbook as runbook.docx for your team."
    )


def test_passive_generated_claim_is_corrected():
    assert "No file was generated" in correction(
        "The report has been generated as q3-report.xlsx."
    )


def test_a_real_artifact_means_no_correction():
    assert correction("📄 Download: plan.pdf", artifacts=ARTIFACT) == ""


def test_an_answer_that_admits_the_file_is_missing_is_left_alone():
    assert (
        correction(
            "No file was generated — I could not create plan.pdf, so the content "
            "is inline above."
        )
        == ""
    )


# --------------------------------------------------------- external actions
def test_claiming_a_slack_send_without_a_tool_is_corrected():
    out = correction("I've sent the update to the #ops Slack channel.")
    assert "Nothing was sent" in out
    assert "slack" in out


def test_claiming_a_jira_ticket_without_a_tool_is_corrected():
    assert "Nothing was sent" in correction(
        "I have created the Jira ticket for the outage."
    )


def test_a_successful_tool_means_no_action_correction():
    assert (
        correction("I've sent the update to Slack.", external=True) == ""
    )


def test_an_answer_labelled_draft_is_left_alone():
    assert (
        correction(
            "DRAFT ONLY — NOT SENT\nI have created the Jira ticket text below."
        )
        == ""
    )


# ------------------------------------------------------- false-positive guards
def test_an_instruction_to_save_a_file_is_not_a_claim():
    assert correction("Save this as notes.csv and import it into the tool.") == ""


def test_discussing_a_users_attachment_is_not_a_claim():
    assert (
        correction("Your attached invoice.pdf lists five line items; two differ.")
        == ""
    )


def test_a_filename_inside_a_code_block_is_not_a_claim():
    assert (
        correction(
            "Run it like this:\n\n```bash\nweasyprint in.html report.pdf\n"
            "# Download: report.pdf\n```\n"
        )
        == ""
    )


def test_inline_code_filename_is_not_a_claim():
    assert correction("Write the output to `summary.pdf` when you are ready.") == ""


def test_plain_prose_without_a_filename_is_not_a_claim():
    assert correction("I've created a plan for the migration, set out below.") == ""


def test_talking_about_sending_later_is_not_an_action_claim():
    assert (
        correction("You can then send this to Slack once legal has signed off.")
        == ""
    )


# ------------------------------------------------------------------ helpers
def test_file_claims_dedupes_and_keeps_order():
    assert file_claims(
        "I've attached plan.pdf.\nDownload: plan.pdf\nI've generated notes.docx"
    ) == ["plan.pdf", "notes.docx"]


def test_action_claims_names_the_system():
    assert action_claims("I have posted the summary to the Teams channel") == ["teams"]


def test_both_corrections_can_appear_together():
    out = correction("📄 Download: plan.pdf\nI've sent it to Slack as well.")
    assert "No file was generated" in out
    assert "Nothing was sent" in out
