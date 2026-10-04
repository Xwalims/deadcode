// A plugin registry: entries are consumed by a framework, not by an import.
type Plugin = { name: string; setup(): void };

const registry = new Map<string, Plugin>();

export function register(plugin: Plugin): void {
  registry.set(plugin.name, plugin);
}
