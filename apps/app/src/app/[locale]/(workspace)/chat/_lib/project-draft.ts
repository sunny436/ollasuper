/**
 * The one-shot handoff key for a message typed on a Project page.
 *
 * The Project page has a composer-shaped input, but the REAL composer lives
 * above the chat route segment and owns sending. So the Project page stores what
 * was typed here, navigates to /chat?project=<id>, and ChatPane hands it to the
 * composer and clears the key.
 *
 * sessionStorage rather than a query param: a first message can be long, and
 * neither the address bar nor browser history is a reasonable place for it. Read
 * exactly once, so a later plain visit to /chat never resurrects a stale draft.
 */
export const PROJECT_DRAFT_KEY = "olla:project-draft";
