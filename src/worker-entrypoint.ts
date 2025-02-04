#!/usr/bin/env bun
import container from "./container";

if (process.argv[2] === "cli") {
    const command = process.argv[3];
    if (command !== 'make-admin') {
        process.exit(1);
    }
    const email = process.argv[4]; // Get the email from command line arguments

    if (!email) {
        console.error("Please provide an email address.");
        process.exit(1);
    }

    try {
        await container.cradle.usersRepository.makeAdmin(email);
        console.log(`User with email ${email} has been made an admin.`);
    } catch (error) {
        console.error("An error occurred:", error);
        process.exit(1);
    }

    process.exit(0);
}


const initializer = container.resolve("initializer");

await initializer.initialize();
