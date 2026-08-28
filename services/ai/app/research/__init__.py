"""Deep Research — an optional, durable, resumable skill (sibling to SEO + Blog).

Flag-gated by `ai_research_enabled`. OFF by default ⇒ neither the skill nor its
intents are registered and the runtime is byte-identical. The SEO and Blog skills
are separate and untouched; Deep Research reuses their shared read-only Ollagraph
tools via the registry, never their code.
"""
