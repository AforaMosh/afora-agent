/** Ref callback that marks single-line text only while it is genuinely clipped. */
export function createOverflowFadeRef() {
  let target: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;

  const sync = () => {
    if (!target) {
      return;
    }
    const content = target.querySelector<HTMLElement>(
      ".sidebar-recent-session__name-content, .sidebar-agent-card__name-content",
    );
    const contentWidth = content?.scrollWidth ?? target.scrollWidth;
    const restingWidth = content?.classList.contains("sidebar-agent-card__name-content")
      ? content.clientWidth
      : target.clientWidth;
    target.toggleAttribute("data-overflow-fade", contentWidth > restingWidth + 1);
  };

  return (element?: Element) => {
    const next = element instanceof HTMLElement ? element : null;
    if (next === target) {
      sync();
      return;
    }
    observer?.disconnect();
    target = next;
    observer = null;
    if (!target) {
      return;
    }
    sync();
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(sync);
      observer.observe(target);
    }
    queueMicrotask(sync);
  };
}
