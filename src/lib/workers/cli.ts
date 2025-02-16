import { type UsersRepository } from "$lib/db/user-repository";
import { llog } from "../../util/log";

export class Cli {
  constructor(private readonly usersRepository: UsersRepository) {}

  async execute(command: string, argument: string[]) {
    switch (command) {
      case "make-admin": {
        const email = argument[0];
        if (!email) {
          throw new Error("No email provided");
        }

        await this.usersRepository.makeAdmin(email);
        llog(`User ${email} made admin`);
        break;
      }

      default:
        throw new Error("1");
    }
  }
}
