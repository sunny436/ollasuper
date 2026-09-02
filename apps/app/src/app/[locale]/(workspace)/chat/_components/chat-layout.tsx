"use client";

import { AnimatePresence, LazyMotion, m } from "framer-motion";
import { useState } from "react";
import { AmbienceBackdrop } from "./ambience-backdrop";
import { EmptyHero } from "./empty-state";
import { ChatInput } from "./chat-input";
import { useChatSession } from "../_hooks/use-chat-session";

/**
 * The composer's home, and the centred -> bottom transition.
 *
 * WHY THE COMPOSER LIVES HERE AND NOT IN ChatPane
 * useSendMessage does router.replace(`/chat/${id}`) on the first send, and
 * /chat and /chat/[threadId] are different route segments — so the page
 * subtree unmounts and remounts. A framer-motion `layout` animation cannot
 * cross an unmount; it snaps. This component is rendered by ChatShell, which
 * chat/layout.tsx keeps mounted across thread navigations, so the composer
 * instance survives the URL change and the spring actually plays. (The repo
 * already knew this: use-composer.tsx avoids URL state because it "would
 * remount the transcript".)
 *
 * ONE CONTAINER, NEVER TWO
 * The composer is rendered in exactly one place in the tree in both states.
 * Moving it between two parents — even with layoutId — would unmount it, which
 * loses the draft, the caret position and any in-progress IME composition. So
 * the hero and the prompt cards animate OUT around it while it stays put, and
 * the container itself moves from centred to docked.
 *
 * LazyMotion + `m` rather than the `motion` barrel: chat-shell.tsx records that
 * framer-motion was deliberately kept off /chat ("~40kB gz for something CSS
 * composites for free") and / redirects here, so this is the landing route.
 * `domMax` is required — layout projection is not in `domAnimation`.
 */

/** Async so the feature bundle is not in the landing route first load. */
const loadMotionFeatures = () =>
  import("../_lib/motion-features").then((mod) => mod.default);

/** Supplied by the prototype; kept exactly. */
const CONTAINER_SPRING = { type: "spring", stiffness: 350, damping: 35 } as const;
const ITEM_SPRING = { type: "spring", stiffness: 350, damping: 30 } as const;

export function ChatLayout({ children }: { children: React.ReactNode }) {
  const { threadId, threadStatus } = useChatSession();

  // Centred only for a genuinely new conversation. A thread opened from the
  // rail mounts straight into the docked state — `layout` animates between
  // renders, not on first mount, so there is no fly-up on page load.
  const centred = threadId === null;
  // Explore raises this container above its own dim overlay and fades the
  // greeting. Held here because the greeting and the composer are siblings
  // below, and only their shared parent can order them against a portalled
  // overlay. Gated on `centred` at the point of use so it can never affect
  // the docked layout, where it would sit above the message list.
  const [exploreOpen, setExploreOpen] = useState(false);

  // A typo'd or foreign id: the pane renders "Conversation not found" and the
  // composer must not exist at all. use-send-message.ts casts
  // `tid as Id<"chatThreads">`, so sending would hand a bad string to a v.id()
  // validator — an ArgumentValidationError that the Convex client reports via
  // console.error, failing every e2e run. Offering a send button that cannot
  // work is also just a lie about what the UI does.
  const composerVisible = threadStatus !== "notfound";

  return (
    // `isolate` contains the backdrop's -z-10 so it stays behind this pane's
    // header/transcript but never slides under the workspace-level background.
    <div className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Landing-only ambient layer (glow orbs + starfield), behind the header
          glass. Unmounts on first send, when `centred` flips false. */}
      {centred && <AmbienceBackdrop />}
      {children}

      {composerVisible && (
        <LazyMotion features={loadMotionFeatures} strict>
          <m.div
            layout
            transition={CONTAINER_SPRING}
            className={
              centred
                ? // Overlays the (empty) transcript. inset-0 rather than a fixed
                  // width, so it tracks the rail collapsing without a resize
                  // listener.
                  //
                  // Centred with flex, NOT top-1/2 + -translate-y-1/2 as the
                  // prototype does: layout projection writes to the transform, so a
                  // CSS translate on the same element is fought over every frame
                  // and the spring lands in the wrong place.
                  `pointer-events-none absolute inset-0 ${
                    exploreOpen ? "z-40" : "z-20"
                  } flex items-center px-4 md:px-6`
                : "relative z-20 shrink-0"
            }
          >
            <div className={`pointer-events-auto mx-auto flex w-full flex-col items-center gap-5 ${centred ? "max-w-[58rem]" : "max-w-3xl"}`}>
              <AnimatePresence mode="popLayout">
                {centred && (
                  <m.div
                    key="hero"
                    layout
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -40, filter: "blur(12px)", scale: 0.95 }}
                    transition={ITEM_SPRING}
                    className={`w-full transition-opacity duration-300 ${
                      exploreOpen ? "opacity-30" : "opacity-100"
                    }`}
                  >
                    <EmptyHero />
                  </m.div>
                )}
              </AnimatePresence>

              {/*
                Not wrapped in AnimatePresence and never keyed on `centred`:
                this subtree must persist across the transition or the textarea
                remounts and the draft disappears mid-send.
              */}
              <m.div layout transition={ITEM_SPRING} className="w-full">
                <ChatInput onExploreOpenChange={setExploreOpen} />
              </m.div>

            </div>
          </m.div>
        </LazyMotion>
      )}
    </div>
  );
}
