import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { llog } from "../../util/log.ts";

export class Cli {
  constructor(private readonly usersDataService: UsersDataService) {}

  async execute(command: string, argument: string[]) {
    switch (command) {
      case "make-admin": {
        const email = argument[0];
        if (!email) {
          throw new Error("No email provided");
        }

        await this.usersDataService.makeAdmin(email);
        llog(`User ${email} made admin`);
        break;
      }

      default:
        throw new Error("1");
    }
  }
}
