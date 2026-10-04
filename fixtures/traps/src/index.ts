export { thing } from './barrel.js';
// Imported so the JSX file is reachable: the test is about parsing components,
// not about which files are orphans.
export { Button } from './component.js';
