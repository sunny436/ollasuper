# Bundled Marketing reference corpus — attribution

The markdown files in this directory are adapted **verbatim** from the open-source
**claude-skills** project's `marketing-skill/` specialist skills and are redistributed
here under that project's MIT licence:

> MIT License — Copyright (c) 2025 Alireza Rezvani
> https://github.com/alirezarezvani/claude-skills
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction … The above copyright notice and this permission notice shall be
> included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
> "AS IS", WITHOUT WARRANTY OF ANY KIND …

These are served read-only, on demand, by the `marketing_reference` tool
(`app/marketing/tool.py`) so the Marketing skill can consult the correct specialist
playbook (positioning, launch, CRO, paid/social/channel, AEO, growth, pricing, the 3
orchestration sequences, etc.) without inflating the system prompt. They are trusted
internal reference data (not user input). Only the MARKETING-owned specialists are
bundled — SEO and content-writing playbooks are intentionally NOT bundled because those
requests are delegated to OllaSuper's existing SEO and Blog capabilities.
