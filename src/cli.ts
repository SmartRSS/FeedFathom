#!/usr/bin/env bun
import container from "./container";

const userService = container.resolve("userService");

const email = process.argv[2]; // Get the email from command line arguments

if (!email) {
    console.error("Please provide an email address.");
    process.exit(1);
}

async function makeAdmin(email: string) {
    try {
        const user = await userService.findUserByEmail(email);
        if (!user) {
            console.error(`User with email ${email} does not exist.`);
            process.exit(1);
        }

        await userService.makeAdmin(user.id);
        console.log(`User with email ${email} has been made an admin.`);
    } catch (error) {
        console.error("An error occurred:", error);
        process.exit(1);
    }
}

makeAdmin(email);
