import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// RTL mounts into a shared document; unmount between tests so one test's DOM
// cannot leak into the next.
afterEach(() => {
  cleanup()
})

// jsdom 30 implements none of the three APIs below (verified against the
// installed version), and the chat components call all of them. Each stub is
// deterministic so a test asserts the intended branch rather than the absence
// of the API, and each is here because a named component reads it.

// Read by framer-motion's reduced-motion detection and by
// lib/use-media-query.ts. Reporting "reduce" is the branch task 11 asserts, and
// the safe default: motion off, content unchanged.
window.matchMedia = (query: string): MediaQueryList =>
  ({
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList

// The message list scrolls the newest answer into view while streaming (task 8's
// widget); jsdom's Element has no scrollIntoView at all.
Element.prototype.scrollIntoView = () => {}

// Radix's floating primitives (the citation chip tooltip in task 5, the drawer
// in task 9) measure with a ResizeObserver, which jsdom does not provide.
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub
