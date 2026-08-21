/**
 * The framer-motion feature bundle for the auth panel, in its own module so
 * LazyMotion can code-split it out of the login route's first-load JS.
 *
 * LazyMotion only defers if `features` is a LOADER (a dynamic import). Passing
 * the imported object directly pulls the whole bundle into the login chunk —
 * measured ~86kB raw there. Behind this it lands in an async chunk fetched after
 * first paint. `domMax`, not `domAnimation`: the active-tab notch uses a layout
 * animation (layoutId), which lives only in the larger projection bundle.
 */
export { domMax as default } from "framer-motion";
