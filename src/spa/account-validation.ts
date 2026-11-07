import {
  isEmailAddress,
  maxEmailAddressLength,
} from "#shared/validation/address-shape.ts";

// One set of rules for every account form, checked before anything is
// sent, so login, registration and both password-reset steps report a
// missing or malformed field the same way: in a sentence under the field.
// The forms turn the browser's own validation off (novalidate), whose
// bubbles spoke in a different voice and stopped the app's own messages.
export type AccountField = "confirm" | "email" | "password" | "username";

const missing: Record<AccountField, string> = {
  confirm: "Enter the password again.",
  email: "Enter your email address.",
  password: "Enter a password.",
  username: "Enter a name.",
};

export function accountFieldErrors(
  values: Partial<Record<AccountField, string>>,
): Partial<Record<AccountField, string>> {
  const errors: Partial<Record<AccountField, string>> = {};
  for (const field of ["username", "email", "password", "confirm"] as const) {
    const value = values[field];
    if (value === undefined) continue;
    // Passwords are taken as typed; a name or address of spaces is empty.
    const given =
      field === "password" || field === "confirm" ? value : value.trim();
    if (!given) errors[field] = missing[field];
    else if (field === "email" && !isEmailAddress(given))
      errors[field] = "Enter an email address like name@example.com.";
    else if (field === "email" && given.length > maxEmailAddressLength)
      errors[field] =
        `Enter an email address of at most ${maxEmailAddressLength} characters.`;
  }
  if (
    !errors.password &&
    !errors.confirm &&
    values.confirm !== undefined &&
    values.password !== values.confirm
  )
    errors.confirm = "The passwords don't match.";
  return errors;
}
