import type { WebSubStatus } from "#platform/db/schemas/sources.ts";
import type { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import {
  type HubPoster,
  requestHubSubscription,
  type WebSubDiscovery,
} from "#features/feeds/websub.ts";
import { shouldAttemptWebSubSubscribe } from "#features/feeds/websub-lease-policy.ts";

export const webSubRenewalIntervalMs = 24 * 60 * 60_000;

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
    private readonly publicOrigin: URL | undefined,
  ) {}

  public wants(status: undefined | WebSubStatus): boolean {
    return (
      this.publicOrigin !== undefined && shouldAttemptWebSubSubscribe(status)
    );
  }

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
