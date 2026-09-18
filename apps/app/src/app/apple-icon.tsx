import { ImageResponse } from "next/og";
import {
  OLLA_MARK_PATH,
  OLLA_MARK_VIEWBOX,
} from "@/components/branding/olla-super-logo";

/**
 * The iOS home-screen icon, generated from the SAME geometry as the component
 * and `icon.svg` — so there is still no raster brand asset in the repo.
 *
 * Opaque white ground on purpose: iOS composites the icon onto its own square and
 * ignores transparency, so a transparent PNG would come out with whatever iOS
 * chooses behind it. A solid ground is the only way to control that, and white
 * with a black mark is the light half of the system.
 *
 * `next/og` is part of Next, not a dependency.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#FFFFFF",
      }}
    >
      <svg width="128" height="128" viewBox={OLLA_MARK_VIEWBOX}>
        <path fillRule="evenodd" d={OLLA_MARK_PATH} fill="#000000" />
      </svg>
    </div>,
    size,
  );
}
