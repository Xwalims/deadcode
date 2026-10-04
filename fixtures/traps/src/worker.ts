// Loaded by the runtime through a string the analyser cannot see.
const modulePath = './feature.js';

export async function start(): Promise<void> {
  const mod = await import(/* @vite-ignore */ modulePath);
  console.log(mod);
}
