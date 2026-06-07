declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface OpenClawToolRegistrationContext {
    sandboxed?: boolean;
    workspaceDir: string;
  }

  export interface OpenClawToolRegistrationOptions {
    name: string;
    optional?: boolean;
  }

  export interface OpenClawLogger {
    info(message: string): void;
    warn(message: string): void;
  }

  export interface OpenClawPluginApi {
    pluginConfig?: unknown;
    logger: OpenClawLogger;
    registerTool(
      factory: (ctx: OpenClawToolRegistrationContext) => unknown,
      options: OpenClawToolRegistrationOptions,
    ): void;
  }

  export interface OpenClawPluginEntry {
    id: string;
    name: string;
    description?: string;
    register(api: OpenClawPluginApi): void | Promise<void>;
  }

  export function definePluginEntry(entry: OpenClawPluginEntry): OpenClawPluginEntry;
}
