// Vite's `?raw` suffix imports a module's source as a string. Used by
// test/shared-drift.test.ts to hash the shared core without needing filesystem
// access (context-keeper-remote's suite runs inside workerd, which has none).
declare module "*?raw" {
  const source: string;
  export default source;
}
