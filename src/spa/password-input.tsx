import { createSignal, createUniqueId, Show } from "solid-js";

export function PasswordInput(props: {
  autocomplete: "current-password" | "new-password";
  invalidMessageId?: string | undefined;
  error?: string | undefined;
  label: string;
  onInput(value: string): void;
  value: string;
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
            value={props.value}
            onInput={(event) => props.onInput(event.currentTarget.value)}
            required
          />
        </label>
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
