type GatewayEventListener<TEvent> = (event: TEvent) => void;
type GatewayEventSubscription = { readonly kind: "gateway-event-subscription" };

/** Subscription identity prevents old frames and disposers from reviving callbacks. */
export class GatewayEventListeners<TEvent> {
  private readonly listeners = new Map<GatewayEventListener<TEvent>, GatewayEventSubscription>();

  add(listener: GatewayEventListener<TEvent>): () => void {
    const subscription = this.listeners.get(listener) ?? { kind: "gateway-event-subscription" };
    this.listeners.set(listener, subscription);
    return () => {
      if (this.listeners.get(listener) === subscription) {
        this.listeners.delete(listener);
      }
    };
  }

  snapshot(): Array<[GatewayEventListener<TEvent>, GatewayEventSubscription]> {
    return [...this.listeners];
  }

  isCurrent(
    listener: GatewayEventListener<TEvent>,
    subscription: GatewayEventSubscription,
  ): boolean {
    return this.listeners.get(listener) === subscription;
  }
}
