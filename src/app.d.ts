// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
import type { Dependencies } from "./container.ts";
import type { User } from "./types/user-type.ts";

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
