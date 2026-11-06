import { expect, test } from "bun:test";
import { accountFieldErrors } from "../account-validation.ts";

test("names each missing field", () => {
  expect(
    accountFieldErrors({ confirm: "", email: " ", password: "", username: "" }),
  ).toEqual({
    confirm: "Enter the password again.",
    email: "Enter your email address.",
    password: "Enter a password.",
    username: "Enter a name.",
  });
});

test("checks the email's shape and the two passwords against each other", () => {
  expect(
    accountFieldErrors({ confirm: "b", email: "nobody", password: "a" }),
  ).toEqual({
    confirm: "The passwords don't match.",
    email: "Enter an email address like name@example.com.",
  });
});

test("passes complete, matching values and checks only the fields given", () => {
  expect(
    accountFieldErrors({
      confirm: " pw ",
      email: "a@example.com",
      password: " pw ",
      username: "Ann",
    }),
  ).toEqual({});
  expect(accountFieldErrors({ email: "a@example.com", password: "x" })).toEqual(
    {},
  );
});
