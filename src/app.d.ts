// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
import type { Dependencies } from "./container";
import type { RequestEvent } from "@sveltejs/kit";
import type { User } from "./types/user.type";

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      user?: User;
      dependencies: Dependencies;
    }

    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export interface ValidatedRequestEvent<T> extends RequestEvent {
  body: T;
  locals: Locals & { user: User };
}

export type UnauthenticatedRequestEvent = ValidatedRequestEvent & {
  locals: Omit<App.Locals, "user">;
};
