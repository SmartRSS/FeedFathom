import { type UsersRepository } from "$lib/db/user-repository";

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
        console.log(`User ${email} made admin`);
        break;
      }

      default:
        process.exit(1);
    }
  }
}
