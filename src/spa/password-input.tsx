import { createSignal, createUniqueId, Show } from "solid-js";

// A password field you cannot read back is the one input in the app where a
// typo is invisible until the server rejects it -- and on login that rejection
// now costs one of a bounded number of attempts. The toggle sits beside the
// label rather than inside it: a <label> may not contain interactive content
// other than its own control, and a button there would also pick up the
// label's click-forwarding.
export function PasswordInput(props: {
  autocomplete: "current-password" | "new-password";
  label: string;
  onInput(value: string): void;
  value?: string;
}) {
  const [shown, setShown] = createSignal(false);
  const id = createUniqueId();
  return (
    <div class="password-field">
      <label for={id}>
        {props.label}
        <input
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
  );
}
