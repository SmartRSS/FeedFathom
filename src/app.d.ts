// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
import { type Dependencies } from "./container";
import { type User } from "./types/user-type";

declare global {
  namespace App {
    // interface Error {}
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Locals {
      dependencies: Dependencies;
      user?: User;
    }

    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}
