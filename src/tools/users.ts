import { formatCortexData } from "../safety.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CortexClient } from "../client.js";

export function registerUserTools(
  server: McpServer,
  client: CortexClient,
): void {
  server.tool(
    "cortex_list_users",
    "List all users across organizations (requires superadmin API key via CORTEX_SUPERADMIN_KEY)",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async () => {
      try {
        if (!client.superadminAvailable) {
          return {
            content: [
              {
                type: "text" as const,
                text: "User listing across organizations requires CORTEX_SUPERADMIN_KEY environment variable to be set.",
              },
            ],
            isError: true,
          };
        }

        const users = await client.listUsers();
        const summary = users.map((u) => ({
          id: u.id,
          name: u.name,
          organization: u.organization,
          roles: u.roles,
          status: u.status,
          hasKey: u.hasKey,
          hasPassword: u.hasPassword,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(summary),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error listing users: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_get_user",
    "Get details about a specific user (requires superadmin API key)",
    {
      userId: z.string().max(65_536).describe("The user login/ID"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ userId }) => {
      try {
        if (!client.superadminAvailable) {
          return {
            content: [
              {
                type: "text" as const,
                text: "User management requires CORTEX_SUPERADMIN_KEY environment variable to be set.",
              },
            ],
            isError: true,
          };
        }

        const user = await client.getUser(userId);
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(user),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error getting user: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_create_user",
    "Create a new user in an organization (requires superadmin API key)",
    {
      login: z.string().max(65_536).describe("User login (used as ID)"),
      name: z.string().max(65_536).describe("User display name"),
      organization: z.string().max(65_536).describe("Organization to assign the user to"),
      roles: z
        .array(z.string().max(65_536)).max(500)
        .describe(
          'User roles: "read", "analyze", "orgadmin", or "superadmin"',
        ),
      confirm: z.boolean().default(false).describe("Explicit confirmation required to create a user with roles"),
      password: z.string().max(65_536).optional().describe("Optional initial password"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ login, name, organization, roles, password, confirm }) => {
      try {
        if (!client.superadminAvailable) {
          return {
            content: [
              {
                type: "text" as const,
                text: "User creation requires CORTEX_SUPERADMIN_KEY environment variable to be set.",
              },
            ],
            isError: true,
          };
        }

        if (!confirm) throw new Error("User creation requires confirm=true");

        const user = await client.createUser({
          login,
          name,
          roles,
          organization,
          password,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(
                {
                  id: user.id,
                  name: user.name,
                  organization: user.organization,
                  roles: user.roles,
                  status: user.status,
                  message: `User "${user.name}" (${user.id}) created in org "${user.organization}".`,
                },
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error creating user: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_renew_user_key",
    "Generate a new API key for a user (invalidates the previous key). Requires superadmin API key, confirm=true and an operator-configured credential store. Returns a receipt only.",
    {
      userId: z.string().max(65_536).describe("The user login/ID to renew the key for"),
      confirm: z.boolean().default(false).describe("Explicit confirmation required for key rotation"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ userId, confirm }) => {
      try {
        if (!client.superadminAvailable) {
          return {
            content: [
              {
                type: "text" as const,
                text: "User key management requires CORTEX_SUPERADMIN_KEY environment variable to be set.",
              },
            ],
            isError: true,
          };
        }

        if (!confirm) throw new Error("Key rotation requires confirm=true");
        const receipt = await client.renewUserKey(userId);
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(
                {
                  userId,
                  ...receipt,
                  message: `New API key generated for user "${userId}". The previous key is now invalid.`,
                },
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error renewing user key: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

}
