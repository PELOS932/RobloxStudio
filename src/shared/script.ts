import { z } from "zod";

export const ScriptSpecSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(["Script", "LocalScript", "ModuleScript"]).describe("Script = server, LocalScript = client"),
  parent: z
    .string()
    .max(200)
    .optional()
    .describe("dot path from game, e.g. ServerScriptService, StarterPlayer.StarterPlayerScripts, Workspace.Door. Default ServerScriptService"),
  source: z.string().max(200_000).describe("Luau source"),
  description: z.string().max(500).optional(),
});
export type ScriptSpec = z.infer<typeof ScriptSpecSchema>;
