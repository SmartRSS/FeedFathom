import { config } from "#platform/config.ts";
import { EmailHandler } from "./lib/email/email-handler.ts";
import { MailSender } from "./lib/email/mail-sender.ts";
import { FeedPreviewCache } from "./lib/feed-preview-cache.ts";
import { OpmlParser } from "./lib/opml-parser.ts";
import { waitForMigration } from "./db/connection.ts";
import { createFeedRuntime } from "./runtime.ts";
import { createServerApp } from "./server-app.ts";

const runtime = await createFeedRuntime();
const production = Bun.env.NODE_ENV === "production";

export const app = await createServerApp(
  {
    ...runtime,
    config,
    emailHandler: new EmailHandler(
      runtime.sourcesDataService,
      runtime.articlesDataService,
      runtime.userSourcesDataService,
    ),
    feedPreviewCache: new FeedPreviewCache(runtime.redis),
    fetcher: fetch,
    mailEnabled: config.MAIL_ENABLED,
    mailSender: new MailSender(config),
    opmlParser: new OpmlParser(),
    password: Bun.password,
  },
  { production },
);

// Unlike the worker, which reports healthy while it waits because nothing
// routes to it, the server must not accept traffic against a schema it was
// not built for -- that would answer requests with errors instead of making
// the orchestrator wait. So it does not listen at all until its migration is
// applied, and the healthcheck's start_period is what covers that gap. A
// migration slower than that budget leaves the server restarting until it
// finishes, which is noisy but self-correcting.
await waitForMigration(runtime.drizzleConnection.$client);

app.listen(config.PORT ?? 3000);

let shutdownPromise: Promise<void> | undefined;
const shutdown = () =>
  (shutdownPromise ??= Promise.resolve(app.stop())
    .then(() => runtime.close())
    .then(() => undefined));
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
