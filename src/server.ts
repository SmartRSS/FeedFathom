import { config } from "./config.ts";
import { EmailHandler } from "./lib/email/email-handler.ts";
import { MailSender } from "./lib/email/mail-sender.ts";
import { FeedPreviewCache } from "./lib/feed-preview-cache.ts";
import { OpmlParser } from "./lib/opml-parser.ts";
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

app.listen(config.PORT ?? 3000);

let shutdownPromise: Promise<void> | undefined;
const shutdown = () =>
  (shutdownPromise ??= Promise.resolve(app.stop())
    .then(() => runtime.close())
    .then(() => undefined));
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
