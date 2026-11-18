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

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  document.body.innerHTML = "";
});
