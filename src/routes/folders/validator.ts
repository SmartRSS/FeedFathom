import { type } from "arktype";

export const DeleteFolder = type({
  removeFolderId: "number",
  "+": "reject",
});

export type DeleteFolder = typeof DeleteFolder.infer;
