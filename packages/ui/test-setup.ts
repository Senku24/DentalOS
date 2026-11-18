import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
// Radix/cmdk use ResizeObserver and scrollIntoView, which happy-dom does not implement.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// biome-ignore lint/suspicious/noExplicitAny: test shims
(globalThis as any).ResizeObserver ??= RO;
Element.prototype.scrollIntoView ??= () => {};

// Load RTL here, at preload top level and after the DOM is registered (its `screen` binds to
// document.body on import). Importing it lazily inside a hook made RTL register its own
// beforeAll/afterAll mid-test, which fails whenever the first test file doesn't import RTL itself.
const { cleanup } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
