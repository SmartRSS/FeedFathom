import type { UserRepository } from "$lib/db/user-repository";

export class Cli {
  constructor(private readonly usersRepository: UserRepository) {}

  async execute(command: string, arg: string[]) {
    switch (command) {
      case "make-admin": {
        const email = arg[0];
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
