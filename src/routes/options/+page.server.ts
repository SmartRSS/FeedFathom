import { type Actions, json, error } from "@sveltejs/kit";
import { isPlainText } from "../../util/is-plain-text";
import { err } from "../../util/log";
import type { PageServerLoad } from "../$types";

export const actions: Actions = {
  importOpml: async ({ request, locals }) => {
    if (!locals.user) {
      return {
        success: false,
        status: 400,
        error: "",
      };
    }
    try {
      const formData = Object.fromEntries(await request.formData());
      if ("opml"! in formData) {
        return {
          success: false,
          status: 400,
          error: "No file uploaded",
        };
      }
      const opml = formData["opml"] as unknown as File;

      if (!opml.name || opml.name === "undefined") {
        return {
          success: false,
          status: 400,
          error: "No file uploaded",
        };
      }

      const content = await opml.text();
      if (!isPlainText(content)) {
        return {
          success: false,
          status: 400,
          error: "Invalid file",
        };
      }

      const tree = await locals.dependencies.opmlParser.parseOpml(content);
      await locals.dependencies.userSourcesRepository.insertTree(
        locals.user.id,
        tree,
      );

      return { success: true };
    } catch (e) {
      err("import failed", e);
      return json(e, { status: 500 });
    }
  },
  changePassword: async ({ request, locals }) => {
    if (!locals.user) {
      return {
        success: false,
        status: 400,
        error: "",
      };
    }
    try {
      const formData = await request.formData();
      const oldPassword = formData.get("oldPassword");
      const password1 = formData.get("password1");
      const password2 = formData.get("password2");
      if (!password1 || !password2 || password1 !== password2 || !oldPassword) {
        return {
          success: false,
        };
      }
      if (typeof oldPassword !== "string") {
        return {
          success: false,
        };
      }
      if (typeof password1 !== "string") {
        return {
          success: false,
        };
      }
      const user = await locals.dependencies.usersRepository.findUser(
        locals.user.email,
      );
      if (!user) {
        return {
          success: false,
        };
      }
      if (!(await Bun.password.verify(oldPassword, user.password))) {
        return {
          success: false,
        };
      }
      const newHash = await Bun.password.hash(password1);
      await locals.dependencies.usersRepository.updatePassword(
        user.id,
        newHash,
      );

      return { success: true };
    } catch (e) {
      err("import failed", e);
      return json(e, { status: 500 });
    }
  },
};

export const load: PageServerLoad = ({ locals }) => {
  const user = locals.user; // Assuming user info is stored in locals

  if (!user) {
    throw error(401, "Unauthorized");
  }

  return {
    user,
  };
};
