# Bundled Finance reference corpus — attribution

The markdown files under this directory (`equity/`, `equity/sectors/`, `fpa/`, `saas/`)
are adapted **verbatim** from the open-source **claude-skills** project's `finance/`
subtree and are redistributed here under that project's MIT licence:

> MIT License — Copyright (c) 2025 Alireza Rezvani
> https://github.com/alirezarezvani/claude-skills
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction, including without limitation the rights to use, copy, modify,
> merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following
> conditions: The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
> INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
> PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
> HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
> THE USE OR OTHER DEALINGS IN THE SOFTWARE.

These files are served read-only, on demand, by the `finance_reference` tool
(`app/finance/tool.py`) so the Equity-Research skill can consult the source's
sector playbooks, forensic/IPO methodology, valuation guidance and scoring rubric
without inflating the system prompt. They are treated as trusted internal reference
data (not user input).
