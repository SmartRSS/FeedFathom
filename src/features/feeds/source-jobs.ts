import type { HttpClient } from "#platform/http/http-client.ts";
import type { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { checked } from "#platform/worker-requests.ts";
import type { WorkerJobHandler, WorkerJobs } from "#platform/worker-jobs.ts";
import { pollFloorMs } from "#features/feeds/source-schedule-policy.ts";

enum SourceJobName {
  Refresh = "REFRESH_SOURCES",
  RequestWebSubDiscovery = "REQUEST_WEBSUB_DISCOVERY",
  WebSubPush = "WEBSUB_PUSH",
}

const pushedBodyFreshMs = pollFloorMs;

const exact = { additionalProperties: false } as const;
const sourceId = Type.Integer({ minimum: 1 });

const refreshJobCheck = Schema.Compile(
  Type.Object({ ids: Type.Array(sourceId) }, exact),
);
const discoveryJobCheck = Schema.Compile(Type.Object({ id: sourceId }, exact));
const pushJobCheck = Schema.Compile(
  Type.Object(
    {
      body: Type.String(),
      headers: Type.Array(Type.Tuple([Type.String(), Type.String()])),
      id: sourceId,
      url: Type.String(),
    },
    exact,
  ),
);

export class SourceJobs {
  constructor(private readonly workerJobs: Pick<WorkerJobs, "add">) {}

  async refresh(ids: readonly number[]) {
    if (!ids.length) return;
    await this.workerJobs.add(SourceJobName.Refresh, { ids });
  }

  async discoverWebSub(id: number) {
    await this.workerJobs.add(SourceJobName.RequestWebSubDiscovery, { id });
  }

  async push(
    source: { id: number; url: string },
    body: Buffer,
    headers: Headers,
  ) {
    await this.workerJobs.add(SourceJobName.WebSubPush, {
      body: body.toString("base64"),
      headers: [...headers],
      id: source.id,
      url: source.url,
    });
  }
}

export type SourceJobHandlerServices = {
  httpClient: Pick<HttpClient, "seedCache">;
  sourceEnqueuer: Pick<
    SourceEnqueuer,
    "enqueueSource" | "enqueueWebSubDiscovery"
  >;
};

export function createSourceJobHandlers({
  httpClient,
  sourceEnqueuer,
}: SourceJobHandlerServices): [string, WorkerJobHandler][] {
  const refresh = async (data: unknown) => {
    const { ids } = checked(refreshJobCheck, data, "refresh job");
    await Promise.all(ids.map((id) => sourceEnqueuer.enqueueSource({ id })));
  };

  const requestWebSubDiscovery = async (data: unknown) => {
    const { id } = checked(discoveryJobCheck, data, "discovery job");
    await sourceEnqueuer.enqueueWebSubDiscovery(id);
  };

  const push = async (data: unknown) => {
    const { body, headers, id, url } = checked(
      pushJobCheck,
      data,
      "WebSub push job",
    );
    const pushed = Buffer.from(body, "base64");
    let seeded = false;
    if (pushed.byteLength > 0) {
      try {
        await httpClient.seedCache(
          url,
          pushed,
          new Headers(headers),
          pushedBodyFreshMs,
        );
        seeded = true;
      } catch (error) {
        console.error(`WebSub push seed failed for ${url}:`, error);
      }
    }
    await sourceEnqueuer.enqueueSource({ id }, "websub-push", !seeded);
  };

  return [
    [SourceJobName.Refresh, refresh],
    [SourceJobName.RequestWebSubDiscovery, requestWebSubDiscovery],
    [SourceJobName.WebSubPush, push],
  ];
}
