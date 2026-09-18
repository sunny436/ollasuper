import { ImageResponse } from "next/og";
import {
  OLLA_MARK_PATH,
  OLLA_MARK_VIEWBOX,
} from "@/components/branding/olla-super-logo";

/**
 * The social card for a shared conversation.
 *
 * Replaces `og:image: "/logo.png"` — a 1.6 MB raster of the previous mark. Built
 * from the same path data as everything else, so the brand cannot drift between
 * the app and its link previews.
 *
 * KNOWN LIMIT, stated rather than hidden: the wordmark here is NOT Poppins.
 * `ImageResponse` rasterises on the server and can only use fonts handed to it;
 * the app's Poppins is a next/font build artefact with no stable runtime path, so
 * bundling it would mean committing a .ttf. The in-app wordmark — the one the
 * brand spec is about — is Poppins; this card uses the renderer's built-in face.
 *
 * Deliberately carries no conversation content: shared pages are `noindex`, and
 * message text must never leak into a preview that platforms cache.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "OllaSuper";

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 40,
        background: "#FFFFFF",
      }}
    >
      <svg width="200" height="200" viewBox={OLLA_MARK_VIEWBOX}>
        <path fillRule="evenodd" d={OLLA_MARK_PATH} fill="#000000" />
      </svg>
      <div style={{ fontSize: 76, fontWeight: 700, color: "#000000" }}>
        OllaSuper
      </div>
    </div>,
    size,
  );
}
