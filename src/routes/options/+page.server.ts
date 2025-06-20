import { type Actions, error, json } from "@sveltejs/kit";
import { isPlainText } from "../../util/is-plain-text.ts";
import { logError as error_ } from "../../util/log.ts";

export const actions: Actions = {
  changePassword: async ({
    locals,
    request,
  }: {
    locals: App.Locals;
    request: Request;
  }) => {
    if (!locals.user) {
      return {
        error: "",
        status: 400,
        success: false,
      };
    }

    try {
      const formData = await request.formData();
      const oldPassword = formData.get("oldPassword");
      const password1 = formData.get("password1");
      const password2 = formData.get("password2");
      if (
        !(password1 && password2) ||
        password1 !== password2 ||
        !oldPassword
      ) {
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

      const user = await locals.dependencies.usersDataService.findUser(
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
      await locals.dependencies.usersDataService.updatePassword(
        user.id,
        newHash,
      );

      return { success: true };
    } catch (error__) {
      error_("import failed", error__);
      return json(error__, { status: 500 });
    }
  },
  importOpml: async ({ locals, request }) => {
    if (!locals.user) {
      return {
        error: "",
        status: 400,
        success: false,
      };
    }

    try {
      const formData = Object.fromEntries(await request.formData());
      if (!("opml" in formData)) {
        return {
          error: "No file uploaded",
          status: 400,
          success: false,
        };
      }

      const opml = formData["opml"] as unknown as File;

      if (!opml.name || opml.name === "undefined") {
        return {
          error: "No file uploaded",
          status: 400,
          success: false,
        };
      }

      const content = await opml.text();
      if (!isPlainText(content)) {
        return {
          error: "Invalid file",
          status: 400,
          success: false,
        };
      }

      const tree = await locals.dependencies.opmlParser.parseOpml(content);
      await locals.dependencies.userSourcesDataService.insertTree(
        locals.user.id,
        tree,
      );

      return { success: true };
    } catch (error__) {
      error_("import failed", error__);
      return json(error__, { status: 500 });
    }
  },
};

export const load = ({ locals }: { locals: App.Locals }) => {
  const user = locals.user;

  if (!user) {
    throw error(401, "Unauthorized");
  }

  return {
    user,
  };
};
