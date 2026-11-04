import { createSignal, Show, type Accessor } from "solid-js";
import { sessionResponse } from "#shared/contracts/responses.ts";
import { api } from "./api.ts";

// Whether the signed-in account is an admin. Asked of the server the first
// time it is read -- when a failure's details could show -- and kept for the
// life of the view that made it, which a sign-out ends.
export function createAdminFlag(): Accessor<boolean> {
  const [admin, setAdmin] = createSignal(false);
  let asked = false;
  return () => {
    if (!asked) {
      asked = true;
      api("/session", sessionResponse).then(
        (session) => setAdmin(session.user?.isAdmin ?? false),
        () => {
          asked = false;
        },
      );
    }
    return admin();
  };
}

// What went wrong underneath a failure's plain sentence, for admins only:
// everyone else gets the sentence alone.
export function FailureDetails(props: {
  admin: boolean;
  reason: string;
  status: number | undefined;
}) {
  return (
    <Show when={props.admin}>
      <details class="failure-details">
        <summary>Details</summary>
        <p>
          {props.status ? `HTTP ${props.status}. ` : ""}
          {props.reason || "No reason was recorded."}
        </p>
      </details>
    </Show>
  );
}
