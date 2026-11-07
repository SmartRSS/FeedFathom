import { createSignal, createUniqueId, Show } from "solid-js";

// A password field you cannot read back is the one input in the app where a
// typo is invisible until the server rejects it -- and on login that rejection
// costs one of a bounded number of attempts. The toggle sits beside the
// label rather than inside it: a <label> may not contain interactive content
// other than its own control, and a button there would also pick up the
// label's click-forwarding. An error shows under the field, which is marked
// invalid and described by it; invalidMessageId marks it invalid with a
// message shown elsewhere, such as a whole-form error.
export function PasswordInput(props: {
  autocomplete: "current-password" | "new-password";
  invalidMessageId?: string | undefined;
  error?: string | undefined;
  label: string;
  onInput(value: string): void;
  value?: string;
}) {
  const [shown, setShown] = createSignal(false);
  const id = createUniqueId();
  return (
    <>
      <div class="password-field">
        <label for={id}>
          {props.label}
          <input
            aria-describedby={
              props.error
                ? `${id}-error`
                : (props.invalidMessageId ?? undefined)
            }
            aria-invalid={
              props.error || props.invalidMessageId ? "true" : undefined
            }
            id={id}
            autocomplete={props.autocomplete}
            type={shown() ? "text" : "password"}
            value={props.value ?? ""}
            onInput={(event) => props.onInput(event.currentTarget.value)}
            required
          />
        </label>
        {/* Not a submit: a bare <button> in these forms is the submit button. */}
        <button type="button" onClick={() => setShown(!shown())}>
          <Show fallback="Show" when={shown()}>
            Hide
          </Show>
        </button>
      </div>
      <Show when={props.error}>
        {(message) => (
          <p class="field-error" id={`${id}-error`} role="alert">
            {message()}
          </p>
        )}
      </Show>
    </>
  );
}
