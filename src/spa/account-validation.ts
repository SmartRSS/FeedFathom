import {
  isEmailAddress,
  maxEmailAddressLength,
} from "#shared/validation/address-shape.ts";

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
