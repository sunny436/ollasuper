"use client";

import { AnimatePresence, LazyMotion, m } from "framer-motion";
import { useState } from "react";
import { EmptyHero } from "./empty-state";
import { ChatInput } from "./chat-input";
import { useChatSession } from "../_hooks/use-chat-session";
import { useMediaQuery } from "../_hooks/use-media-query";

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
/** The greeting's exit on send. Touch devices skip the animated blur: a filter
 *  interpolated every frame over the hero is exactly the live-blur cost the
 *  touch policy in packages/ui/src/globals.css removes. */
const HERO_EXIT = { opacity: 0, y: -40, filter: "blur(12px)", scale: 0.95 } as const;
const HERO_EXIT_TOUCH = { opacity: 0, y: -40, scale: 0.95 } as const;

export function ChatLayout({ children }: { children: React.ReactNode }) {
  const { threadId, threadStatus } = useChatSession();
  const coarsePointer = useMediaQuery("(pointer: coarse)");

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
    // The query container is what `max-w-content` (70cqw) measures: the
    // transcript and the composer both size from THIS pane, so they match.
    <div className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col [container-type:inline-size]">
      {children}

      {/*
        Explore's dim. INSIDE the isolated pane, deliberately: this element is
        `relative isolate`, so a body-level overlay would paint over the
        composer no matter what z-index the composer got. Here it is an
        ordinary sibling and z-30 vs the composer container's z-40 simply
        works. Radix portals the menu itself, which is above both.
      */}
      {centred && exploreOpen && (
        <div
          aria-hidden
          // A VEIL, not a blackout. This was `bg-background/40 backdrop-blur-[2px]`
          // and the glass sweep took the alpha off with the blur - which turned a
          // dim into an opaque white sheet that hid the transcript completely and
          // left the faded greeting floating on solid white at 2.09:1.
          //
          // A modal scrim is inherently translucent; that is what makes it a scrim
          // rather than a page. The design rule bans decorative glass, not the dim
          // that tells you a menu is in front. 70% compensates for the blur that is
          // not coming back.
          className="absolute inset-0 z-30 bg-background/70"
        />
      )}

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
                  //
                  // TOUCH: the composer sits at the foot of the screen, as it does
                  // once a thread exists — centred it left 201-283 px of dead space
                  // below it on a phone and put the one control you always reach for
                  // in the middle of the screen. `pointer: coarse` rather than a
                  // width breakpoint: a phone in landscape (844x390) is still a phone.
                  // The greeting keeps its position (my-auto below).
                  `pointer-events-none absolute inset-0 ${
                    exploreOpen ? "z-40" : "z-20"
                  } flex items-center px-4 md:px-6 [@media(pointer:coarse)]:items-stretch`
                : "relative z-20 shrink-0"
            }
          >
            <div
              // Filling the height on touch (below) makes this column cover the
              // header, and it carries pointer-events-auto — which swallowed taps
              // on Open conversations and Notifications (caught by
              // e2e/qa-responsive.js on every touch viewport). So on touch the
              // column is transparent to pointers and its two children take the
              // events back.
              className={`pointer-events-auto mx-auto flex w-full flex-col items-center gap-5 ${centred ? "max-w-[max(58rem,70cqw)] [@media(pointer:coarse)]:h-full [@media(pointer:coarse)]:pointer-events-none" : "max-w-content"}`}
            >
              <AnimatePresence mode="popLayout">
                {centred && (
                  <m.div
                    key="hero"
                    layout
                    initial={{ opacity: 0, y: 20 }}
                    // Driven through Framer, not a Tailwind opacity class:
                    // this element already animates opacity, so the inline
                    // style it writes wins over any class and the greeting
                    // stayed at full opacity on production.
                    // 0.45, not 0.3: the greeting is 36px, so WCAG asks 3:1 and
                    // 0.3 measured 2.09:1 against the veil. 0.45 is 3.36:1 and
                    // recedes just as clearly.
                    animate={{ opacity: exploreOpen ? 0.45 : 1, y: 0 }}
                    exit={coarsePointer ? HERO_EXIT_TOUCH : HERO_EXIT}
                    transition={ITEM_SPRING}
                    // my-auto: with the column filling the height on touch, this
                    // keeps the greeting exactly where it was while the composer
                    // moves to the bottom.
                    className="w-full [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:my-auto"
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
              <m.div
                layout
                transition={ITEM_SPRING}
                className="w-full [@media(pointer:coarse)]:pointer-events-auto"
              >
                <ChatInput onExploreOpenChange={setExploreOpen} />
              </m.div>

            </div>
          </m.div>
        </LazyMotion>
      )}
    </div>
  );
}
