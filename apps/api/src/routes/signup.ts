import { Hono } from "hono";
import { sValidator } from "../http/validation/validator.ts";
import type { AuthVariables } from "../middleware/auth.ts";
import { signup as signupOp } from "../domains/auth/operations.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { SignupBody } from "../http/validation/identity.ts";
import { withParseApi } from "../http/validation/with-parse-api.ts";

export const signupBody = withParseApi(SignupBody);

export const signupRoutes = new Hono<{ Variables: AuthVariables }>();

signupRoutes.post(
  "/signup",
  sValidator("json", signupBody, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "validation_error",
          details: result.error.flatten().fieldErrors,
        },
        422,
      );
    }
  }),
  async (c) => {
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      signupOp({
        adminEmail: body.adminEmail,
        adminUsername: body.adminUsername,
        password: body.password,
      }),
      {
        operation: "signup",
        successStatus: 201,
      },
    );
  },
);

export default signupRoutes;
