import type { WebSubStatus } from "#platform/db/schemas/sources.ts";
import type { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import {
  type HubPoster,
  requestHubSubscription,
  type WebSubDiscovery,
} from "#features/feeds/websub.ts";
import { shouldAttemptWebSubSubscribe } from "#features/feeds/websub-lease-policy.ts";

// How often the renewal job runs. The renewal query takes every lease that
// expires before the next run.
export const webSubRenewalIntervalMs = 24 * 60 * 60_000;

/**
 * Asks hubs to push a source's updates to this instance, first on discovery
 * and then again before each lease runs out. A refused or unreachable hub
 * marks the subscription failed, which sends the source back to ordinary
 * polling.
 */
export class WebSubSubscriber {
  constructor(
    private readonly websubStateService: Pick<
      WebSubStateService,
      | "claimWebSubSubscribeAttempt"
      | "getWebSubSubscriptionsNeedingRenewal"
      | "markWebSubFailed"
      | "recordWebSubDiscovery"
    >,
    private readonly hubPoster: HubPoster,
    // Undefined turns WebSub off: without a public origin there is no
    // callback URL a hub could reach.
    private readonly publicOrigin: URL | undefined,
  ) {}

  /** Whether a fetch of a source in this state should look for a hub. */
  public wants(status: undefined | WebSubStatus): boolean {
    return (
      this.publicOrigin !== undefined && shouldAttemptWebSubSubscribe(status)
    );
  }

  /**
   * Subscribes to the hub a fetch discovered. Hub failures are recorded on
   * the source rather than thrown: an unreachable hub says nothing about the
   * feed's health, so it must not fail the fetch that found it.
   */
  public async subscribe(sourceId: number, discovery: WebSubDiscovery) {
    const publicOrigin = this.publicOrigin;
    if (!publicOrigin) return;
    try {
      if (
        !(await this.websubStateService.claimWebSubSubscribeAttempt(sourceId))
      )
        return;
      const lease = await this.websubStateService.recordWebSubDiscovery(
        sourceId,
        discovery.hubUrl,
        discovery.topicUrl,
      );
      await this.request(publicOrigin, {
        id: sourceId,
        ...lease,
        ...discovery,
      });
    } catch (error) {
      console.error(`WebSub subscribe threw for source ${sourceId}:`, error);
      await this.websubStateService.markWebSubFailed(sourceId);
    }
  }

  /** Renews every verified subscription whose lease ends before the next run. */
  public async renewDue() {
    const publicOrigin = this.publicOrigin;
    if (!publicOrigin) return;
    const subscriptions =
      await this.websubStateService.getWebSubSubscriptionsNeedingRenewal();
    await Promise.all(
      subscriptions.map(
        async (subscription) => await this.request(publicOrigin, subscription),
      ),
    );
  }

  private async request(
    publicOrigin: URL,
    subscription: {
      callbackToken: string;
      hubUrl: string;
      id: number;
      secret: string;
      topicUrl: string;
    },
  ) {
    const result = await requestHubSubscription({
      ...subscription,
      hubPoster: this.hubPoster,
      publicOrigin,
    });
    if (result.ok) return;
    console.error(
      `WebSub subscribe failed for source ${subscription.id}: ${result.error}`,
    );
    await this.websubStateService.markWebSubFailed(subscription.id);
  }
}
