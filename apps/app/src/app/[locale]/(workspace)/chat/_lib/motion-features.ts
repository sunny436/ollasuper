/**
 * The framer-motion feature bundle, in its own module so it can be code-split.
 *
 * LazyMotion only defers anything if `features` is a LOADER. Passing the
 * imported `domMax` object directly still pulls the whole bundle into the
 * importing chunk — measured: /chat First Load JS went 303kB -> 350kB that
 * way, against a ~15kB budget. Behind this dynamic import it lands in an async
 * chunk fetched after first paint instead.
 *
 * `domMax`, not `domAnimation`: layout projection (the centred -> bottom
 * spring) is not in the smaller bundle.
 */
export { domMax as default } from "framer-motion";
