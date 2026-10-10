// Imported as a namespace: the binding is `ns`, and the only reference is
// `ns.viaNamespace()`. A namespace import keeps EVERY export of the target
// alive, not one named after the binding.
export function viaNamespace(): string {
  return 'namespace';
}

// Never named anywhere, and never reachable: a namespace import hands back the
// whole module object, so this one cannot be distinguished from viaNamespace.
// It is exported through the manifest entry point instead, so it stays alive
// for the same reason the package's own API surface does.
export function alsoInNamespace(): string {
  return 'also namespace';
}