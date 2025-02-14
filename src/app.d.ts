// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
import { type Dependencies } from "./container";
import { type User } from "./types/user.type";
import { type RequestEvent } from "@sveltejs/kit";

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      dependencies: Dependencies;
      user?: User;
    }

    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export type UnauthenticatedRequestEvent<T> = ValidatedRequestEvent<T> & {
  body: T;
  locals: Omit<App.Locals, "user">;
};

export type ValidatedRequestEvent<T> = RequestEvent & {
  body: T;
  locals: App.Locals & { user: User };
}
